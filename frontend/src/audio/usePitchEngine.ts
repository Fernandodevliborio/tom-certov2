/**
 * NATIVE (iOS/Android) pitch engine using @siteed/audio-studio for real PCM streaming.
 *
 * IMPORTANT:
 *   - useAudioRecorder is a React hook and MUST be called at the top level of this hook.
 *   - On web, Metro bundler auto-resolves the `.web.ts` variant of this file.
 */

import { useCallback, useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import {
  useAudioRecorder,
  AudioStudioModule,
  type AudioDataEvent,
} from '@siteed/audio-studio';
import { yinPitch } from './yin';
import { frequencyToMidi, midiToPitchClass } from '../utils/noteUtils';
import * as storage from '../auth/storage';
import type {
  PitchCallback,
  ErrorCallback,
  PitchEngineHandle,
  PitchErrorReason,
  CapturedClip,
} from './types';

const SAMPLE_RATE = 16000;
const FRAME_SIZE = 2048;
const STREAM_INTERVAL_MS = 100;
const PERM_KEY = 'tc_mic_granted_v1';
const RING_CAPACITY = 8192;

async function ensureMicPermission(): Promise<'granted' | 'denied' | 'blocked'> {
  try {
    const mod: any = AudioStudioModule;
    if (!mod) return 'denied';
    const current = await mod.getPermissionsAsync?.().catch(() => null);
    if (current && current.granted) {
      await storage.setItem(PERM_KEY, '1');
      return 'granted';
    }
    if (current && current.canAskAgain === false) return 'blocked';

    const next = await mod.requestPermissionsAsync?.();
    if (next && next.granted) {
      await storage.setItem(PERM_KEY, '1');
      return 'granted';
    }
    if (next && next.canAskAgain === false) return 'blocked';
    return 'denied';
  } catch (e) {
    console.warn('[AudioEngine] permission check failed:', String((e as any)?.message || e));
    return 'denied';
  }
}

export function usePitchEngine(): PitchEngineHandle {
  // ── React hooks (MUST be called at top level) ────────────────────
  const recorder = useAudioRecorder();

  // Keep a ref so async callbacks always see the latest recorder object
  const recorderRef = useRef(recorder);
  useEffect(() => { recorderRef.current = recorder; }, [recorder]);

  const onPitchRef = useRef<PitchCallback | null>(null);
  const onErrorRef = useRef<ErrorCallback | null>(null);
  const softInfoRef = useRef<((msg: string) => void) | null>(null);
  const activeRef = useRef(false);
  const isStartingRef = useRef(false);

  const ringRef = useRef(new Float32Array(RING_CAPACITY));
  const ringLenRef = useRef(0);

  // ── Ring buffer CONTÍNUO para captureClip (últimos 15s sempre disponíveis) ──
  const CAPTURE_RING_DURATION_S = 15;
  const CAPTURE_RING_CAPACITY = SAMPLE_RATE * CAPTURE_RING_DURATION_S;
  const captureRingRef = useRef(new Float32Array(CAPTURE_RING_CAPACITY));
  const captureRingPosRef = useRef(0);    // índice de escrita
  const captureRingFilledRef = useRef(0); // total de samples escritos (até CAPACITY)

  // ── Pitch analysis per frame ─────────────────────────────────────
  const runYinOnFrame = useCallback((frame: Float32Array, sampleRate: number) => {
    if (!activeRef.current) return;
    const result = yinPitch(frame, { sampleRate });
    if (result.frequency > 0 && onPitchRef.current) {
      const midi = frequencyToMidi(result.frequency);
      const pc = midiToPitchClass(midi);
      onPitchRef.current({
        pitchClass: pc,
        frequency: result.frequency,
        rms: result.rms,
        clarity: result.probability,
      });
    }
  }, []);

  // ── Audio stream callback ────────────────────────────────────────
  const streamFrameCountRef = useRef(0);
  const streamLoggedTypeRef = useRef<string>('');

  const handleAudioStream = useCallback(
    async (event: AudioDataEvent) => {
      if (!activeRef.current) return;
      const raw = (event as any).data;
      let data: Float32Array | null = null;

      // Log type ONCE on first call (or when it changes) — diagnostic
      const dataType = raw instanceof Float32Array ? 'float32array'
        : Array.isArray(raw) ? 'array'
        : typeof raw === 'string' ? 'base64'
        : raw instanceof ArrayBuffer ? 'arraybuffer'
        : typeof raw;
      if (dataType !== streamLoggedTypeRef.current) {
        streamLoggedTypeRef.current = dataType;
        // eslint-disable-next-line no-console
        console.log(`[AudioStream] dataType=${dataType} raw.length=${raw?.length ?? '?'} sampleRate=${(event as any).sampleRate ?? '?'}`);
      }

      if (raw instanceof Float32Array) {
        data = raw;
      } else if (Array.isArray(raw)) {
        data = Float32Array.from(raw as number[]);
      } else if (raw instanceof ArrayBuffer) {
        data = new Float32Array(raw);
      } else if (typeof raw === 'string') {
        // Base64-encoded PCM float32 — decode it
        try {
          const bin = globalThis.atob ? globalThis.atob(raw) : '';
          const buf = new ArrayBuffer(bin.length);
          const view = new Uint8Array(buf);
          for (let i = 0; i < bin.length; i++) view[i] = bin.charCodeAt(i);
          // encoding='pcm_32bit' streamFormat='float32' → Float32Array
          data = new Float32Array(buf);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn('[AudioStream] base64 decode fail', String((err as any)?.message || err));
          return;
        }
      } else {
        // eslint-disable-next-line no-console
        console.warn(`[AudioStream] tipo desconhecido: ${dataType}`);
        return;
      }

      if (!data || data.length === 0) return;

      // Counter for diagnostic (logged every ~100 frames = 10s)
      streamFrameCountRef.current++;
      if (streamFrameCountRef.current % 100 === 0) {
        // eslint-disable-next-line no-console
        console.log(`[AudioStream] ${streamFrameCountRef.current} frames processados. Ring cheio: ${captureRingFilledRef.current}/${captureRingRef.current.length} samples`);
      }

      // Capture to continuous ring buffer (writer always on) ──────
      const cap = captureRingRef.current;
      const capCapacity = cap.length;
      let capPos = captureRingPosRef.current;
      for (let i = 0; i < data.length; i++) {
        cap[capPos] = data[i];
        capPos++;
        if (capPos >= capCapacity) capPos = 0;
      }
      captureRingPosRef.current = capPos;
      captureRingFilledRef.current = Math.min(
        captureRingFilledRef.current + data.length,
        capCapacity
      );

      // Ring buffer + YIN per-frame ────────────────────────────────
      const ring = ringRef.current;
      const len = ringLenRef.current;

      let newLen = len + data.length;
      if (newLen > RING_CAPACITY) {
        const keep = RING_CAPACITY - data.length;
        if (keep > 0) {
          ring.copyWithin(0, len - keep, len);
          ring.set(data, keep);
          newLen = RING_CAPACITY;
        } else {
          ring.set(data.subarray(data.length - RING_CAPACITY), 0);
          newLen = RING_CAPACITY;
        }
      } else {
        ring.set(data, len);
      }

      let offset = 0;
      while (newLen - offset >= FRAME_SIZE) {
        const frame = ring.subarray(offset, offset + FRAME_SIZE);
        runYinOnFrame(frame, SAMPLE_RATE);
        offset += FRAME_SIZE;
      }

      const remaining = newLen - offset;
      if (remaining > 0 && offset > 0) {
        ring.copyWithin(0, offset, newLen);
      }
      ringLenRef.current = remaining;
    },
    [runYinOnFrame]
  );

  // ── Stop ─────────────────────────────────────────────────────────
  const stop = useCallback(async () => {
    if (!activeRef.current && !isStartingRef.current) return;
    activeRef.current = false;
    ringLenRef.current = 0;
    try {
      const rec: any = recorderRef.current;
      if (rec?.stopRecording) {
        await rec.stopRecording();
      }
    } catch (e: any) {
      console.warn('[AudioEngine][STOP] stopRecording() falhou:', String(e?.message || e));
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }, []);

  // ── Start ────────────────────────────────────────────────────────
  const start = useCallback(
    async (onPitch: PitchCallback, onError: ErrorCallback): Promise<boolean> => {
      if (isStartingRef.current) return false;
      if (activeRef.current) await stop();

      isStartingRef.current = true;
      onPitchRef.current = onPitch;
      onErrorRef.current = onError;
      ringLenRef.current = 0;

      try {
        // 1) Permission (shows OS prompt if needed)
        const perm = await ensureMicPermission();
        if (perm === 'blocked') {
          isStartingRef.current = false;
          onError(
            'Permita o acesso ao microfone nas configurações do aparelho.',
            'permission_blocked'
          );
          return false;
        }
        if (perm === 'denied') {
          isStartingRef.current = false;
          onError('Permissão de microfone negada.', 'permission_denied');
          return false;
        }

        // 2) Start recording — NOW using the hook's startRecording
        const rec: any = recorderRef.current;
        if (!rec || typeof rec.startRecording !== 'function') {
          isStartingRef.current = false;
          console.error('[AudioEngine] useAudioRecorder did not return startRecording()', {
            hasRec: !!rec,
            keys: rec ? Object.keys(rec) : [],
            platform: Platform.OS,
          });
          onError(
            'Falha ao inicializar o gravador de áudio.',
            'platform_limit'
          );
          return false;
        }

        await rec.startRecording({
          sampleRate: SAMPLE_RATE,
          channels: 1,
          encoding: 'pcm_32bit',
          streamFormat: 'float32',
          interval: STREAM_INTERVAL_MS,
          keepAwake: true,
          android: { audioSource: 'unprocessed' } as any,
          ios: { audioSession: { category: 'PlayAndRecord', mode: 'measurement' } } as any,
          onAudioStream: handleAudioStream,
        } as any);

        activeRef.current = true;
        isStartingRef.current = false;
        return true;
      } catch (err: any) {
        activeRef.current = false;
        isStartingRef.current = false;
        const msg = String(err?.message || err || '');
        console.error('[AudioEngine][START] exception:', msg);

        let reason: PitchErrorReason = 'unknown';
        let userMsg = 'Não foi possível iniciar o microfone.';
        if (/permission|denied|NotAllowed/i.test(msg)) {
          reason = 'permission_denied';
          userMsg = 'Permissão de microfone negada.';
        } else if (/block/i.test(msg)) {
          reason = 'permission_blocked';
          userMsg = 'Microfone bloqueado nas configurações do sistema.';
        } else if (/not.*support|nativemodule|unavailable|TurboModule|RNCAudio/i.test(msg)) {
          reason = 'platform_limit';
          userMsg = 'Recurso de áudio indisponível. Atualize o app.';
        } else {
          userMsg = `Erro no microfone: ${msg.slice(0, 80)}`;
        }
        onError(userMsg, reason);
        return false;
      }
    },
    [stop, handleAudioStream]
  );

  // ── Misc helpers ─────────────────────────────────────────────────
  const setSoftInfoHandler = useCallback((handler: (msg: string) => void) => {
    softInfoRef.current = handler;
  }, []);

  const captureClip = useCallback(async (durationMs: number): Promise<CapturedClip | null> => {
    if (!activeRef.current) return null;
    // Snapshot INSTANTÂNEO do ring buffer contínuo — sem esperar acumular
    const wantSamples = Math.min(
      captureRingFilledRef.current,
      Math.round((durationMs / 1000) * SAMPLE_RATE)
    );
    // TURBO: reduzido para 1s mínimo (era 2s) para detecção mais rápida
    if (wantSamples < SAMPLE_RATE * 1) {
      // menos de 1s disponíveis ainda — ring ainda enchendo
      return null;
    }
    const cap = captureRingRef.current;
    const capCapacity = cap.length;
    const pos = captureRingPosRef.current;
    const merged = new Float32Array(wantSamples);
    // O end do ring (últimos escritos) é logo antes de `pos` — queremos os últimos N samples
    const startIdx = (pos - wantSamples + capCapacity) % capCapacity;
    if (startIdx + wantSamples <= capCapacity) {
      merged.set(cap.subarray(startIdx, startIdx + wantSamples));
    } else {
      const tail = capCapacity - startIdx;
      merged.set(cap.subarray(startIdx, capCapacity), 0);
      merged.set(cap.subarray(0, wantSamples - tail), tail);
    }
    return {
      samples: merged,
      sampleRate: SAMPLE_RATE,
      durationMs: (wantSamples / SAMPLE_RATE) * 1000,
    };
  }, []);

  const isCapturing = useCallback(() => false, []);

  return {
    isSupported: Platform.OS !== 'web',
    start,
    stop,
    setSoftInfoHandler,
    captureClip,
    isCapturing,
  };
}
