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
import { analyzeKeyML, MLAnalysisResult, resetKeyAnalysisSession } from '../utils/mlKeyAnalyzer';
import {
  createNoiseStageDebouncer,
  describeStage,
  NoiseStageDisplay,
} from '../utils/noiseStageDebouncer';
import type { NoiseStage } from '../utils/mlKeyAnalyzer';
import type { PitchEvent, PitchErrorReason } from '../audio/types';
import { frequencyToMidi, midiToPitchClass } from '../utils/noteUtils';
import { getDeviceId } from '../auth/deviceId';
import { audioLog } from '../audio/audioLogger';
import {
  loadDetectionMode,
  saveDetectionMode,
  type DetectionMode,
} from '../utils/detectionMode';

// ─── Pipeline Health Watchdog (timeouts aprovados pelo usuário) ───
const WATCHDOG_TICK_MS = 1000;                // verificação a cada 1s
const AUDIO_FRAME_TIMEOUT_MS = 5000;          // 5s sem frame → restart engine
const PITCH_VALID_TIMEOUT_MS = 10000;         // 10s sem pitch válido → soft reset
const NO_PROGRESS_HARD_RESET_MS = 30000;      // 30s sem progresso real → hard reset
const ML_ANALYZING_STUCK_MS = 18000;          // 18s preso em 'analyzing' → forçar waiting
const POST_RESTART_GRACE_MS = 3000;           // após restart, dar 3s antes de checar de novo

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
  softReset: () => Promise<void>;
  /**
   * NOVO — Hard reset definitivo. Cancela request ML em voo, destrói o recorder,
   * limpa todos os buffers/locks/timeouts, e recria a sessão de áudio do zero.
   * Substituto correto para o botão "Nova Detecção".
   */
  hardReset: () => Promise<void>;
  mlState: 'idle' | 'waiting' | 'listening' | 'analyzing' | 'done' | 'error';
  mlResult: MLAnalysisResult | null;
  mlProgress: number;
  dismissMlResult: () => void;
  smartStatus: 'idle' | 'warming' | 'listening' | 'analyzing' | 'confirmed';
  // NOVO — Estado de ruído debounciado, vindo da camada vocal_focus do backend.
  // Usado pela UI para mostrar mensagens como "Ambiente com ruído" sem flicker.
  noiseStage: NoiseStage;
  noiseDisplay: NoiseStageDisplay;
  /**
   * NOVO — Status de recuperação automática do pipeline.
   *   'idle'         : tudo normal
   *   'restarting'   : Audio Health Watchdog está reiniciando o recorder
   *   'soft_reset'   : Pipeline limpando buffers (sem matar áudio)
   *   'hard_reset'   : Hard reset em curso (programático ou via botão)
   * O UI pode mostrar "Reiniciando escuta..." quando isso for diferente de 'idle'.
   */
  recoveryStatus: 'idle' | 'restarting' | 'soft_reset' | 'hard_reset';
  /**
   * NOVO — Modo de detecção ativo.
   *   'vocal'             → Voz / A capela (padrão, comportamento preservado)
   *   'vocal_instrument'  → Voz + Instrumento (acordes/baixo viram evidência)
   * Persistido em AsyncStorage. Trocar de modo dispara hardReset automático.
   */
  detectionMode: DetectionMode;
  setDetectionMode: (mode: DetectionMode) => Promise<void>;
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
  // NOVO — status de recuperação (UI pode exibir "Reiniciando escuta...")
  const [recoveryStatus, setRecoveryStatus] = useState<
    'idle' | 'restarting' | 'soft_reset' | 'hard_reset'
  >('idle');

  // ─── Modo de detecção (persistido em AsyncStorage) ────────────────────
  const [detectionMode, _setDetectionMode] = useState<DetectionMode>('vocal');
  const detectionModeRef = useRef<DetectionMode>('vocal');
  useEffect(() => { detectionModeRef.current = detectionMode; }, [detectionMode]);

  // Carrega o modo persistido no boot (1x). Default = 'vocal'.
  useEffect(() => {
    let cancelled = false;
    loadDetectionMode().then(m => {
      if (!cancelled) {
        _setDetectionMode(m);
        audioLog.info('detection_mode_loaded', { mode: m });
      }
    });
    return () => { cancelled = true; };
  }, []);

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

  // ─── Pipeline Health refs ───────────────────────────────────────────────
  // Timestamps autoritativos para os watchdogs:
  //   lastAudioFrameAtRef  → atualizado em cada onPitch (sinal de vida do recorder)
  //   lastValidPitchAtRef  → atualizado quando ev.clarity passa o limiar
  //   lastBackendProgressAtRef → atualizado quando backend responde com sucesso E avança o estado
  //   lastWatchdogActionAtRef → último restart/reset automático (para grace period)
  const lastAudioFrameAtRef = useRef<number>(0);
  const lastValidPitchAtRef = useRef<number>(0);
  const lastBackendProgressAtRef = useRef<number>(0);
  const lastWatchdogActionAtRef = useRef<number>(0);

  // ─── Anti-concorrência ML ───────────────────────────────────────────────
  // Lock booleano + AbortController para cancelar request em voo (stop/reset).
  const mlInFlightRef = useRef<boolean>(false);
  const mlAbortControllerRef = useRef<AbortController | null>(null);

  // ─── AppState recovery ──────────────────────────────────────────────────
  const wasRunningBeforeBackgroundRef = useRef<boolean>(false);

  // ─── Watchdog timer ─────────────────────────────────────────────────────
  const watchdogIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

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
      // ── Info técnica silenciosa (não exibir "Frase capturada" pro usuário) ──
      // eslint-disable-next-line no-console
      console.log(`[Phrase] capturada ${reason}: ${notes.length} notas`);
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
      // Frase curta: usar como evidência fraca (log interno apenas — NÃO exibir)
      // eslint-disable-next-line no-console
      console.log(`[Phrase] descartada ${reason}: ${notes.length} notas curtas (evidência fraca)`);
      // NÃO seta softInfo — usuário não vê isso
    }
  }, [commitCurNote]);

  const onPitch = useCallback((ev: PitchEvent) => {
    const now = Date.now();
    setAudioLevel(Math.min(1, ev.rms * 8));

    // ── Pipeline Health: registra recebimento de frame (sinal de vida) ──
    lastAudioFrameAtRef.current = now;

    const isVoiced =
      ev.rms >= MIN_RMS &&
      ev.clarity >= MIN_CLARITY &&
      ev.frequency >= 65 &&
      ev.frequency <= 2000;

    if (isVoiced) {
      // Pitch válido detectado — atualiza timestamp para watchdog de pitch
      lastValidPitchAtRef.current = now;
    }

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

  // Flag para evitar cliques duplos durante inicialização
  const isStartingRef = useRef(false);

  const start = useCallback(async (): Promise<boolean> => {
    // Evita duplo clique - se já está rodando ou iniciando, retorna
    if (isRunning || isStartingRef.current) return true;
    
    // Marca que está iniciando IMEDIATAMENTE (antes de qualquer await)
    isStartingRef.current = true;
    
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
    
    // CRÍTICO: Reset do estado ML para iniciar novo loop de análise
    setMlState('idle');
    setMlResult(null);
    setMlProgress(0);
    // Reset do debouncer de noise stage
    noiseDebouncerRef.current.reset();
    setNoiseStage('clean');

    // ── Pipeline Health: zera timestamps + lock + abort controller ───
    const startNow = Date.now();
    lastAudioFrameAtRef.current = startNow;          // dá grace period inicial
    lastValidPitchAtRef.current = startNow;
    lastBackendProgressAtRef.current = startNow;
    lastWatchdogActionAtRef.current = startNow;
    mlInFlightRef.current = false;
    if (mlAbortControllerRef.current) {
      try { mlAbortControllerRef.current.abort(); } catch { /* noop */ }
    }
    mlAbortControllerRef.current = null;
    setRecoveryStatus('idle');

    // Reset PCP em background — NÃO aguarda para não bloquear o start do microfone
    resetKeyAnalysisSession(deviceIdRef.current ?? undefined, detectionModeRef.current).catch(() => {});

    try {
      const ok = await engine.start(onPitch, onError);
      if (ok) {
        setIsRunning(true);
        // Reset os timestamps DE NOVO após start bem-sucedido (start pode demorar)
        const t = Date.now();
        lastAudioFrameAtRef.current = t;
        lastValidPitchAtRef.current = t;
        lastBackendProgressAtRef.current = t;
        lastWatchdogActionAtRef.current = t;
      }
      return ok;
    } finally {
      // Libera o flag após conclusão (sucesso ou erro)
      isStartingRef.current = false;
    }
  }, [engine, isRunning, onError, onPitch]);

  const stop = useCallback(() => {
    // Cancela request ML em voo (importante para não chegar resposta tardia
    // após stop e contaminar o estado da próxima sessão)
    if (mlAbortControllerRef.current) {
      try { mlAbortControllerRef.current.abort(); } catch { /* noop */ }
      audioLog.info('backend_request_cancelled', { reason: 'stop' });
      mlAbortControllerRef.current = null;
    }
    mlInFlightRef.current = false;
    engine.stop().catch(() => {});
    setIsRunning(false);
    setCurrentNote(null);
    setAudioLevel(0);
    setRecoveryStatus('idle');
  }, [engine]);

  // ═══ ML Analysis ═════════════════════════════════════════
  const [mlState, setMlState] = useState<'idle' | 'waiting' | 'listening' | 'analyzing' | 'done' | 'error'>('idle');
  const [mlResult, setMlResult] = useState<MLAnalysisResult | null>(null);
  const [mlProgress, setMlProgress] = useState(0);
  const deviceIdRef = useRef<string | null>(null);

  // ─── Noise stage com debounce/histerese ─────────────────────────────────
  // Sempre que o backend responder (sucesso OU rejeição), alimentamos o
  // debouncer. O debouncer só "publica" um estado novo se ele se manteve
  // estável por ~1.5s — isso evita flicker visual.
  const noiseDebouncerRef = useRef(createNoiseStageDebouncer());
  const [noiseStage, setNoiseStage] = useState<NoiseStage>('clean');

  const ingestNoiseStage = useCallback((stage: NoiseStage | undefined) => {
    if (!stage) return;
    const stable = noiseDebouncerRef.current.update(stage, Date.now());
    setNoiseStage(prev => (prev === stable ? prev : stable));
  }, []);
  
  // Ref para evitar stale closures no guard de mlState
  const mlStateRef = useRef(mlState);
  useEffect(() => { mlStateRef.current = mlState; }, [mlState]);

  useEffect(() => {
    let cancelled = false;
    getDeviceId()
      .then((id) => { if (!cancelled) deviceIdRef.current = id; })
      .catch(() => { /* fallback: backend usa 'anon' */ });
    return () => { cancelled = true; };
  }, []);

  const ML_CAPTURE_DURATION_MS = 2000;     // FIX: era 2500 — clip mais curto = CREPE mais rápido
  const ML_MIN_CLIP_SAMPLES = 16000 * 1.2; // 1.2s mínimo

  const runMLAnalysis = useCallback(async () => {
    // Usar ref para ler estado atual (evita stale closure)
    const currentMlState = mlStateRef.current;

    if (!isRunning) return;
    if (!engine.captureClip) {
      audioLog.warn('engine_capture_clip_missing');
      return;
    }
    if (currentMlState === 'listening' || currentMlState === 'analyzing') {
      // já em curso — ignora silenciosamente
      return;
    }
    // ── LOCK anti-concorrência ────────────────────────────────────
    // Mesmo com o guard de mlState acima, watchdog + loop podem disparar
    // em paralelo. Este lock booleano garante exclusividade absoluta.
    if (mlInFlightRef.current) {
      audioLog.info('ml_analysis_skipped_lock_held');
      return;
    }
    mlInFlightRef.current = true;

    // AbortController criado FORA do try para poder cancelar via stop/reset
    const controller = new AbortController();
    mlAbortControllerRef.current = controller;

    let progTimer: ReturnType<typeof setInterval> | null = null;

    try {
      setMlState('listening');
      setMlProgress(0);
      const startT = Date.now();
      progTimer = setInterval(() => {
        const elapsed = Date.now() - startT;
        setMlProgress(Math.min(1, elapsed / ML_CAPTURE_DURATION_MS));
      }, 100);

      const clip = await engine.captureClip(ML_CAPTURE_DURATION_MS);
      if (progTimer) { clearInterval(progTimer); progTimer = null; }
      setMlProgress(1);

      if (controller.signal.aborted) {
        audioLog.info('backend_request_cancelled', { phase: 'pre_capture' });
        setMlState('waiting');
        return;
      }

      if (!clip) {
        audioLog.info('ml_clip_unavailable', { reason: 'ring_buffer_empty' });
        setMlState('waiting');
        return;
      }
      const durS = clip.samples.length / (clip.sampleRate || 16000);

      if (clip.samples.length < ML_MIN_CLIP_SAMPLES) {
        audioLog.info('ml_clip_too_short', { durMs: Math.round(durS * 1000) });
        setMlState('waiting');
        return;
      }

      setMlState('analyzing');
      audioLog.info('backend_request_start', { samples: clip.samples.length, durSec: Math.round(durS * 10) / 10 });

      const result = await analyzeKeyML(
        clip,
        undefined,
        deviceIdRef.current ?? undefined,
        controller.signal,
        detectionModeRef.current,
      );

      if (controller.signal.aborted || result.error === 'cancelled') {
        audioLog.info('backend_request_cancelled', { phase: 'post_send' });
        setMlState('waiting');
        return;
      }

      // Atualiza estado de ruído (debouciado) — vale para sucesso E rejeição
      ingestNoiseStage(result.noise_rejection?.stage);

      if (result.success) {
        audioLog.info('backend_request_success', {
          stage: (result as any).stage,
          locked: !!result.locked,
          key: result.key_name,
          confidence: result.confidence,
          noiseStage: result.noise_rejection?.stage,
        });
        // Atualiza watchdog de progresso (qualquer resposta success conta)
        lastBackendProgressAtRef.current = Date.now();
        setMlResult(result);
        setMlState('done');
      } else {
        audioLog.warn('backend_request_error', { error: result.error, message: result.message });
        setMlState('waiting');
      }
    } catch (e: any) {
      audioLog.warn('backend_request_exception', { msg: String(e?.message || e) });
      setMlState('waiting');
    } finally {
      // CRÍTICO: liberar lock SEMPRE — mesmo em caso de exception ou abort
      if (progTimer) clearInterval(progTimer);
      mlInFlightRef.current = false;
      // Só limpa o controller se ainda for o mesmo (não foi substituído por reset)
      if (mlAbortControllerRef.current === controller) {
        mlAbortControllerRef.current = null;
      }
      audioLog.info('lock_released', { lock: 'ml_in_flight' });
    }
  // CRÍTICO: NÃO incluir mlState nas dependências!
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRunning, engine, ingestNoiseStage]);

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
    noiseDebouncerRef.current.reset();
    setNoiseStage('clean');
  }, [stop]);

  // ═══════════════════════════════════════════════════════════════════════
  // HARD RESET — destrói tudo e recria do zero
  // ═══════════════════════════════════════════════════════════════════════
  // Sequência fixa (não pode pular passos):
  //   1. Cancela request ML em voo (AbortController.abort)
  //   2. Limpa locks (mlInFlightRef = false)
  //   3. Para o recorder via engine.stop()
  //   4. Limpa TODOS os buffers/refs/state visual
  //   5. engine.restart() — destrói e recria o handle do recorder
  //   6. Re-inicia o loop ML do zero
  // Botão "Nova Detecção" no UI deve chamar este método.
  const hardReset = useCallback(async () => {
    audioLog.warn('hard_reset_detection', { phase: 'begin' });
    setRecoveryStatus('hard_reset');

    // 1. Cancela request ML em voo
    if (mlAbortControllerRef.current) {
      try { mlAbortControllerRef.current.abort(); } catch { /* noop */ }
      audioLog.info('backend_request_cancelled', { reason: 'hard_reset' });
      mlAbortControllerRef.current = null;
    }

    // 2. Libera locks
    mlInFlightRef.current = false;

    // 3. Para o recorder
    try {
      await engine.stop();
    } catch (e: any) {
      audioLog.warn('hard_reset_stop_error', { msg: String(e?.message || e) });
    }

    // 4. Limpa TUDO (state + refs)
    setKeyState(createInitialState());
    setRecentNotes([]);
    setCurrentNote(null);
    setAudioLevel(0);
    setErrorMessage(null);
    setErrorReason(null);
    setSoftInfo(null);
    setMlResult(null);
    setMlState('idle');
    setMlProgress(0);
    setAgreementMul(1.0);
    noiseDebouncerRef.current.reset();
    setNoiseStage('clean');
    medianBufRef.current = [];
    lastStableMidiRef.current = null;
    curPcRef.current = null;
    curFramesRef.current = 0;
    curCommittedRef.current = false;
    lastVoicedTimeRef.current = 0;
    phraseNotesRef.current = [];
    phraseStartTimeRef.current = 0;
    tempBufferRef.current.clear();
    // Reseta timestamps de health para AGORA (grace period inicial)
    const t = Date.now();
    lastAudioFrameAtRef.current = t;
    lastValidPitchAtRef.current = t;
    lastBackendProgressAtRef.current = t;
    lastWatchdogActionAtRef.current = t;
    startTimeRef.current = t;

    // 5. Restart engine completo (destrói + recria recorder + re-pede permissão se necessário)
    setIsRunning(false);
    isStartingRef.current = false;
    let restartOk = false;
    if (engine.restart) {
      restartOk = await engine.restart();
    } else {
      // Fallback: usa start() normal se restart() não existir (ex.: web)
      restartOk = await engine.start(onPitch, onError);
    }
    if (restartOk) {
      setIsRunning(true);
      // Reseta timestamps de novo após start (start pode demorar)
      const t2 = Date.now();
      lastAudioFrameAtRef.current = t2;
      lastValidPitchAtRef.current = t2;
      lastBackendProgressAtRef.current = t2;
      lastWatchdogActionAtRef.current = t2;
    }

    // 6. Reset PCP no backend (não bloqueia)
    resetKeyAnalysisSession(deviceIdRef.current ?? undefined, detectionModeRef.current).catch(() => {});

    setRecoveryStatus('idle');
    audioLog.info('hard_reset_detection', { phase: 'done', restartOk });
  }, [engine, onPitch, onError]);

  // ═══════════════════════════════════════════════════════════════════════
  // setDetectionMode — troca o modo e dispara hardReset automático
  // ═══════════════════════════════════════════════════════════════════════
  // Trocar de modo afeta a calibração do focus (vocal vs instrumento) e
  // a sessão acumulada no backend. Para evitar análise híbrida confusa,
  // descartamos a sessão atual e iniciamos uma nova em modo diferente.
  // - Se NÃO estava rodando: só atualiza o state + persiste.
  // - Se ESTAVA rodando: hardReset limpa tudo + restart do recorder.
  const setDetectionMode = useCallback(async (next: DetectionMode) => {
    if (next !== 'vocal' && next !== 'vocal_instrument') return;
    if (next === detectionModeRef.current) return;
    audioLog.info('detection_mode_changing', {
      from: detectionModeRef.current, to: next, isRunning: isRunningRef.current,
    });
    // Atualiza imediatamente o state + ref + persistência
    detectionModeRef.current = next;
    _setDetectionMode(next);
    saveDetectionMode(next).catch(() => {});
    // Se estava rodando, faz hardReset (descarta sessão + restart engine)
    if (isRunningRef.current) {
      await hardReset();
    }
    audioLog.info('detection_mode_changed', { mode: next });
  }, [hardReset]);

  // Soft reset — limpa estado de análise SEM parar o microfone.
  // Usado pelo botão "Detectar novo tom" no UI.
  const softReset = useCallback(async () => {
    setRecoveryStatus('soft_reset');
    // Cancela request ML em voo (não queremos resposta tardia contaminando)
    if (mlAbortControllerRef.current) {
      try { mlAbortControllerRef.current.abort(); } catch { /* noop */ }
      audioLog.info('backend_request_cancelled', { reason: 'soft_reset' });
      mlAbortControllerRef.current = null;
    }
    mlInFlightRef.current = false;
    setKeyState(createInitialState());
    setRecentNotes([]);
    setSoftInfo(null);
    setMlResult(null);
    setMlState('idle');
    setAgreementMul(1.0);
    lastVoicedTimeRef.current = 0;
    phraseNotesRef.current = [];
    phraseStartTimeRef.current = 0;
    tempBufferRef.current.clear();
    noiseDebouncerRef.current.reset();
    setNoiseStage('clean');
    // Reseta timestamps para grace period
    const t = Date.now();
    lastValidPitchAtRef.current = t;
    lastBackendProgressAtRef.current = t;
    // Zera o acumulador PCP no backend em background (não bloqueia UI)
    resetKeyAnalysisSession(deviceIdRef.current ?? undefined, detectionModeRef.current).catch(() => {});
    setRecoveryStatus('idle');
  }, []);

  // ─── Watchdog antigo (legacy) ─────────────────────────────────────────────
  // Mantido apenas o ref de timestamp porque o Pipeline Health Watchdog acima
  // o consulta para detectar "ML preso em analyzing". A ação foi movida pra lá.
  const mlAnalysisStartRef = useRef<number>(0);

  useEffect(() => {
    if (mlState === 'analyzing') {
      mlAnalysisStartRef.current = Date.now();
    }
  }, [mlState]);

  // ─────────────────────────────────────────────────────────────────────────
  // Ref para mlResult (evita stale closure no loop)
  const mlResultRef = useRef(mlResult);
  useEffect(() => { mlResultRef.current = mlResult; }, [mlResult]);

  const runMLAnalysisRef = useRef(runMLAnalysis);
  useEffect(() => { runMLAnalysisRef.current = runMLAnalysis; }, [runMLAnalysis]);

  // ═══════════════════════════════════════════════════════════════
  // LOOP REATIVO TURBO — análises mais frequentes para resultado rápido
  // ═══════════════════════════════════════════════════════════════
  // Ref para isRunning (evita stale closure)
  const isRunningRef = useRef(isRunning);
  useEffect(() => { isRunningRef.current = isRunning; }, [isRunning]);

  useEffect(() => {
    // Se não está rodando, não faz nada
    if (!isRunning) return;
    
    // Função que verifica estado atual e agenda próxima análise
    const scheduleNextAnalysis = () => {
      const currentState = mlStateRef.current;
      const currentRunning = isRunningRef.current;
      
      // eslint-disable-next-line no-console
      console.log(`[ML-LOOP] scheduleNextAnalysis: running=${currentRunning} state=${currentState}`);
      
      if (!currentRunning) return;
      if (currentState === 'listening' || currentState === 'analyzing') return;
      
      // Delays baseados no estado atual
      let delay: number;
      switch (currentState) {
        case 'idle': delay = 400; break;
        case 'waiting': delay = 800; break;
        // FIX: quando já tem resultado, não redespachar imediatamente
        // Evita inundar o backend com requests a cada 50ms
        case 'done': delay = (mlResultRef.current?.locked ? 6000 : 1500); break;
        default: delay = 800;
      }
      
      // eslint-disable-next-line no-console
      console.log(`[ML-LOOP] Agendando em ${delay}ms`);
      setTimeout(() => {
        if (isRunningRef.current) {
          // eslint-disable-next-line no-console
          console.log('[ML-LOOP] Executando runMLAnalysis');
          runMLAnalysisRef.current?.();
        }
      }, delay);
    };

    // Inicia o loop
    scheduleNextAnalysis();
    
    // Re-agenda quando mlState muda
    const interval = setInterval(() => {
      const currentState = mlStateRef.current;
      if (currentState === 'done' || currentState === 'waiting' || currentState === 'idle') {
        scheduleNextAnalysis();
      }
    }, 600);
    
    return () => clearInterval(interval);
  }, [isRunning]); // Só depende de isRunning para iniciar/parar

  // ═══════════════════════════════════════════════════════════════════════
  // PIPELINE HEALTH WATCHDOG (escalonado)
  // ═══════════════════════════════════════════════════════════════════════
  // Verifica a cada WATCHDOG_TICK_MS o estado do pipeline e age progressivamente:
  //   1. >5s sem frame de áudio  → engine.restart() (recorder pode ter morrido)
  //   2. >10s sem pitch válido    → soft reset (limpa buffers, força nova captura)
  //   3. >30s sem progresso real  → hard reset completo (UI + recorder + backend)
  //
  // Também faz unstuck do mlState 'analyzing' preso por >18s (backend lento).
  //
  // Cada ação respeita um POST_RESTART_GRACE_MS para não disparar em cascata.
  // Refs são usadas para evitar stale closures dentro do interval.
  const hardResetRef = useRef(hardReset);
  const softResetRef = useRef(softReset);
  useEffect(() => { hardResetRef.current = hardReset; }, [hardReset]);
  useEffect(() => { softResetRef.current = softReset; }, [softReset]);

  useEffect(() => {
    if (!isRunning) {
      if (watchdogIntervalRef.current) {
        clearInterval(watchdogIntervalRef.current);
        watchdogIntervalRef.current = null;
      }
      return;
    }

    watchdogIntervalRef.current = setInterval(() => {
      if (!isRunningRef.current) return;
      const now = Date.now();
      // Grace period após qualquer ação do watchdog (evita restart em cascata)
      if (now - lastWatchdogActionAtRef.current < POST_RESTART_GRACE_MS) return;

      // ── Camada A: ML 'analyzing' preso ────────────────────────────
      if (mlStateRef.current === 'analyzing') {
        const elapsed = now - mlAnalysisStartRef.current;
        if (elapsed > ML_ANALYZING_STUCK_MS) {
          audioLog.warn('watchdog_ml_stuck', { elapsedMs: elapsed });
          // Aborta a request e libera o lock
          if (mlAbortControllerRef.current) {
            try { mlAbortControllerRef.current.abort(); } catch { /* noop */ }
          }
          mlInFlightRef.current = false;
          setMlState('waiting');
          lastWatchdogActionAtRef.current = now;
          return;
        }
      }

      // ── Camada B: 5s sem frame de áudio ───────────────────────────
      const lastFrame = lastAudioFrameAtRef.current;
      if (lastFrame > 0) {
        const ageFrame = now - lastFrame;
        if (ageFrame > AUDIO_FRAME_TIMEOUT_MS) {
          audioLog.warn('audio_frame_timeout', { ageMs: ageFrame });
          audioLog.warn('watchdog_restart', { reason: 'no_audio_frame', ageMs: ageFrame });
          setRecoveryStatus('restarting');
          lastWatchdogActionAtRef.current = now;
          // Restart engine — não bloqueia o watchdog
          (async () => {
            const ok = engine.restart ? await engine.restart() : false;
            if (ok) {
              const t = Date.now();
              lastAudioFrameAtRef.current = t;
              lastValidPitchAtRef.current = t;
              audioLog.info('watchdog_restart_ok');
            } else {
              audioLog.error('watchdog_restart_failed_doing_hard_reset');
              await hardResetRef.current?.();
            }
            setRecoveryStatus('idle');
          })();
          return;
        }
      }

      // ── Camada C: 10s sem pitch válido (recorder vivo, mas usuário em silêncio
      //              OU sinal degradado) — soft reset não é restart de áudio,
      //              é só limpar buffers ML que talvez estejam contaminados.
      const lastPitch = lastValidPitchAtRef.current;
      if (lastPitch > 0) {
        const agePitch = now - lastPitch;
        if (agePitch > PITCH_VALID_TIMEOUT_MS) {
          audioLog.warn('pitch_timeout', { ageMs: agePitch });
          // Não é necessariamente um problema (usuário pode estar em silêncio).
          // Só faz soft_reset se o pipeline ML também estiver parado, pra não
          // descartar análise em andamento.
          if (mlStateRef.current !== 'analyzing' && mlStateRef.current !== 'listening') {
            audioLog.info('pitch_timeout_soft_reset');
            // Não chama softReset() completo — apenas reseta os timestamps
            // pra dar nova chance. O áudio continua escutando.
            lastValidPitchAtRef.current = now;
            lastWatchdogActionAtRef.current = now;
          }
        }
      }

      // ── Camada D: 30s sem progresso real → hard reset ──────────────
      const lastProgress = lastBackendProgressAtRef.current;
      if (lastProgress > 0) {
        const ageProgress = now - lastProgress;
        if (ageProgress > NO_PROGRESS_HARD_RESET_MS) {
          audioLog.error('no_progress_hard_reset', { ageMs: ageProgress });
          lastWatchdogActionAtRef.current = now;
          (async () => {
            await hardResetRef.current?.();
          })();
        }
      }
    }, WATCHDOG_TICK_MS);

    return () => {
      if (watchdogIntervalRef.current) {
        clearInterval(watchdogIntervalRef.current);
        watchdogIntervalRef.current = null;
      }
    };
  }, [isRunning, engine]);

  // ═══════════════════════════════════════════════════════════════════════
  // APP STATE recovery (background → active)
  // ═══════════════════════════════════════════════════════════════════════
  // Antes: ao ir pra background, fazia stop() mas NUNCA religava ao voltar.
  // Agora: marca a flag, e ao voltar pra 'active' restart automático.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next: AppStateStatus) => {
      audioLog.info('app_state_changed', { state: next, isRunning: isRunningRef.current });
      if (next !== 'active') {
        // Indo pro background ou inactive
        if (isRunningRef.current) {
          wasRunningBeforeBackgroundRef.current = true;
          // Cancela request ML em voo (não pode chegar resposta com app em bg)
          if (mlAbortControllerRef.current) {
            try { mlAbortControllerRef.current.abort(); } catch { /* noop */ }
          }
          mlInFlightRef.current = false;
          // Para o recorder (Android pausaria de qualquer forma)
          stop();
        }
      } else {
        // Voltou pra active
        if (wasRunningBeforeBackgroundRef.current && !isRunningRef.current) {
          wasRunningBeforeBackgroundRef.current = false;
          audioLog.info('app_state_recovery_restart');
          setRecoveryStatus('restarting');
          (async () => {
            // start() do hook já cuida de tudo (permissão + recorder + reset state)
            const ok = await start();
            audioLog.info('app_state_recovery_done', { ok });
            setRecoveryStatus('idle');
          })();
        }
      }
    });
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stop, start]);

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
    return 'warming';
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
    softReset,
    hardReset,
    mlState,
    mlResult,
    mlProgress,
    dismissMlResult,
    smartStatus,
    noiseStage,
    noiseDisplay: describeStage(noiseStage),
    recoveryStatus,
    detectionMode,
    setDetectionMode,
  };
}
