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

  const captureActiveRef = useRef(false);
  const captureBuffersRef = useRef<Float32Array[]>([]);
  const captureTotalSamplesRef = useRef(0);
  const captureMaxSamplesRef = useRef(0);
  const captureResolveRef = useRef<((clip: CapturedClip | null) => void) | null>(null);

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
  const handleAudioStream = useCallback(
    async (event: AudioDataEvent) => {
      if (!activeRef.current) return;
      const raw = (event as any).data;
      // Normalize to Float32Array — native may deliver Float32Array (Android JSI),
      // Array<number> (iOS JS bridge), or base64 string (when streamFormat='raw').
      let data: Float32Array | null = null;
      if (raw instanceof Float32Array) {
        data = raw;
      } else if (Array.isArray(raw)) {
        data = Float32Array.from(raw as number[]);
      } else {
        return; // base64 not supported — we requested streamFormat='float32'
      }

      // Capture to clip (for ML analysis) ─────────────────────────
      if (captureActiveRef.current) {
        const cloned = new Float32Array(data.length);
        cloned.set(data);
        captureBuffersRef.current.push(cloned);
        captureTotalSamplesRef.current += cloned.length;
        if (
          captureMaxSamplesRef.current > 0 &&
          captureTotalSamplesRef.current >= captureMaxSamplesRef.current
        ) {
          const total = captureTotalSamplesRef.current;
          const merged = new Float32Array(total);
          let off = 0;
          for (const buf of captureBuffersRef.current) {
            merged.set(buf, off);
            off += buf.length;
          }
          captureActiveRef.current = false;
          captureBuffersRef.current = [];
          captureTotalSamplesRef.current = 0;
          captureMaxSamplesRef.current = 0;
          const resolver = captureResolveRef.current;
          captureResolveRef.current = null;
          if (resolver) {
            resolver({
              samples: merged,
              sampleRate: SAMPLE_RATE,
              durationMs: (total / SAMPLE_RATE) * 1000,
            });
          }
        }
      }

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
    if (captureActiveRef.current) return null;
    const targetSamples = Math.round((durationMs / 1000) * SAMPLE_RATE);
    captureBuffersRef.current = [];
    captureTotalSamplesRef.current = 0;
    captureMaxSamplesRef.current = targetSamples;
    return new Promise((resolve) => {
      captureResolveRef.current = resolve;
      captureActiveRef.current = true;
      setTimeout(() => {
        if (captureActiveRef.current && captureResolveRef.current === resolve) {
          const total = captureTotalSamplesRef.current;
          if (total > 0) {
            const merged = new Float32Array(total);
            let off = 0;
            for (const buf of captureBuffersRef.current) {
              merged.set(buf, off);
              off += buf.length;
            }
            captureResolveRef.current = null;
            captureActiveRef.current = false;
            captureBuffersRef.current = [];
            captureTotalSamplesRef.current = 0;
            resolve({
              samples: merged,
              sampleRate: SAMPLE_RATE,
              durationMs: (total / SAMPLE_RATE) * 1000,
            });
          } else {
            captureActiveRef.current = false;
            captureResolveRef.current = null;
            resolve(null);
          }
        }
      }, durationMs * 2 + 1000);
    });
  }, []);

  const isCapturing = useCallback(() => captureActiveRef.current, []);

  return {
    isSupported: Platform.OS !== 'web',
    start,
    stop,
    setSoftInfoHandler,
    captureClip,
    isCapturing,
  };
}
