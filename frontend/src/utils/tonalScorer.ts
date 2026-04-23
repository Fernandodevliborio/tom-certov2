// ═════════════════════════════════════════════════════════════════════════
// tonalScorer.ts v2 — Scoring tonal contextual
// ═════════════════════════════════════════════════════════════════════════

import type { Phrase } from './phraseKeyDetector';

const MAJOR_INTERVALS = [0, 2, 4, 5, 7, 9, 11];
const MINOR_INTERVALS = [0, 2, 3, 5, 7, 8, 10];

const KS_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KS_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

export interface NoteSample {
  pitchClass: number;
  durMs: number;
  stability: number;
  timestamp: number;
}

export class TemporalBuffer {
  private samples: NoteSample[] = [];
  private windowMs: number;

  constructor(windowMs = 5000) { this.windowMs = windowMs; }

  push(sample: NoteSample) {
    this.samples.push(sample);
    const cutoff = sample.timestamp - this.windowMs;
    this.samples = this.samples.filter(s => s.timestamp >= cutoff);
  }

  getSamples(): NoteSample[] { return this.samples.slice(); }
  clear() { this.samples = []; }
}

export function buildWeightedHistogram(samples: NoteSample[]): number[] {
  const h = new Array(12).fill(0);
  for (const s of samples) {
    h[s.pitchClass] += s.durMs * s.stability;
  }
  return h;
}

function rotateProfile(profile: number[], root: number): number[] {
  const out = new Array(12);
  for (let i = 0; i < 12; i++) out[(i + root) % 12] = profile[i];
  return out;
}

function pearson(a: number[], b: number[]): number {
  const n = a.length;
  let sumA = 0, sumB = 0;
  for (let i = 0; i < n; i++) { sumA += a[i]; sumB += b[i]; }
  const meanA = sumA / n, meanB = sumB / n;
  let num = 0, denA = 0, denB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    num += da * db;
    denA += da * da;
    denB += db * db;
  }
  const den = Math.sqrt(denA * denB);
  if (den < 1e-9) return 0;
  return num / den;
}

function perfilKrumhansl(hist: number[], root: number, quality: 'major' | 'minor'): number {
  const profile = rotateProfile(quality === 'major' ? KS_MAJOR : KS_MINOR, root);
  const r = pearson(hist, profile);
  return Math.max(0, (r + 1) / 2);
}

function aderenciaEscala(hist: number[], root: number, quality: 'major' | 'minor'): number {
  const intervals = quality === 'major' ? MAJOR_INTERVALS : MINOR_INTERVALS;
  const inScale = new Set(intervals.map(iv => (root + iv) % 12));
  let inSum = 0, totalSum = 0;
  for (let pc = 0; pc < 12; pc++) {
    totalSum += hist[pc];
    if (inScale.has(pc)) inSum += hist[pc];
  }
  return totalSum > 0 ? inSum / totalSum : 0;
}

function forcaTonica(hist: number[], root: number): number {
  const maxH = Math.max(...hist, 1e-9);
  const tonic = hist[root] / maxH;
  const fifth = hist[(root + 7) % 12] / maxH;
  return Math.min(1, 0.60 * tonic + 0.40 * fifth);
}

function resolucaoFrase(phrases: Phrase[], root: number): number {
  if (phrases.length === 0) return 0;
  let cadCount = 0;
  for (const p of phrases) {
    if (p.lastSustainedPc === root) cadCount++;
  }
  return cadCount / phrases.length;
}

function estabilidadeTemporal(samples: NoteSample[], root: number): number {
  if (samples.length < 4) return 0;
  const mid = Math.floor(samples.length / 2);
  const firstHalf = samples.slice(0, mid);
  const secondHalf = samples.slice(mid);
  const sumRoot = (arr: NoteSample[]) => arr.filter(s => s.pitchClass === root).reduce((a, s) => a + s.durMs * s.stability, 0);
  const sumAll = (arr: NoteSample[]) => arr.reduce((a, s) => a + s.durMs * s.stability, 0);
  const r1 = sumAll(firstHalf) > 0 ? sumRoot(firstHalf) / sumAll(firstHalf) : 0;
  const r2 = sumAll(secondHalf) > 0 ? sumRoot(secondHalf) / sumAll(secondHalf) : 0;
  const diff = Math.abs(r1 - r2);
  return Math.max(0, 1 - diff * 2);
}

function penalidadeNotasFora(hist: number[], root: number, quality: 'major' | 'minor'): number {
  const intervals = quality === 'major' ? MAJOR_INTERVALS : MINOR_INTERVALS;
  const inScale = new Set(intervals.map(iv => (root + iv) % 12));
  let out = 0, total = 0;
  for (let pc = 0; pc < 12; pc++) {
    total += hist[pc];
    if (!inScale.has(pc)) out += hist[pc];
  }
  return total > 0 ? out / total : 0;
}

export interface TonalCandidate {
  root: number;
  quality: 'major' | 'minor';
  score: number;
  breakdown: {
    aderencia: number;
    perfil: number;
    forca: number;
    resolucao: number;
    estabilidade: number;
    penalidade: number;
  };
}

export function scoreKey(
  hist: number[],
  samples: NoteSample[],
  phrases: Phrase[],
  root: number,
  quality: 'major' | 'minor'
): TonalCandidate {
  const aderencia = aderenciaEscala(hist, root, quality);
  const perfil = perfilKrumhansl(hist, root, quality);
  const forca = forcaTonica(hist, root);
  const resolucao = resolucaoFrase(phrases, root);
  const estabilidade = estabilidadeTemporal(samples, root);
  const penalidade = penalidadeNotasFora(hist, root, quality);

  const score =
    0.15 * aderencia +
    0.30 * perfil +
    0.30 * resolucao +
    0.15 * forca +
    0.10 * estabilidade -
    0.20 * penalidade;

  return {
    root,
    quality,
    score,
    breakdown: { aderencia, perfil, forca, resolucao, estabilidade, penalidade },
  };
}

export function isRelativePair(a: TonalCandidate, b: TonalCandidate): boolean {
  if (a.quality === b.quality) return false;
  const maj = a.quality === 'major' ? a : b;
  const min = a.quality === 'minor' ? a : b;
  return min.root === (maj.root + 9) % 12;
}

function relativeTiebreakScore(
  cand: TonalCandidate,
  hist: number[],
  phrases: Phrase[]
): number {
  const resolucao = resolucaoFrase(phrases, cand.root);
  const total = hist.reduce((a, v) => a + v, 0);
  const tonicFreq = total > 0 ? hist[cand.root] / total : 0;
  const fifthFreq = total > 0 ? hist[(cand.root + 7) % 12] / total : 0;
  return 0.55 * resolucao + 0.30 * tonicFreq + 0.15 * fifthFreq;
}

export function rankAllKeys(
  hist: number[],
  samples: NoteSample[],
  phrases: Phrase[]
): TonalCandidate[] {
  const out: TonalCandidate[] = [];
  for (let r = 0; r < 12; r++) {
    out.push(scoreKey(hist, samples, phrases, r, 'major'));
    out.push(scoreKey(hist, samples, phrases, r, 'minor'));
  }
  out.sort((a, b) => b.score - a.score);

  if (out.length >= 2 && isRelativePair(out[0], out[1])) {
    const top1 = out[0], top2 = out[1];
    const diff = Math.abs(top1.score - top2.score);
    const avg = (top1.score + top2.score) / 2;
    const closenessRatio = avg > 0 ? diff / avg : 1;
    if (closenessRatio < 0.08) {
      const tb1 = relativeTiebreakScore(top1, hist, phrases);
      const tb2 = relativeTiebreakScore(top2, hist, phrases);
      if (tb2 > tb1 + 0.02) {
        out[0] = top2;
        out[1] = top1;
      }
    }
  }

  return out;
}

export function agreementMultiplier(
  phraseWinnerRoot: number,
  phraseWinnerQuality: 'major' | 'minor',
  scoringWinner: TonalCandidate
): number {
  const rootsMatch = phraseWinnerRoot === scoringWinner.root;
  const qualitiesMatch = phraseWinnerQuality === scoringWinner.quality;
  if (rootsMatch && qualitiesMatch) return 1.0;
  if (rootsMatch) return 0.60;
  return 0.30;
}

export function isInTop3(
  phraseWinnerRoot: number,
  phraseWinnerQuality: 'major' | 'minor',
  rankedCandidates: TonalCandidate[]
): { inTop3: boolean; rank: number } {
  const top3 = rankedCandidates.slice(0, 3);
  for (let i = 0; i < top3.length; i++) {
    const c = top3[i];
    if (c.root === phraseWinnerRoot && c.quality === phraseWinnerQuality) {
      return { inTop3: true, rank: i + 1 };
    }
  }
  return { inTop3: false, rank: -1 };
}
