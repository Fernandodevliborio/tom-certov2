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
 * NOVO — Estado de filtragem de ruído reportado pela camada vocal_focus
 * (aplicada antes do motor tonal CREPE).
 *
 *   stage:
 *     'clean'      → áudio limpo, evidência tonal forte
 *     'noisy'      → ruído ambiente prejudicando, mas com voz residual
 *     'percussion' → percussão / cliques / impulsos sem pitch sustentado
 *     'silence'    → microfone praticamente mudo
 *
 *   passed:
 *     true  → o clip alimentou o motor tonal
 *     false → o clip foi descartado (sem efeito no resultado acumulado)
 */
export type NoiseStage = 'clean' | 'noisy' | 'percussion' | 'silence';

export interface NoiseRejectionState {
  enabled: boolean;
  stage: NoiseStage;
  passed: boolean;
  quality_score: number;     // 0..1 — válidos × confiança média
  valid_ratio: number;       // 0..1 — frames válidos / total
  rejection_reason: string | null;
  total_frames: number;
  valid_frames: number;
  rejected_frames: number;
  rejection_counts: Record<string, number>;
  processing_ms: number;
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

  // NOVO — estado da camada vocal_focus / noise_rejection
  noise_rejection?: NoiseRejectionState;
  clip_rejected?: boolean;
  
  // NOVO v8: Estado de travamento (histerese)
  locked?: boolean;
  locked_for_seconds?: number;
  accumulated_analyses?: number;
  
  // v10.2 — Progresso de warmup para UX (barra "1/4 → 4/4")
  warmup_progress?: {
    current: number;       // análises feitas (cap em target)
    target: number;        // total necessário antes de liberar lock (geralmente 4)
    is_warming_up: boolean; // true enquanto current < target e ainda não travou
  };
  
  // v13 — Máquina de estados por TEMPO decorrido (novo fluxo UX)
  // Controla o que o usuário vê em cada faixa temporal:
  //   listening  (0-10s):  "Ouvindo…"
  //   analyzing  (10-30s): "Analisando padrão melódico…"
  //   confirmed  (30s+):   "Tom confirmado" (se critérios rigorosos)
  //   uncertain  (30s+):   "Continue cantando mais alguns segundos…"
  stage?: 'listening' | 'analyzing' | 'probable' | 'confirmed' | 'uncertain' | 'needs_more' | 'decision';
  stage_label?: string;   // texto já formatado em pt-BR
  stage_hint?: string;    // sub-mensagem opcional
  show_key?: boolean;     // se true, frontend pode exibir tonic/key_name
  elapsed_s?: number;     // tempo desde o início da sessão
  window_s?: number;      // janela total (30s)
  window_progress?: number; // [0..1] progresso na janela
  failing_criteria?: string[]; // motivos da decisão incerta
  criteria?: {             // evidências usadas na decisão confirmada
    margin_ratio?: number;
    cadence?: number;
    third_ratio?: number;
    confidence?: number;
    consensus_votes?: number;
  };
  ambiguity?: {
    margin_ratio: number;
    is_ambiguous_hard: boolean;
    is_relative_ambiguous: boolean;
    is_dominant_ambiguous: boolean;
  };
  
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
  externalSignal?: AbortSignal,
): Promise<MLAnalysisResult> {
  const wav = float32ToWav(clip.samples, clip.sampleRate);
  const base = getBackendUrl();
  if (!base) {
    return { success: false, error: 'no_backend', message: 'URL do backend não configurada.' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // Encadeia o sinal externo (pra cancelar de fora — em stop/reset)
  let externalListener: (() => void) | null = null;
  if (externalSignal) {
    if (externalSignal.aborted) {
      clearTimeout(timer);
      return { success: false, error: 'cancelled', message: 'Análise cancelada antes do envio.' };
    }
    externalListener = () => controller.abort();
    externalSignal.addEventListener('abort', externalListener);
  }

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
    if (externalListener && externalSignal) {
      externalSignal.removeEventListener('abort', externalListener);
    }
    const data: MLAnalysisResult = await res.json();
    if (!res.ok) {
      return { success: false, error: 'http_error', message: data?.message || `HTTP ${res.status}` };
    }
    return data;
  } catch (err: any) {
    clearTimeout(timer);
    if (externalListener && externalSignal) {
      externalSignal.removeEventListener('abort', externalListener);
    }
    if (err?.name === 'AbortError') {
      // Distingue cancelamento externo de timeout interno
      if (externalSignal?.aborted) {
        return { success: false, error: 'cancelled', message: 'Análise cancelada.' };
      }
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
