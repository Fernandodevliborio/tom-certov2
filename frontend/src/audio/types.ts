// Shared types for pitch engine across platforms.

export type PitchErrorReason =
  | 'permission_denied'
  | 'permission_blocked'
  | 'platform_limit'
  | 'unknown';

export interface PitchEvent {
  pitchClass: number;
  frequency: number;
  rms: number;
  clarity: number;
}

export type PitchCallback = (e: PitchEvent) => void;
export type ErrorCallback = (msg: string, reason: PitchErrorReason) => void;

export interface CapturedClip {
  samples: Float32Array; // concat de todos chunks capturados
  sampleRate: number;
  durationMs: number;
}

// Saúde do recorder em tempo real — usado pelo Pipeline Health Watchdog
export interface AudioEngineHealth {
  alive: boolean;            // recorder rodando E recebendo frames recentes (<5s)
  active: boolean;           // recorder está ATIVO (start chamado, sem stop)
  lastFrameAgeMs: number;    // ms desde o último frame de áudio recebido
  framesPerSec: number;      // taxa medida na última janela
  totalFrames: number;       // contador acumulado (diagnóstico)
  lastRms: number;           // RMS do último frame (0 se silêncio)
  ringFilledSamples: number; // samples disponíveis no ring contínuo
}

export interface PitchEngineHandle {
  isSupported: boolean;
  start: (onPitch: PitchCallback, onError: ErrorCallback) => Promise<boolean>;
  stop: () => Promise<void>;
  setSoftInfoHandler?: (handler: (msg: string) => void) => void;
  // ─── Captura em paralelo (pra análise ML no backend) ────────────────
  captureClip?: (durationMs: number) => Promise<CapturedClip | null>;
  isCapturing?: () => boolean;
  // ─── NOVO: Audio Health Watchdog ─────────────────────────────────────
  getHealth?: () => AudioEngineHealth;
  restart?: () => Promise<boolean>;  // destrói + recria o recorder do zero
}
