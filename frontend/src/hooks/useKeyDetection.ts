/**
 * useKeyDetection v5.1 — Phrase-Based Detector (robusto)
 */

import { useRef, useState, useCallback, useEffect } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import {
  createInitialState,
  buildPhrase,
  ingestPhrase,
  KeyDetectionState,
  DetectedNoteEvent,
  DetectionStage,
} from '../utils/phraseKeyDetector';
import {
  TemporalBuffer,
  buildWeightedHistogram,
  rankAllKeys,
  agreementMultiplier,
  isInTop3,
  NoteSample,
} from '../utils/tonalScorer';
import { usePitchEngine } from '../audio/usePitchEngine';
import { analyzeKeyML, MLAnalysisResult } from '../utils/mlKeyAnalyzer';
import type { PitchEvent, PitchErrorReason } from '../audio/types';
import { frequencyToMidi, midiToPitchClass } from '../utils/noteUtils';

// ─── Filtros de frame ─────────────────────────────────────
const MIN_RMS = 0.010;
const MIN_CLARITY = 0.55;
const MEDIAN_WINDOW = 5;

// ─── Commit de nota ───────────────────────────────────────
const MIN_COMMIT_FRAMES = 4;
const MIN_NOTE_DUR_MS_LOCAL = 130;

// ─── Fechamento de frase ──────────────────────────────────
const VOICED_GAP_MS = 300;
const LEGATO_SUSTAIN_MS = 1500;
const LONG_PHRASE_NOTES = 6;
const LONG_PHRASE_DUR_MS = 3500;
const SAFETY_TIMEOUT_MS = 10000;

export type DetectionState =
  | 'idle' | 'listening' | 'analyzing'
  | 'provisional' | 'confirmed' | 'change_possible';
export type KeyTier = 'provisional' | 'confirmed' | null;

export interface KeyResult {
  root: number;
  quality: 'major' | 'minor';
  confidence?: number;
}

export interface UseKeyDetectionReturn {
  detectionState: DetectionState;
  currentKey: KeyResult | null;
  keyTier: KeyTier;
  liveConfidence: number;
  changeSuggestion: KeyResult | null;
  currentNote: number | null;
  recentNotes: number[];
  audioLevel: number;
  isStable: boolean;
  statusMessage: string;
  isRunning: boolean;
  isSupported: boolean;
  errorMessage: string | null;
  errorReason: PitchErrorReason | null;
  softInfo: string | null;
  phraseStage: DetectionStage;
  phrasesAnalyzed: number;
  start: () => Promise<boolean>;
  stop: () => void;
  reset: () => void;
  mlState: 'idle' | 'waiting' | 'listening' | 'analyzing' | 'done' | 'error';
  mlResult: MLAnalysisResult | null;
  mlProgress: number;
  dismissMlResult: () => void;
  smartStatus: 'idle' | 'warming' | 'listening' | 'analyzing' | 'confirmed';
}

export function useKeyDetection(): UseKeyDetectionReturn {
  const [currentNote, setCurrentNote] = useState<number | null>(null);
  const [recentNotes, setRecentNotes] = useState<number[]>([]);
  const [audioLevel, setAudioLevel] = useState(0);
  const [isRunning, setIsRunning] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [errorReason, setErrorReason] = useState<PitchErrorReason | null>(null);
  const [softInfo, setSoftInfo] = useState<string | null>(null);
  const [keyState, setKeyState] = useState(createInitialState());
  const [agreementMul, setAgreementMul] = useState(1.0);

  const engine = usePitchEngine();

  const startTimeRef = useRef(0);
  const medianBufRef = useRef<number[]>([]);
  const lastStableMidiRef = useRef<number | null>(null);
  const curPcRef = useRef<number | null>(null);
  const curStartRef = useRef(0);
  const curFramesRef = useRef(0);
  const curRmsSumRef = useRef(0);
  const curMidiSumRef = useRef(0);
  const curCommittedRef = useRef(false);
  const lastVoicedTimeRef = useRef(0);
  const phraseNotesRef = useRef<DetectedNoteEvent[]>([]);
  const phraseStartTimeRef = useRef(0);
  const tempBufferRef = useRef(new TemporalBuffer(8000));

  const addRecentNote = useCallback((pc: number) => {
    setRecentNotes(prev => {
      if (prev[prev.length - 1] === pc) return prev;
      const next = [...prev, pc];
      return next.length > 6 ? next.slice(-6) : next;
    });
  }, []);

  const commitCurNote = useCallback((now: number): boolean => {
    if (
      curPcRef.current === null ||
      curCommittedRef.current ||
      curFramesRef.current < MIN_COMMIT_FRAMES
    ) return false;

    const durMs = now - curStartRef.current;
    if (durMs < MIN_NOTE_DUR_MS_LOCAL) return false;

    const rmsAvg = curRmsSumRef.current / curFramesRef.current;
    const midiAvg = curMidiSumRef.current / curFramesRef.current;
    phraseNotesRef.current.push({
      pitchClass: curPcRef.current,
      midi: Math.round(midiAvg),
      timestamp: curStartRef.current - startTimeRef.current,
      durMs,
      rmsAvg,
    });
    const stability = Math.min(1, curFramesRef.current / 10);
    tempBufferRef.current.push({
      pitchClass: curPcRef.current,
      durMs,
      stability,
      timestamp: now,
    });
    curCommittedRef.current = true;
    return true;
  }, []);

  const closePhrase = useCallback((now: number, reason: string) => {
    commitCurNote(now);
    if (phraseNotesRef.current.length === 0) return;

    const notes = phraseNotesRef.current;
    phraseNotesRef.current = [];
    phraseStartTimeRef.current = 0;

    const phrase = buildPhrase(notes);
    if (phrase) {
      setSoftInfo(`Frase capturada (${reason}): ${notes.length} notas`);
      setKeyState(prev => {
        const next = ingestPhrase(prev, phrase);
        try {
          const samples = tempBufferRef.current.getSamples();
          if (samples.length >= 3 && next.phrases.length >= 1) {
            const hist = buildWeightedHistogram(samples);
            const ranked = rankAllKeys(hist, samples, next.phrases);
            const scorerWinner = ranked[0];
            if (next.currentTonicPc !== null && next.quality) {
              let mul = agreementMultiplier(
                next.currentTonicPc,
                next.quality,
                scorerWinner
              );
              const t3 = isInTop3(next.currentTonicPc, next.quality, ranked);
              if (t3.inTop3 && mul < 0.8) mul = 0.8;
              setAgreementMul(mul);
            }
          }
        } catch { /* silencioso */ }
        return next;
      });
    } else {
      setSoftInfo(`Frase descartada (${reason}): ${notes.length} notas curtas`);
    }
  }, [commitCurNote]);

  const onPitch = useCallback((ev: PitchEvent) => {
    const now = Date.now();
    setAudioLevel(Math.min(1, ev.rms * 8));

    const isVoiced =
      ev.rms >= MIN_RMS &&
      ev.clarity >= MIN_CLARITY &&
      ev.frequency >= 65 &&
      ev.frequency <= 2000;

    if (!isVoiced) {
      if (lastVoicedTimeRef.current > 0) {
        const gap = now - lastVoicedTimeRef.current;
        if (gap >= VOICED_GAP_MS) {
          closePhrase(now, 'pausa');
          curPcRef.current = null;
          curFramesRef.current = 0;
          curCommittedRef.current = false;
          setCurrentNote(null);
          lastVoicedTimeRef.current = 0;
        }
      }
      return;
    }

    lastVoicedTimeRef.current = now;

    let midi = frequencyToMidi(ev.frequency);
    if (lastStableMidiRef.current !== null) {
      const diff = midi - lastStableMidiRef.current;
      if (diff >= 10 && diff <= 14) midi -= 12;
      else if (diff <= -10 && diff >= -14) midi += 12;
    }

    const rawPc = midiToPitchClass(midi);

    medianBufRef.current.push(rawPc);
    if (medianBufRef.current.length > MEDIAN_WINDOW) medianBufRef.current.shift();
    const counts = new Array(12).fill(0);
    for (const pc of medianBufRef.current) counts[pc]++;
    let pc: number = rawPc;
    let top = 0;
    for (let i = 0; i < 12; i++) if (counts[i] > top) { top = counts[i]; pc = i; }

    if (counts[pc] >= MEDIAN_WINDOW) {
      lastStableMidiRef.current = midi;
    }

    setCurrentNote(pc);

    if (curPcRef.current === pc) {
      curFramesRef.current++;
      curRmsSumRef.current += ev.rms;
      curMidiSumRef.current += midi;

      const dur = now - curStartRef.current;
      if (dur >= LEGATO_SUSTAIN_MS && !curCommittedRef.current && phraseNotesRef.current.length >= 2) {
        closePhrase(now, 'legato');
      }
    } else {
      if (commitCurNote(now) && curPcRef.current !== null) {
        addRecentNote(curPcRef.current);
      }
      curPcRef.current = pc;
      curStartRef.current = now;
      curFramesRef.current = 1;
      curRmsSumRef.current = ev.rms;
      curMidiSumRef.current = midi;
      curCommittedRef.current = false;
      if (phraseStartTimeRef.current === 0) phraseStartTimeRef.current = now;

      const phraseDur = now - phraseStartTimeRef.current;
      if (phraseNotesRef.current.length >= LONG_PHRASE_NOTES - 1 && phraseDur >= LONG_PHRASE_DUR_MS) {
        closePhrase(now, 'frase longa');
      }
    }
  }, [addRecentNote, commitCurNote, closePhrase]);

  const onError = useCallback((msg: string, reason: PitchErrorReason) => {
    setErrorMessage(msg);
    setErrorReason(reason);
    setIsRunning(false);
  }, []);

  useEffect(() => {
    if (engine.setSoftInfoHandler) engine.setSoftInfoHandler(setSoftInfo);
  }, [engine]);

  const start = useCallback(async (): Promise<boolean> => {
    if (isRunning) return true;
    setErrorMessage(null);
    setErrorReason(null);
    setSoftInfo(null);
    setCurrentNote(null);
    setRecentNotes([]);
    setAudioLevel(0);
    setKeyState(createInitialState());
    startTimeRef.current = Date.now();
    medianBufRef.current = [];
    lastStableMidiRef.current = null;
    curPcRef.current = null;
    curFramesRef.current = 0;
    curCommittedRef.current = false;
    lastVoicedTimeRef.current = 0;
    phraseNotesRef.current = [];
    phraseStartTimeRef.current = 0;
    tempBufferRef.current.clear();
    setAgreementMul(1.0);
    const ok = await engine.start(onPitch, onError);
    if (ok) setIsRunning(true);
    return ok;
  }, [engine, isRunning, onError, onPitch]);

  const stop = useCallback(() => {
    engine.stop().catch(() => {});
    setIsRunning(false);
    setCurrentNote(null);
    setAudioLevel(0);
  }, [engine]);

  // ═══ ML Analysis ═════════════════════════════════════════
  const [mlState, setMlState] = useState<'idle' | 'waiting' | 'listening' | 'analyzing' | 'done' | 'error'>('idle');
  const [mlResult, setMlResult] = useState<MLAnalysisResult | null>(null);
  const [mlProgress, setMlProgress] = useState(0);

  const ML_CAPTURE_DURATION_MS = 10000;
  const ML_START_DELAY_MS = 2000;
  const ML_REANALYZE_INTERVAL_MS = 20000;

  const runMLAnalysis = useCallback(async () => {
    if (!isRunning) return;
    if (!engine.captureClip) return;
    if (mlState === 'listening' || mlState === 'analyzing') return;

    try {
      setMlState('listening');
      setMlProgress(0);
      const startT = Date.now();
      const progTimer = setInterval(() => {
        const elapsed = Date.now() - startT;
        setMlProgress(Math.min(1, elapsed / ML_CAPTURE_DURATION_MS));
      }, 100);

      // eslint-disable-next-line no-console
      console.log('[ML] Iniciando captura de 10s...');
      const clip = await engine.captureClip(ML_CAPTURE_DURATION_MS);
      clearInterval(progTimer);
      setMlProgress(1);

      if (!clip) {
        // eslint-disable-next-line no-console
        console.warn('[ML] captureClip retornou NULL — engine não acumulou samples');
        setMlState('idle');
        return;
      }
      const durS = clip.samples.length / (clip.sampleRate || 16000);
      // eslint-disable-next-line no-console
      console.log(`[ML] Clip capturado: ${clip.samples.length} samples (${durS.toFixed(1)}s)`);

      if (clip.samples.length < 16000 * 3) {
        // eslint-disable-next-line no-console
        console.warn(`[ML] Clip muito curto (${durS.toFixed(1)}s < 3s) — descartado`);
        setMlState('idle');
        return;
      }

      setMlState('analyzing');
      // eslint-disable-next-line no-console
      console.log('[ML] Enviando pro backend...');
      const result = await analyzeKeyML(clip, 30000);
      if (result.success) {
        // eslint-disable-next-line no-console
        console.log(`[ML] ✓ ${result.key_name} conf=${(result.confidence ?? 0).toFixed(2)} flags=${result.flags?.join(',') ?? ''}`);
        setMlResult(result);
        setMlState('done');
      } else {
        // eslint-disable-next-line no-console
        console.warn(`[ML] ✗ Backend rejeitou: ${result.error} — ${result.message}`);
        setMlState('idle');
      }
    } catch (e: any) {
      // eslint-disable-next-line no-console
      console.warn('[ML] Exceção na análise:', e?.message || e);
      setMlState('idle');
    }
  }, [isRunning, engine, mlState]);

  const dismissMlResult = useCallback(() => {
    setMlState('idle');
    setMlResult(null);
    setMlProgress(0);
  }, []);

  const reset = useCallback(() => {
    stop();
    setKeyState(createInitialState());
    setRecentNotes([]);
    setErrorMessage(null);
    setErrorReason(null);
    setSoftInfo(null);
    setMlResult(null);
    setMlState('idle');
  }, [stop]);

  useEffect(() => {
    if (!isRunning) return;
    if (mlState !== 'idle') return;
    if (mlResult?.success) return;
    const timer = setTimeout(() => {
      setMlState('waiting');
      runMLAnalysis();
    }, ML_START_DELAY_MS);
    return () => clearTimeout(timer);
  }, [isRunning, mlState, mlResult, runMLAnalysis]);

  useEffect(() => {
    if (!isRunning) return;
    if (!mlResult?.success) return;
    const interval = setInterval(() => {
      if (mlState === 'idle' || mlState === 'done') {
        runMLAnalysis();
      }
    }, ML_REANALYZE_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [isRunning, mlResult, mlState, runMLAnalysis]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (next: AppStateStatus) => {
      if (next !== 'active' && isRunning) stop();
    });
    return () => sub.remove();
  }, [isRunning, stop]);

  useEffect(() => {
    if (!isRunning) return;
    const t = setInterval(() => {
      const now = Date.now();
      if (phraseStartTimeRef.current > 0 && now - phraseStartTimeRef.current > SAFETY_TIMEOUT_MS) {
        if (phraseNotesRef.current.length >= 2) {
          closePhrase(now, 'timeout');
        }
      }
      if (
        lastVoicedTimeRef.current > 0 &&
        now - lastVoicedTimeRef.current >= VOICED_GAP_MS &&
        phraseNotesRef.current.length >= 2
      ) {
        closePhrase(now, 'pausa-passiva');
        lastVoicedTimeRef.current = 0;
      }
    }, 200);
    return () => clearInterval(t);
  }, [isRunning, closePhrase]);

  const finalConfidence = keyState.tonicConfidence * agreementMul;
  const effectiveStage: DetectionStage =
    agreementMul < 0.5 && keyState.stage === 'definitive' ? 'confirmed' : keyState.stage;

  const detectionState: DetectionState = (() => {
    if (!isRunning) return 'idle';
    switch (effectiveStage) {
      case 'listening': return 'listening';
      case 'probable': return 'provisional';
      case 'confirmed': return 'provisional';
      case 'definitive': return 'confirmed';
    }
  })();

  const keyTier: KeyTier =
    effectiveStage === 'listening' ? null :
    effectiveStage === 'definitive' ? 'confirmed' :
    effectiveStage === 'confirmed' ? 'confirmed' : 'provisional';

  const currentKey: KeyResult | null =
    keyState.currentTonicPc !== null && keyState.quality
      ? { root: keyState.currentTonicPc, quality: keyState.quality, confidence: finalConfidence }
      : null;

  const statusMessage: string = (() => {
    if (!isRunning) return 'Pronto para detectar';
    if (effectiveStage === 'listening') return 'Escutando...';
    if (effectiveStage === 'probable') return 'Tônica provável';
    if (effectiveStage === 'confirmed') return 'Tônica confirmada';
    return 'Tom definitivo';
  })();

  const smartStatus: UseKeyDetectionReturn['smartStatus'] = (() => {
    if (!isRunning) return 'idle';
    if (mlResult?.success) return 'confirmed';
    if (mlState === 'analyzing') return 'analyzing';
    if (mlState === 'listening') return 'listening';
    if (mlState === 'waiting' || mlState === 'idle') return 'warming';
    return 'listening';
  })();

  return {
    detectionState,
    currentKey,
    keyTier,
    liveConfidence: finalConfidence,
    changeSuggestion: null,
    currentNote,
    recentNotes,
    audioLevel,
    isStable: effectiveStage === 'definitive',
    statusMessage,
    isRunning,
    isSupported: engine.isSupported,
    errorMessage,
    errorReason,
    softInfo,
    phraseStage: effectiveStage,
    phrasesAnalyzed: keyState.phrases.length,
    start,
    stop,
    reset,
    mlState,
    mlResult,
    mlProgress,
    dismissMlResult,
    smartStatus,
  };
}
