// ═══════════════════════════════════════════════════════════════════════
// Tom Certo — Phrase-Based Key Detector v5 (DEFINITIVO)
// ═══════════════════════════════════════════════════════════════════════

export const NOTE_NAMES_BR = ['Dó', 'Dó#', 'Ré', 'Ré#', 'Mi', 'Fá', 'Fá#', 'Sol', 'Sol#', 'Lá', 'Lá#', 'Si'];

import {
  TonicAnchor,
  createAnchor,
  ingestPhraseAnchor,
  alignmentScore,
  alignmentBoost,
  isDiatonicDegreeOf,
  requiredGravityMargin,
} from './tonicAnchor';

export const SILENCE_END_PHRASE_MS = 300;
export const LEGATO_SUSTAINED_MS = 1500;
export const MIN_NOTE_DUR_MS = 130;
export const MIN_PHRASE_DUR_MS = 700;
export const MIN_NOTES_PER_PHRASE = 3;
export const MIN_CADENCE_DUR_MS = 280;

export const VOTE_CADENCE = 7.0;
export const VOTE_FIRST_STABLE = 2.0;
export const VOTE_LONGEST = 1.0;

export const TALLY_DECAY = 0.93;
export const STAGE_PROBABLE_MIN_CONF = 0.35;
export const STAGE_CONFIRMED_MIN_CONF = 0.55;
export const STAGE_DEFINITIVE_MIN_CONF = 0.75;
export const STAGE_DEFINITIVE_MIN_QUALITY_MARGIN = 1.35;
export const STAGE_CONFIRMED_MIN_PHRASES = 3;
export const STAGE_DEFINITIVE_MIN_PHRASES = 4;

export const HYSTERESIS_BY_STAGE: Record<string, number> = {
  listening: 1.0,
  probable: 1.4,
  confirmed: 2.0,
  definitive: 2.5,
};

export const CONSECUTIVE_BONUS_PER_PHRASE = 0.15;
export const CONSECUTIVE_BONUS_CAP = 5;

export type DetectionStage = 'listening' | 'probable' | 'confirmed' | 'definitive';

export interface DetectedNoteEvent {
  pitchClass: number;
  midi: number;
  timestamp: number;
  durMs: number;
  rmsAvg: number;
}

export interface Phrase {
  notes: DetectedNoteEvent[];
  startMs: number;
  endMs: number;
  durMs: number;
  firstStablePc: number | null;
  lastSustainedPc: number | null;
  longestPc: number | null;
}

export interface KeyDetectionState {
  phrases: Phrase[];
  tonicTally: number[];
  noteDurHist: number[];
  currentTonicPc: number | null;
  tonicConfidence: number;
  quality: 'major' | 'minor' | null;
  qualityMargin: number;
  stage: DetectionStage;
  consecutiveAgreements: number;
  anchor: TonicAnchor;
}

export function createInitialState(): KeyDetectionState {
  return {
    phrases: [],
    tonicTally: new Array(12).fill(0),
    noteDurHist: new Array(12).fill(0),
    currentTonicPc: null,
    tonicConfidence: 0,
    quality: null,
    qualityMargin: 0,
    stage: 'listening',
    consecutiveAgreements: 0,
    anchor: createAnchor(),
  };
}

export function buildPhrase(notes: DetectedNoteEvent[]): Phrase | null {
  const valid = notes.filter(n => n.durMs >= MIN_NOTE_DUR_MS);
  if (valid.length < MIN_NOTES_PER_PHRASE) return null;

  const startMs = valid[0].timestamp;
  const lastN = valid[valid.length - 1];
  const endMs = lastN.timestamp + lastN.durMs;
  const durMs = endMs - startMs;
  if (durMs < MIN_PHRASE_DUR_MS) return null;

  let firstStablePc: number | null = null;
  for (const n of valid) {
    if (n.durMs >= 180) { firstStablePc = n.pitchClass; break; }
  }
  if (firstStablePc === null) firstStablePc = valid[0].pitchClass;

  let lastSustainedPc: number | null = null;
  for (let i = valid.length - 1; i >= 0; i--) {
    if (valid[i].durMs >= MIN_CADENCE_DUR_MS) {
      lastSustainedPc = valid[i].pitchClass;
      break;
    }
  }
  if (lastSustainedPc === null) lastSustainedPc = valid[valid.length - 1].pitchClass;

  let longestPc: number | null = null;
  let maxDur = 0;
  for (const n of valid) {
    if (n.durMs > maxDur) { maxDur = n.durMs; longestPc = n.pitchClass; }
  }

  return { notes: valid, startMs, endMs, durMs, firstStablePc, lastSustainedPc, longestPc };
}

function votesFromPhrase(phrase: Phrase): number[] {
  const votes = new Array(12).fill(0);
  if (phrase.lastSustainedPc !== null) votes[phrase.lastSustainedPc] += VOTE_CADENCE;
  if (phrase.firstStablePc !== null) votes[phrase.firstStablePc] += VOTE_FIRST_STABLE;
  if (phrase.longestPc !== null) votes[phrase.longestPc] += VOTE_LONGEST;
  return votes;
}

function updateNoteDurHist(hist: number[], phrase: Phrase): number[] {
  const out = hist.slice();
  for (const n of phrase.notes) {
    out[n.pitchClass] += n.durMs;
  }
  return out;
}

function determineQuality(
  phrases: Phrase[],
  noteDurHist: number[],
  tonicPc: number
): { quality: 'major' | 'minor'; margin: number } {
  const M3pc = (tonicPc + 4) % 12;
  const m3pc = (tonicPc + 3) % 12;

  let M3Weight = 0;
  let m3Weight = 0;

  for (const phrase of phrases) {
    for (const note of phrase.notes) {
      if (note.pitchClass !== M3pc && note.pitchClass !== m3pc) continue;
      let weight = 1;
      if (note.durMs >= 250) weight = 2;
      if (note.pitchClass === phrase.longestPc) weight = Math.max(weight, 2.5);
      if (note.pitchClass === phrase.lastSustainedPc) weight = Math.max(weight, 4);
      if (note.pitchClass === M3pc) M3Weight += weight;
      else m3Weight += weight;
    }
  }

  const total3rd = M3Weight + m3Weight;
  if (total3rd < 1) {
    const leadingTone = noteDurHist[(tonicPc + 11) % 12];
    const minorSeventh = noteDurHist[(tonicPc + 10) % 12];
    if (leadingTone > minorSeventh * 1.2) return { quality: 'major', margin: 1.5 };
    if (minorSeventh > leadingTone * 1.2) return { quality: 'minor', margin: 1.5 };
    return { quality: 'major', margin: 1.0 };
  }

  const majRatio = M3Weight / (m3Weight + 0.1);
  const minRatio = m3Weight / (M3Weight + 0.1);

  if (majRatio >= 1.25) return { quality: 'major', margin: majRatio };
  if (minRatio >= 1.25) return { quality: 'minor', margin: minRatio };
  return { quality: 'major', margin: 1.0 };
}

function determineStage(s: {
  phraseCount: number;
  tonicConfidence: number;
  qualityMargin: number;
  lastPhrasesAgree: boolean;
  lastThreePhrasesAgree: boolean;
}): DetectionStage {
  if (s.phraseCount === 0) return 'listening';
  if (s.phraseCount >= 1 && s.tonicConfidence >= STAGE_PROBABLE_MIN_CONF) {
    if (
      s.phraseCount >= STAGE_CONFIRMED_MIN_PHRASES &&
      s.tonicConfidence >= STAGE_CONFIRMED_MIN_CONF &&
      s.lastPhrasesAgree
    ) {
      if (
        s.phraseCount >= STAGE_DEFINITIVE_MIN_PHRASES &&
        s.tonicConfidence >= STAGE_DEFINITIVE_MIN_CONF &&
        s.lastThreePhrasesAgree &&
        s.qualityMargin >= STAGE_DEFINITIVE_MIN_QUALITY_MARGIN
      ) {
        return 'definitive';
      }
      return 'confirmed';
    }
    return 'probable';
  }
  return 'listening';
}

export function ingestPhrase(state: KeyDetectionState, phrase: Phrase): KeyDetectionState {
  const newAnchor = ingestPhraseAnchor(state.anchor, phrase);
  const decayed = state.tonicTally.map(v => v * TALLY_DECAY);
  const votes = votesFromPhrase(phrase);
  const newTally = decayed.map((v, i) => v + votes[i]);

  let consecutiveAgreements = state.consecutiveAgreements;
  if (
    state.currentTonicPc !== null &&
    phrase.lastSustainedPc === state.currentTonicPc
  ) {
    consecutiveAgreements += 1;
    const bonus = 1 + CONSECUTIVE_BONUS_PER_PHRASE * Math.min(consecutiveAgreements, CONSECUTIVE_BONUS_CAP);
    newTally[state.currentTonicPc] *= bonus;
  } else if (
    phrase.lastSustainedPc !== null &&
    state.currentTonicPc !== null &&
    phrase.lastSustainedPc !== state.currentTonicPc
  ) {
    consecutiveAgreements = 0;
  }

  const newDurHist = updateNoteDurHist(state.noteDurHist, phrase);
  const effectiveTally = newTally.map((w, pc) => w * alignmentBoost(pc, newAnchor));

  let topPc = 0;
  let topWeight = -Infinity;
  let secondWeight = 0;
  for (let pc = 0; pc < 12; pc++) {
    if (effectiveTally[pc] > topWeight) {
      secondWeight = topWeight > -Infinity ? topWeight : 0;
      topWeight = effectiveTally[pc];
      topPc = pc;
    } else if (effectiveTally[pc] > secondWeight) {
      secondWeight = effectiveTally[pc];
    }
  }

  const hysteresisFactor = HYSTERESIS_BY_STAGE[state.stage] ?? 1.0;
  if (
    state.currentTonicPc !== null &&
    state.stage !== 'listening' &&
    topPc !== state.currentTonicPc
  ) {
    const prevWeight = effectiveTally[state.currentTonicPc];
    if (topWeight < prevWeight * hysteresisFactor) {
      secondWeight = topWeight;
      topWeight = prevWeight;
      topPc = state.currentTonicPc;
    }
  }

  if (
    state.currentTonicPc !== null &&
    state.stage !== 'listening' &&
    topPc !== state.currentTonicPc &&
    isDiatonicDegreeOf(topPc, state.currentTonicPc, state.quality)
  ) {
    const margin = requiredGravityMargin(topPc, state.currentTonicPc, state.quality);
    const gravCandidate = newAnchor.gravity[topPc];
    const gravCurrent = newAnchor.gravity[state.currentTonicPc];
    if (gravCandidate < gravCurrent * margin) {
      topPc = state.currentTonicPc;
      topWeight = effectiveTally[state.currentTonicPc];
      secondWeight = 0;
      for (let pc = 0; pc < 12; pc++) {
        if (pc === topPc) continue;
        if (effectiveTally[pc] > secondWeight) secondWeight = effectiveTally[pc];
      }
    }
  }

  if (state.currentTonicPc !== null && topPc !== state.currentTonicPc) {
    consecutiveAgreements = phrase.lastSustainedPc === topPc ? 1 : 0;
  } else if (state.currentTonicPc === null && phrase.lastSustainedPc === topPc) {
    consecutiveAgreements = 1;
  }

  const marginRatio = topWeight > 0
    ? Math.min(1, (topWeight - secondWeight) / (topWeight + 0.5))
    : 0;
  const phraseBonus = Math.min(1, (state.phrases.length + 1) / 3);
  const consecBonus = Math.min(1, consecutiveAgreements / 3);
  const weightNorm = Math.min(1, topWeight / 15);
  const alignBonus = alignmentScore(topPc, newAnchor);

  const tonicConfidence =
    0.22 * phraseBonus +
    0.28 * marginRatio +
    0.28 * consecBonus +
    0.12 * weightNorm +
    0.10 * alignBonus;

  const newPhrases = [...state.phrases, phrase];
  const qr = determineQuality(newPhrases, newDurHist, topPc);

  const lastPhrasesAgree = (() => {
    if (newPhrases.length < 2) return false;
    const lp = newPhrases[newPhrases.length - 1];
    const pp = newPhrases[newPhrases.length - 2];
    return lp.lastSustainedPc === topPc && pp.lastSustainedPc === topPc;
  })();

  const lastThreePhrasesAgree = (() => {
    if (newPhrases.length < 3) return false;
    return (
      newPhrases[newPhrases.length - 1].lastSustainedPc === topPc &&
      newPhrases[newPhrases.length - 2].lastSustainedPc === topPc &&
      newPhrases[newPhrases.length - 3].lastSustainedPc === topPc
    );
  })();

  const stage = determineStage({
    phraseCount: newPhrases.length,
    tonicConfidence,
    qualityMargin: qr.margin,
    lastPhrasesAgree,
    lastThreePhrasesAgree,
  });

  return {
    phrases: newPhrases,
    tonicTally: newTally,
    noteDurHist: newDurHist,
    currentTonicPc: topPc,
    tonicConfidence,
    quality: stage === 'listening' ? null : qr.quality,
    qualityMargin: qr.margin,
    stage,
    consecutiveAgreements,
    anchor: newAnchor,
  };
}

export function keyName(root: number, quality: 'major' | 'minor'): string {
  return quality === 'major'
    ? `${NOTE_NAMES_BR[root]} Maior`
    : `${NOTE_NAMES_BR[root]} menor`;
}

export function harmonicFieldNames(root: number, quality: 'major' | 'minor'): string[] {
  const intervals = quality === 'major'
    ? [0, 2, 4, 5, 7, 9, 11]
    : [0, 2, 3, 5, 7, 8, 10];
  const qualities = quality === 'major'
    ? ['', 'm', 'm', '', '', 'm', '°']
    : ['m', '°', '', 'm', 'm', '', ''];
  return intervals.map((iv, i) => `${NOTE_NAMES_BR[(root + iv) % 12]}${qualities[i]}`);
}
