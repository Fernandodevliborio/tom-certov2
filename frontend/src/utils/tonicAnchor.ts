// ═══════════════════════════════════════════════════════════════════════
// tonicAnchor.ts — Âncora Global de Tônica (Gravidade Tonal)
// ═══════════════════════════════════════════════════════════════════════

import type { Phrase } from './phraseKeyDetector';

export const ANCHOR_DECAY = 0.98;
export const W_END_PHRASE = 8.0;
export const W_LONG_NOTE = 3.0;
export const W_DURATION_PER_MS = 0.003;
export const W_RECURRENCE = 1.5;
export const W_STABILITY = 2.0;

export const LONG_NOTE_MS = 400;
export const STABLE_NOTE_MIN_DUR_MS = 250;
export const STABLE_NOTE_MIN_RMS = 0.08;
export const RECURRENCE_MIN_PRIOR_WEIGHT = 1.5;

export const ALIGN_W_TONIC = 0.70;
export const ALIGN_W_FIFTH = 0.20;
export const ALIGN_W_FOURTH = 0.10;

export const MIN_GRAVITY_FOR_ALIGNMENT = 8.0;

export const DIATONIC_DEGREES_MAJOR = [2, 4, 5, 7, 9, 11];
export const DIATONIC_DEGREES_MINOR = [2, 3, 5, 7, 8, 10];

export interface TonicAnchor {
  gravity: number[];
  ingestedPhrases: number;
  lastPhraseEnding: number | null;
}

export function createAnchor(): TonicAnchor {
  return {
    gravity: new Array(12).fill(0),
    ingestedPhrases: 0,
    lastPhraseEnding: null,
  };
}

export function ingestPhraseAnchor(state: TonicAnchor, phrase: Phrase): TonicAnchor {
  const g = state.gravity.map(v => v * ANCHOR_DECAY);

  if (phrase.lastSustainedPc !== null) {
    g[phrase.lastSustainedPc] += W_END_PHRASE;
  }

  const seenPcs = new Set<number>();
  for (const note of phrase.notes) {
    seenPcs.add(note.pitchClass);
    g[note.pitchClass] += W_DURATION_PER_MS * note.durMs;
    if (note.durMs >= LONG_NOTE_MS) {
      g[note.pitchClass] += W_LONG_NOTE;
    }
    if (note.durMs >= STABLE_NOTE_MIN_DUR_MS && note.rmsAvg >= STABLE_NOTE_MIN_RMS) {
      g[note.pitchClass] += W_STABILITY;
    }
  }

  for (const pc of seenPcs) {
    if (state.gravity[pc] >= RECURRENCE_MIN_PRIOR_WEIGHT) {
      g[pc] += W_RECURRENCE;
    }
  }

  return {
    gravity: g,
    ingestedPhrases: state.ingestedPhrases + 1,
    lastPhraseEnding: phrase.lastSustainedPc,
  };
}

export function alignmentScore(
  candidateTonic: number,
  anchor: TonicAnchor
): number {
  const maxG = Math.max(...anchor.gravity, 1e-9);
  const sumG = anchor.gravity.reduce((a, v) => a + v, 0);
  if (sumG < MIN_GRAVITY_FOR_ALIGNMENT) return 0.5;

  const norm = anchor.gravity.map(g => g / maxG);
  const tonic = norm[candidateTonic];
  const fifth = norm[(candidateTonic + 7) % 12];
  const fourth = norm[(candidateTonic + 5) % 12];

  const score =
    ALIGN_W_TONIC * tonic +
    ALIGN_W_FIFTH * fifth +
    ALIGN_W_FOURTH * fourth;

  return Math.min(1, Math.max(0, score));
}

export function alignmentBoost(
  candidateTonic: number,
  anchor: TonicAnchor
): number {
  const a = alignmentScore(candidateTonic, anchor);
  return 0.4 + 0.6 * a;
}

export function isDiatonicDegreeOf(
  candidate: number,
  currentTonic: number,
  currentQuality: 'major' | 'minor' | null
): boolean {
  if (candidate === currentTonic) return false;
  const interval = (candidate - currentTonic + 12) % 12;
  const degrees = currentQuality === 'minor'
    ? DIATONIC_DEGREES_MINOR
    : DIATONIC_DEGREES_MAJOR;
  return degrees.includes(interval);
}

export function requiredGravityMargin(
  candidate: number,
  currentTonic: number | null,
  currentQuality: 'major' | 'minor' | null
): number {
  if (currentTonic === null) return 1.0;
  return isDiatonicDegreeOf(candidate, currentTonic, currentQuality) ? 1.3 : 1.1;
}
