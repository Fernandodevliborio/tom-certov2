// ═══════════════════════════════════════════════════════════════════════
// mlKeyAnalyzer.ts — Envia clip de áudio ao backend e recebe tonalidade
// ═══════════════════════════════════════════════════════════════════════

import Constants from 'expo-constants';
import type { CapturedClip } from '../audio/types';

// URLs do backend de produção. A ordem importa — se a primária falhar
// (404, DNS, timeout), a secundária é tentada automaticamente.
// FASE 1.5: descoberto que APK v3.17.0 foi buildado quando o EXPO_PUBLIC_BACKEND_URL
// apontava para uma URL morta. Sem fallback automático, o app travava em "Ouvindo..."
// para sempre. Agora, qualquer erro de rede ou 4xx/5xx escala para a próxima URL.
const FALLBACK_BACKEND_URLS = [
  'https://tomcerto.online',
  'https://tom-certov2-production.up.railway.app',
];
const PROD_BACKEND_URL = FALLBACK_BACKEND_URLS[0];

// URL primária = vinda do build env. Tentada primeiro. Se 404/falha, fallback.
function getPrimaryBackendUrl(): string {
  const url =
    (process.env.EXPO_PUBLIC_BACKEND_URL as string | undefined) ||
    (Constants.expoConfig?.extra as any)?.backendUrl ||
    PROD_BACKEND_URL;
  return (url || '').replace(/\/+$/g, '');
}

// Lista de URLs a tentar em ordem (primária + fallbacks únicos)
function getBackendUrlChain(): string[] {
  const primary = getPrimaryBackendUrl();
  const chain = [primary];
  for (const fb of FALLBACK_BACKEND_URLS) {
    if (fb && !chain.includes(fb)) chain.push(fb);
  }
  return chain;
}

// Retrocompat: getBackendUrl continua retornando apenas a primária para
// callers que não querem fallback (ex.: resetKeyAnalysisSession).
function getBackendUrl(): string {
  return getPrimaryBackendUrl();
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

  // NOVO — modo ativo (echo do header X-Detection-Mode enviado)
  mode?: 'vocal' | 'vocal_instrument';

  // NOVO — evidência instrumental (apenas presente quando mode='vocal_instrument')
  instrument_evidence?: {
    chords: Array<{
      pc: number;
      quality: 'major' | 'minor';
      dur_ms: number;
      strength: number;
      start_s: number;
    }>;
    bass_notes: Array<{
      pc: number;
      dur_ms: number;
      strength: number;
      start_s: number;
    }>;
  };

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
  // FASE 1.5: timeout aumentado de 12s → 25s.
  // Servidores em cold start (Railway, etc.) podem demorar 15-20s na primeira
  // requisição. 12s era curto demais e provocava timeouts em cascata que
  // mascaravam o sucesso real do backend e causavam travamento em "Ouvindo...".
  timeoutMs: number = 25000,
  deviceId?: string,
  externalSignal?: AbortSignal,
  mode?: 'vocal' | 'vocal_instrument',
  sessionId?: string,
): Promise<MLAnalysisResult> {
  const wav = float32ToWav(clip.samples, clip.sampleRate);
  const urls = getBackendUrlChain();
  if (urls.length === 0) {
    return { success: false, error: 'no_backend', message: 'URL do backend não configurada.' };
  }

  // Cancelamento externo (stop / reset)
  let externalListener: (() => void) | null = null;
  let externalCancelled = false;
  if (externalSignal) {
    if (externalSignal.aborted) {
      return { success: false, error: 'cancelled', message: 'Análise cancelada antes do envio.' };
    }
    externalListener = () => { externalCancelled = true; };
    externalSignal.addEventListener('abort', externalListener);
  }

  const headers: Record<string, string> = { 'Content-Type': 'audio/wav' };
  if (deviceId) headers['X-Device-Id'] = deviceId;
  if (mode === 'vocal' || mode === 'vocal_instrument') {
    headers['X-Detection-Mode'] = mode;
  }
  if (sessionId) headers['X-Session-Id'] = sessionId;

  // FASE 1.5: tenta cada URL na cadeia. Pula para a próxima em caso de
  // 404 (rota não existe = backend morto/errado), 5xx, network error ou DNS.
  // Mantém o último erro para reportar no final.
  let lastError: MLAnalysisResult = {
    success: false,
    error: 'no_backend',
    message: 'Nenhum backend respondeu.',
  };

  for (let i = 0; i < urls.length; i++) {
    if (externalCancelled || externalSignal?.aborted) {
      if (externalListener && externalSignal) {
        externalSignal.removeEventListener('abort', externalListener);
      }
      return { success: false, error: 'cancelled', message: 'Análise cancelada.' };
    }

    const base = urls[i];
    const controller = new AbortController();
    // Encadeia cancelamento externo no controller atual
    const cancelHandler = () => controller.abort();
    if (externalSignal) externalSignal.addEventListener('abort', cancelHandler);
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(`${base}/api/analyze-key`, {
        method: 'POST',
        headers,
        body: wav as any,
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (externalSignal) externalSignal.removeEventListener('abort', cancelHandler);

      const data: MLAnalysisResult = await res.json().catch(() => ({ success: false } as any));
      if (!res.ok) {
        const status = res.status;
        lastError = {
          success: false,
          error: 'http_error',
          message: (data as any)?.message || `HTTP ${status}`,
        };
        // 404/5xx → tenta próximo URL
        if (status === 404 || status >= 500) continue;
        // Outros erros (400, 403, etc.) — não adianta tentar fallback
        if (externalListener && externalSignal) {
          externalSignal.removeEventListener('abort', externalListener);
        }
        return lastError;
      }
      if (externalListener && externalSignal) {
        externalSignal.removeEventListener('abort', externalListener);
      }
      return data;
    } catch (err: any) {
      clearTimeout(timer);
      if (externalSignal) externalSignal.removeEventListener('abort', cancelHandler);
      if (err?.name === 'AbortError') {
        if (externalCancelled || externalSignal?.aborted) {
          if (externalListener && externalSignal) {
            externalSignal.removeEventListener('abort', externalListener);
          }
          return { success: false, error: 'cancelled', message: 'Análise cancelada.' };
        }
        // Timeout: registra e tenta próximo
        lastError = { success: false, error: 'timeout', message: 'Tempo esgotado.' };
        continue;
      }
      // Erro de rede/DNS — registra e tenta próximo
      lastError = {
        success: false,
        error: 'network',
        message: err?.message || 'Erro de rede.',
      };
      continue;
    }
  }

  // Esgotou todos os URLs sem sucesso
  if (externalListener && externalSignal) {
    externalSignal.removeEventListener('abort', externalListener);
  }
  return lastError;
}


/**
 * Reseta o acumulador de PCP da sessão atual no backend.
 * Chamado quando usuário inicia nova captura (botão START).
 * FASE 1.5: percorre o chain de URLs até uma responder OK.
 */
export async function resetKeyAnalysisSession(
  deviceId?: string,
  mode?: 'vocal' | 'vocal_instrument',
  sessionId?: string,
): Promise<boolean> {
  const urls = getBackendUrlChain();
  if (urls.length === 0) return false;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (deviceId) headers['X-Device-Id'] = deviceId;
  if (mode === 'vocal' || mode === 'vocal_instrument') {
    headers['X-Detection-Mode'] = mode;
  }
  if (sessionId) headers['X-Session-Id'] = sessionId;

  for (const base of urls) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(`${base}/api/analyze-key/reset`, {
        method: 'POST',
        headers,
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (res.ok) return true;
      // 404 → tenta próxima
      if (res.status === 404 || res.status >= 500) continue;
      return false;
    } catch {
      clearTimeout(timer);
      continue;
    }
  }
  return false;
}
