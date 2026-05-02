// ═══════════════════════════════════════════════════════════════════════
// mlKeyAnalyzer.ts — Envia clip de áudio ao backend e recebe tonalidade
// ═══════════════════════════════════════════════════════════════════════

import Constants from 'expo-constants';
import type { CapturedClip } from '../audio/types';

const PROD_BACKEND_URL = 'https://tomcerto.online';

function getBackendUrl(): string {
  const url =
    (process.env.EXPO_PUBLIC_BACKEND_URL as string | undefined) ||
    (Constants.expoConfig?.extra as any)?.backendUrl ||
    PROD_BACKEND_URL;
  return (url || '').replace(/\/+$/g, '');
}

export function float32ToWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const numSamples = samples.length;
  const numChannels = 1;
  const bytesPerSample = 2;
  const dataSize = numSamples * numChannels * bytesPerSample;
  const bufferSize = 44 + dataSize;
  const buf = new ArrayBuffer(bufferSize);
  const view = new DataView(buf);

  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * bytesPerSample, true);
  view.setUint16(32, numChannels * bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    offset += 2;
  }

  return new Uint8Array(buf);
}

function writeString(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

/**
 * Resultado da análise ML com Tribunal de Evidências v8
 */
export interface MLAnalysisResult {
  success: boolean;
  duration_s?: number;
  notes_count?: number;
  phrases_count?: number;
  valid_f0_frames?: number;
  f0_frames?: number;
  method?: string;
  tonic?: number;
  tonic_name?: string;
  quality?: 'major' | 'minor';
  key_name?: string;
  confidence?: number;
  
  // NOVO v8: Estado de travamento (histerese)
  locked?: boolean;
  locked_for_seconds?: number;
  accumulated_analyses?: number;
  
  // Breakdown de confiança v8
  confidence_breakdown?: {
    combined_score?: number;
    margin?: number;
    mode_confidence?: number;
    // Legacy (v7 e anteriores)
    third?: number;
    material?: number;
    alignment?: number;
    cadence?: number;
  };
  
  // NOVO v8: Votos dos jurados
  votes?: {
    krumhansl?: Record<string, number>;
    cadences?: Record<string, number>;
    gravity?: Record<string, number>;
    combined?: Record<string, number>;
  };
  
  // NOVO v8: Cadências detectadas
  cadences_found?: Array<{
    type: string;  // 'V→I', 'IV→I', 'II→V→I'
    resolved_to: string;
    strength: number;
  }>;
  
  // NOVO v8: Evidência da 3ª (modo maior/menor)
  third_evidence?: {
    major_3rd_pc?: number;
    minor_3rd_pc?: number;
    major_3rd_weight?: number;
    minor_3rd_weight?: number;
    major_3rd_present?: boolean;
    minor_3rd_present?: boolean;
    major_3rd_ratio?: number;
    decision_reason?: string;
  };
  
  flags?: Array<
    'close_call' | 'no_third_evidence' | 'ambiguous_third' |
    'few_notes' | 'single_phrase' | 'no_resolution' | 'relative_ambiguous' |
    'no_cadences'  // NOVO v8
  >;
  
  recommendation?: 'keep_analyzing' | 'uncertain_suggest_more_audio' | 'confident';
  
  // Top candidatos v8
  top_candidates?: Array<{
    tonic_pc?: number;
    tonic_name?: string;
    key?: string;  // legacy
    score: number;
    ks?: number;
    cad?: number;
    grav?: number;
    // Legacy
    cadence?: number;
    third_mul?: number;
    third_ratio?: number;
    alignment?: number;
    boost?: number;
    correlation?: number;
  }>;
  
  // Estatísticas
  stats?: {
    notes_count?: number;
    phrases_count?: number;
    pcp_total?: number;
  };
  
  margin_abs?: number;
  margin_relative?: number;
  margin?: number; // legacy
  error?: string;
  message?: string;
}

export async function analyzeKeyML(
  clip: CapturedClip,
  timeoutMs: number = 12000,  // FIX: 30s era longo demais — CREPE tiny deve responder em <10s
  deviceId?: string,
): Promise<MLAnalysisResult> {
  const wav = float32ToWav(clip.samples, clip.sampleRate);
  const base = getBackendUrl();
  if (!base) {
    return { success: false, error: 'no_backend', message: 'URL do backend não configurada.' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const headers: Record<string, string> = { 'Content-Type': 'audio/wav' };
  if (deviceId) headers['X-Device-Id'] = deviceId;

  try {
    const res = await fetch(`${base}/api/analyze-key`, {
      method: 'POST',
      headers,
      body: wav as any,
      signal: controller.signal,
    });
    clearTimeout(timer);
    const data: MLAnalysisResult = await res.json();
    if (!res.ok) {
      return { success: false, error: 'http_error', message: data?.message || `HTTP ${res.status}` };
    }
    return data;
  } catch (err: any) {
    clearTimeout(timer);
    if (err?.name === 'AbortError') {
      return { success: false, error: 'timeout', message: 'Tempo esgotado. Tente novamente.' };
    }
    return { success: false, error: 'network', message: err?.message || 'Erro de rede.' };
  }
}


/**
 * Reseta o acumulador de PCP da sessão atual no backend.
 * Chamado quando usuário inicia nova captura (botão START).
 */
export async function resetKeyAnalysisSession(deviceId?: string): Promise<boolean> {
  const base = getBackendUrl();
  if (!base) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000); // 5s max — não trava o start
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (deviceId) headers['X-Device-Id'] = deviceId;
    const res = await fetch(`${base}/api/analyze-key/reset`, {
      method: 'POST',
      headers,
      signal: controller.signal,
    });
    clearTimeout(timer);
    return res.ok;
  } catch {
    clearTimeout(timer);
    return false;
  }
}
