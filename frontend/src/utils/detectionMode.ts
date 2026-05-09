// ═══════════════════════════════════════════════════════════════════════════
// detectionMode.ts — Persistência do modo de detecção (vocal | vocal_instrument)
// ═══════════════════════════════════════════════════════════════════════════
//
// Default: 'vocal' (modo Voz / A capela — comportamento atual preservado).
// Persistido em AsyncStorage. Trocar de modo gera hardReset automático no hook.
// ═══════════════════════════════════════════════════════════════════════════

import * as storage from '../auth/storage';

export type DetectionMode = 'vocal' | 'vocal_instrument';

const STORAGE_KEY = 'tom_certo_detection_mode';
const DEFAULT_MODE: DetectionMode = 'vocal';

export const DETECTION_MODE_LABEL: Record<DetectionMode, string> = {
  vocal: 'Voz / A capela',
  vocal_instrument: 'Voz + Instrumento',
};

export const DETECTION_MODE_DESC: Record<DetectionMode, string> = {
  vocal: 'Para canto sem acompanhamento. Detecção mais sensível à voz pura.',
  vocal_instrument: 'Voz com violão, guitarra, teclado ou piano. Usa acordes e baixo como evidência.',
};

export async function loadDetectionMode(): Promise<DetectionMode> {
  try {
    const raw = await storage.getItem(STORAGE_KEY);
    if (raw === 'vocal' || raw === 'vocal_instrument') return raw;
  } catch {
    /* noop */
  }
  return DEFAULT_MODE;
}

export async function saveDetectionMode(mode: DetectionMode): Promise<void> {
  try {
    await storage.setItem(STORAGE_KEY, mode);
  } catch {
    /* noop */
  }
}
