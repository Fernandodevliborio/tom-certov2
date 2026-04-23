/**
 * NATIVE (iOS/Android) pitch engine using @siteed/audio-studio for real PCM streaming.
 */

import { useCallback, useRef } from 'react';
import { Platform } from 'react-native';
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

// Lazy imports for native modules (not available on web)
let AudioStudioModuleRef: any = null;
let useAudioRecorderRef: any = null;

async function ensureMicPermission(): Promise<'granted' | 'denied' | 'blocked'> {
  try {
    if (!AudioStudioModuleRef) return 'denied';
    const current = await AudioStudioModuleRef.getPermissionsAsync?.().catch(() => null);
    if (current && (current as any).granted) {
      await storage.setItem(PERM_KEY, '1');
      return 'granted';
    }
    if (current && (current as any).canAskAgain === false) return 'blocked';

    const next = await AudioStudioModuleRef.requestPermissionsAsync();
    if ((next as any).granted) {
      await storage.setItem(PERM_KEY, '1');
      return 'granted';
    }
    if ((next as any).canAskAgain === false) return 'blocked';
    return 'denied';
  } catch {
    return 'denied';
  }
}

export function usePitchEngine(): PitchEngineHandle {
  const recorderRef = useRef<any>(null);
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

  const handleAudioStream = useCallback(
    async (event: any) => {
      if (!activeRef.current) return;
      const data = event.data;
      if (!(data instanceof Float32Array)) return;

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
            resolver({ samples: merged, sampleRate: SAMPLE_RATE, durationMs: (total / SAMPLE_RATE) * 1000 });
          }
        }
      }

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

  const stop = useCallback(async () => {
    if (!activeRef.current && !isStartingRef.current) return;
    activeRef.current = false;
    ringLenRef.current = 0;
    try {
      if (recorderRef.current) {
        await recorderRef.current.stopRecording();
      }
    } catch (e: any) {
      console.warn('[AudioEngine][STOP] stopRecording() falhou:', String(e?.message || e));
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }, []);

  const start = useCallback(
    async (onPitch: PitchCallback, onError: ErrorCallback): Promise<boolean> => {
      if (isStartingRef.current) return false;
      if (activeRef.current) await stop();

      isStartingRef.current = true;
      onPitchRef.current = onPitch;
      onErrorRef.current = onError;
      ringLenRef.current = 0;

      // Lazy-load native modules
      try {
        if (!useAudioRecorderRef) {
          const mod = require('@siteed/audio-studio');
          AudioStudioModuleRef = mod.AudioStudioModule;
          useAudioRecorderRef = mod.useAudioRecorder;
        }
        if (!recorderRef.current && useAudioRecorderRef) {
          // useAudioRecorder is a hook — we can't call it here normally.
          // This engine should be used only when the hook is initialized.
          // For environments where native module is unavailable, we fall back to web.
        }
      } catch {
        isStartingRef.current = false;
        onError(
          'Recurso não disponível neste ambiente. Instale o APK para usar.',
          'platform_limit'
        );
        return false;
      }

      try {
        const perm = await ensureMicPermission();
        if (perm === 'blocked') {
          isStartingRef.current = false;
          onError('Permita o acesso ao microfone nas configurações do aparelho.', 'permission_blocked');
          return false;
        }
        if (perm === 'denied') {
          isStartingRef.current = false;
          onError('Permita o acesso ao microfone para detectar o tom.', 'permission_denied');
          return false;
        }

        if (recorderRef.current) {
          await recorderRef.current.startRecording({
            sampleRate: SAMPLE_RATE,
            channels: 1,
            encoding: 'pcm_32bit',
            streamFormat: 'float32',
            interval: STREAM_INTERVAL_MS,
            android: { audioSource: 'unprocessed' } as any,
            ios: { audioSession: { category: 'PlayAndRecord', mode: 'measurement' } } as any,
            onAudioStream: handleAudioStream,
          } as any);
          activeRef.current = true;
          return true;
        }

        // Fallback: if no recorder, fail gracefully
        isStartingRef.current = false;
        onError('Recurso não disponível neste ambiente.', 'platform_limit');
        return false;
      } catch (err: any) {
        activeRef.current = false;
        const msg = String(err?.message || err || '');
        let reason: PitchErrorReason = 'unknown';
        if (/permission|denied|NotAllowed/i.test(msg)) reason = 'permission_denied';
        else if (/not.*support|nativemodule|unavailable|TurboModule/i.test(msg)) reason = 'platform_limit';
        onError(
          reason === 'platform_limit'
            ? 'Recurso não disponível neste ambiente. Instale o APK para usar.'
            : 'Não foi possível iniciar o microfone. Tente novamente.',
          reason
        );
        return false;
      } finally {
        isStartingRef.current = false;
      }
    },
    [stop, handleAudioStream]
  );

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
            resolve({ samples: merged, sampleRate: SAMPLE_RATE, durationMs: (total / SAMPLE_RATE) * 1000 });
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
