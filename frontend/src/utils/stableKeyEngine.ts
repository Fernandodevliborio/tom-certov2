/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Tom Certo — Stable Key Detection Engine v2.0
 * ═══════════════════════════════════════════════════════════════════════════
 * 
 * Sistema de detecção de tom com máxima estabilidade e confiabilidade.
 * 
 * Princípios:
 * 1. Nunca mostrar tom cedo demais
 * 2. Sistema de estados progressivos antes de confirmar
 * 3. Histerese inteligente para evitar trocas repentinas
 * 4. Análise interna silenciosa (usuário não vê hipóteses fracas)
 * 5. Proteção contra confusão maior/menor relativo
 */

export const NOTE_NAMES_BR = ['Dó', 'Dó#', 'Ré', 'Ré#', 'Mi', 'Fá', 'Fá#', 'Sol', 'Sol#', 'Lá', 'Lá#', 'Si'];

// ═══════════════════════════════════════════════════════════════════════════
// TIPOS E INTERFACES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Estados internos do motor de detecção.
 * O usuário só vê o tom quando está em 'locked'.
 */
export type InternalStage = 
  | 'listening'        // Apenas ouvindo, nenhum candidato
  | 'candidate'        // Tem candidato, mas ainda não mostra
  | 'stableCandidate'  // Candidato estável por alguns segundos
  | 'locked';          // Tom travado e visível ao usuário

/**
 * O que o usuário vê na tela
 */
export type UserVisibleState = 
  | 'listening'        // "Ouvindo com inteligência..."
  | 'analyzing'        // "Analisando estabilidade do tom..."
  | 'confirmed';       // Tom visível

export interface KeyCandidate {
  tonic: number;
  quality: 'major' | 'minor';
  keyName: string;
  firstSeenAt: number;
  lastSeenAt: number;
  consecutiveHits: number;
  totalHits: number;
  maxConfidence: number;
  avgConfidence: number;
  confidenceSum: number;
}

export interface LockedKey {
  tonic: number;
  quality: 'major' | 'minor';
  keyName: string;
  lockedAt: number;
  confidence: number;
  totalAnalyses: number;
  stabilityScore: number;  // Aumenta com o tempo (dificulta troca)
}

export interface HiddenCandidate {
  tonic: number;
  quality: 'major' | 'minor';
  keyName: string;
  firstSeenAt: number;
  consecutiveHits: number;
  confidenceSum: number;
}

export interface StableKeyState {
  internalStage: InternalStage;
  
  // Candidato atual (não visível ao usuário até ser locked)
  currentCandidate: KeyCandidate | null;
  
  // Tom travado (visível ao usuário)
  lockedKey: LockedKey | null;
  
  // Candidato oculto para possível mudança (análise silenciosa)
  hiddenCandidate: HiddenCandidate | null;
  
  // Histórico de análises recentes
  analysisHistory: Array<{
    tonic: number;
    quality: 'major' | 'minor';
    confidence: number;
    at: number;
  }>;
  
  // Tempo total de detecção ativa
  detectionStartedAt: number;
  
  // Contador de análises totais
  totalAnalysesCount: number;
  
  // Confiança visual (o que o usuário vê)
  visualConfidence: number;
  
  // Mensagem de status para o usuário
  userMessage: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURAÇÕES DE ESTABILIDADE
// ═══════════════════════════════════════════════════════════════════════════

const CONFIG = {
  // Mínimo de análises consecutivas antes de considerar candidato
  MIN_HITS_FOR_CANDIDATE: 1,  // REDUZIDO de 2 para 1
  
  // Mínimo de análises consecutivas para candidato estável
  MIN_HITS_FOR_STABLE: 1,  // REDUZIDO de 2 para 1
  
  // Mínimo de análises consecutivas para travar tom
  MIN_HITS_FOR_LOCK: 2,    // REDUZIDO de 3 para 2
  
  // Confiança mínima para considerar análise válida
  MIN_CONFIDENCE_THRESHOLD: 0.15,  // REDUZIDO de 0.20 para 0.15
  
  // Confiança mínima para lock rápido (alta confiança)
  FAST_LOCK_CONFIDENCE: 0.35,  // REDUZIDO de 0.45 para 0.35
  
  // Tempo mínimo (ms) que candidato deve existir antes de travar
  MIN_CANDIDATE_DURATION_MS: 1000,  // REDUZIDO de 1800 para 1000
  
  // Tempo mínimo (ms) antes de permitir mudança de tom travado
  MIN_LOCK_DURATION_MS: 3000,  // REDUZIDO de 4000 para 3000
  
  // Margem de confiança para trocar tom travado
  CHANGE_CONFIDENCE_MARGIN: 0.10,  // REDUZIDO de 0.12 para 0.10
  
  // Mínimo de hits consecutivos do novo tom para considerar mudança
  MIN_HITS_FOR_CHANGE: 3,  // REDUZIDO de 4 para 3
  
  // Tempo máximo (ms) entre análises para manter candidato
  MAX_GAP_BETWEEN_ANALYSES_MS: 4000,  // AUMENTADO de 3000 para 4000
  
  // Multiplicadores de estabilidade por tempo de lock
  STABILITY_MULTIPLIERS: {
    UNDER_30S: 1.0,
    UNDER_60S: 1.2,
    UNDER_90S: 1.4,
    OVER_90S: 1.6,
  },
  
  // Confiança visual inicial após lock
  INITIAL_VISUAL_CONFIDENCE: 65,  // AUMENTADO de 62 para 65
  
  // Incremento de confiança visual por análise confirmada
  VISUAL_CONFIDENCE_INCREMENT: 8,  // AUMENTADO de 6 para 8
  
  // Confiança visual máxima
  MAX_VISUAL_CONFIDENCE: 98,
};

// ═══════════════════════════════════════════════════════════════════════════
// FUNÇÕES UTILITÁRIAS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Verifica se dois tons são relativos (maior ↔ menor)
 * Ex: Dó maior e Lá menor são relativos
 */
function areRelativeKeys(
  tonic1: number, quality1: 'major' | 'minor',
  tonic2: number, quality2: 'major' | 'minor'
): boolean {
  if (quality1 === quality2) return false;
  
  // Tom relativo menor está 3 semitons abaixo do maior
  // Dó maior (0) → Lá menor (9)
  if (quality1 === 'major' && quality2 === 'minor') {
    const expectedMinor = (tonic1 + 9) % 12;
    return tonic2 === expectedMinor;
  }
  
  // Tom relativo maior está 3 semitons acima do menor
  // Lá menor (9) → Dó maior (0)
  if (quality1 === 'minor' && quality2 === 'major') {
    const expectedMajor = (tonic1 + 3) % 12;
    return tonic2 === expectedMajor;
  }
  
  return false;
}

/**
 * Calcula o multiplicador de estabilidade baseado no tempo de lock
 */
function getStabilityMultiplier(lockedDurationMs: number): number {
  if (lockedDurationMs < 30000) return CONFIG.STABILITY_MULTIPLIERS.UNDER_30S;
  if (lockedDurationMs < 60000) return CONFIG.STABILITY_MULTIPLIERS.UNDER_60S;
  if (lockedDurationMs < 90000) return CONFIG.STABILITY_MULTIPLIERS.UNDER_90S;
  return CONFIG.STABILITY_MULTIPLIERS.OVER_90S;
}

/**
 * Gera chave única para um tom
 */
function keyId(tonic: number, quality: 'major' | 'minor'): string {
  return `${tonic}-${quality}`;
}

/**
 * Formata nome do tom
 */
function formatKeyName(tonic: number, quality: 'major' | 'minor'): string {
  return quality === 'major'
    ? `${NOTE_NAMES_BR[tonic]} Maior`
    : `${NOTE_NAMES_BR[tonic]} menor`;
}

/**
 * Determina a mensagem de status para o usuário
 */
function getUserMessage(state: StableKeyState): string {
  switch (state.internalStage) {
    case 'listening':
      return 'Ouvindo com inteligência…';
    case 'candidate':
      return 'Analisando estabilidade do tom…';
    case 'stableCandidate':
      return 'Confirmando detecção…';
    case 'locked':
      return 'Tom detectado';
    default:
      return 'Ouvindo…';
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// FUNÇÕES PRINCIPAIS DO ENGINE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Cria estado inicial do engine
 */
export function createStableKeyState(): StableKeyState {
  return {
    internalStage: 'listening',
    currentCandidate: null,
    lockedKey: null,
    hiddenCandidate: null,
    analysisHistory: [],
    detectionStartedAt: Date.now(),
    totalAnalysesCount: 0,
    visualConfidence: 0,
    userMessage: 'Ouvindo com inteligência…',
  };
}

/**
 * Processa uma nova análise ML e atualiza o estado
 */
export function processAnalysis(
  state: StableKeyState,
  analysis: {
    tonic: number;
    quality: 'major' | 'minor';
    confidence: number;
    keyName?: string;
  }
): StableKeyState {
  const now = Date.now();
  const { tonic, quality, confidence } = analysis;
  const keyName = analysis.keyName || formatKeyName(tonic, quality);
  
  // Ignorar análises com confiança muito baixa
  if (confidence < CONFIG.MIN_CONFIDENCE_THRESHOLD) {
    return {
      ...state,
      totalAnalysesCount: state.totalAnalysesCount + 1,
    };
  }
  
  // Adicionar ao histórico
  const newHistory = [
    ...state.analysisHistory.slice(-19),
    { tonic, quality, confidence, at: now },
  ];
  
  let newState = {
    ...state,
    analysisHistory: newHistory,
    totalAnalysesCount: state.totalAnalysesCount + 1,
  };
  
  // ═══════════════════════════════════════════════════════════════════
  // CASO 1: Já temos um tom travado
  // ═══════════════════════════════════════════════════════════════════
  if (state.lockedKey) {
    newState = processWithLockedKey(newState, tonic, quality, confidence, keyName, now);
  }
  // ═══════════════════════════════════════════════════════════════════
  // CASO 2: Ainda não temos tom travado
  // ═══════════════════════════════════════════════════════════════════
  else {
    newState = processWithoutLockedKey(newState, tonic, quality, confidence, keyName, now);
  }
  
  // Atualizar mensagem de status
  newState.userMessage = getUserMessage(newState);
  
  return newState;
}

/**
 * Processa análise quando já temos um tom travado
 */
function processWithLockedKey(
  state: StableKeyState,
  tonic: number,
  quality: 'major' | 'minor',
  confidence: number,
  keyName: string,
  now: number
): StableKeyState {
  const locked = state.lockedKey!;
  const isSameKey = locked.tonic === tonic && locked.quality === quality;
  
  // ═══ MESMO TOM: Reforçar confiança ═══
  if (isSameKey) {
    const newVisualConf = Math.min(
      CONFIG.MAX_VISUAL_CONFIDENCE,
      state.visualConfidence + CONFIG.VISUAL_CONFIDENCE_INCREMENT
    );
    
    return {
      ...state,
      lockedKey: {
        ...locked,
        totalAnalyses: locked.totalAnalyses + 1,
        confidence: Math.max(locked.confidence, confidence),
        stabilityScore: locked.stabilityScore + 1,
      },
      hiddenCandidate: null,  // Limpar candidato oculto
      visualConfidence: newVisualConf,
    };
  }
  
  // ═══ TOM DIFERENTE: Avaliar possível mudança (silenciosamente) ═══
  const lockedDuration = now - locked.lockedAt;
  const stabilityMultiplier = getStabilityMultiplier(lockedDuration);
  const isRelative = areRelativeKeys(locked.tonic, locked.quality, tonic, quality);
  
  // Tons relativos requerem margem MUITO maior
  const requiredMargin = isRelative
    ? CONFIG.CHANGE_CONFIDENCE_MARGIN * 2.5
    : CONFIG.CHANGE_CONFIDENCE_MARGIN;
  
  // Verificar se é o mesmo candidato oculto
  const hiddenId = state.hiddenCandidate
    ? keyId(state.hiddenCandidate.tonic, state.hiddenCandidate.quality)
    : null;
  const newId = keyId(tonic, quality);
  
  if (hiddenId === newId && state.hiddenCandidate) {
    // Continuar acumulando evidência para o candidato oculto
    const updated: HiddenCandidate = {
      ...state.hiddenCandidate,
      consecutiveHits: state.hiddenCandidate.consecutiveHits + 1,
      confidenceSum: state.hiddenCandidate.confidenceSum + confidence,
    };
    
    const avgHiddenConf = updated.confidenceSum / updated.consecutiveHits;
    const requiredHits = Math.ceil(CONFIG.MIN_HITS_FOR_CHANGE * stabilityMultiplier);
    
    // Verificar se o novo tom superou os requisitos para troca
    const shouldSwitch =
      updated.consecutiveHits >= requiredHits &&
      avgHiddenConf > locked.confidence + requiredMargin &&
      (now - updated.firstSeenAt) > CONFIG.MIN_LOCK_DURATION_MS;
    
    if (shouldSwitch) {
      // ═══ TROCAR TOM (com mensagem discreta) ═══
      return {
        ...state,
        lockedKey: {
          tonic,
          quality,
          keyName,
          lockedAt: now,
          confidence: avgHiddenConf,
          totalAnalyses: 1,
          stabilityScore: 0,
        },
        hiddenCandidate: null,
        visualConfidence: CONFIG.INITIAL_VISUAL_CONFIDENCE + 5,
        internalStage: 'locked',
      };
    }
    
    // Ainda acumulando evidência
    return {
      ...state,
      hiddenCandidate: updated,
    };
  }
  
  // Novo candidato oculto diferente
  return {
    ...state,
    hiddenCandidate: {
      tonic,
      quality,
      keyName,
      firstSeenAt: now,
      consecutiveHits: 1,
      confidenceSum: confidence,
    },
  };
}

/**
 * Processa análise quando ainda não temos tom travado
 */
function processWithoutLockedKey(
  state: StableKeyState,
  tonic: number,
  quality: 'major' | 'minor',
  confidence: number,
  keyName: string,
  now: number
): StableKeyState {
  const candidate = state.currentCandidate;
  const candidateId = candidate
    ? keyId(candidate.tonic, candidate.quality)
    : null;
  const newId = keyId(tonic, quality);
  
  // ═══ MESMO CANDIDATO: Reforçar ═══
  if (candidateId === newId && candidate) {
    const updated: KeyCandidate = {
      ...candidate,
      lastSeenAt: now,
      consecutiveHits: candidate.consecutiveHits + 1,
      totalHits: candidate.totalHits + 1,
      maxConfidence: Math.max(candidate.maxConfidence, confidence),
      confidenceSum: candidate.confidenceSum + confidence,
      avgConfidence: (candidate.confidenceSum + confidence) / (candidate.totalHits + 1),
    };
    
    // Determinar novo estágio interno
    let newStage = state.internalStage;
    let shouldLock = false;
    
    // Verificar se pode avançar de estágio
    if (updated.consecutiveHits >= CONFIG.MIN_HITS_FOR_LOCK) {
      const candidateDuration = now - updated.firstSeenAt;
      
      // Lock rápido para alta confiança
      if (updated.avgConfidence >= CONFIG.FAST_LOCK_CONFIDENCE) {
        shouldLock = true;
      }
      // Lock normal após tempo mínimo
      else if (candidateDuration >= CONFIG.MIN_CANDIDATE_DURATION_MS) {
        shouldLock = true;
      }
      else {
        newStage = 'stableCandidate';
      }
    }
    else if (updated.consecutiveHits >= CONFIG.MIN_HITS_FOR_STABLE) {
      newStage = 'stableCandidate';
    }
    else if (updated.consecutiveHits >= CONFIG.MIN_HITS_FOR_CANDIDATE) {
      newStage = 'candidate';
    }
    
    if (shouldLock) {
      // ═══ TRAVAR TOM ═══
      return {
        ...state,
        internalStage: 'locked',
        currentCandidate: null,
        lockedKey: {
          tonic: updated.tonic,
          quality: updated.quality,
          keyName: updated.keyName,
          lockedAt: now,
          confidence: updated.avgConfidence,
          totalAnalyses: updated.totalHits,
          stabilityScore: 0,
        },
        visualConfidence: CONFIG.INITIAL_VISUAL_CONFIDENCE,
      };
    }
    
    return {
      ...state,
      internalStage: newStage,
      currentCandidate: updated,
    };
  }
  
  // ═══ CANDIDATO DIFERENTE: Verificar se deve trocar ═══
  
  // Se candidato atual está muito fraco ou muito antigo, substituir
  const shouldReplaceCandidate =
    !candidate ||
    candidate.consecutiveHits < 2 ||
    (now - candidate.lastSeenAt) > CONFIG.MAX_GAP_BETWEEN_ANALYSES_MS;
  
  if (shouldReplaceCandidate) {
    // Iniciar novo candidato
    return {
      ...state,
      internalStage: 'candidate',
      currentCandidate: {
        tonic,
        quality,
        keyName,
        firstSeenAt: now,
        lastSeenAt: now,
        consecutiveHits: 1,
        totalHits: 1,
        maxConfidence: confidence,
        avgConfidence: confidence,
        confidenceSum: confidence,
      },
    };
  }
  
  // Manter candidato atual, zerar hits consecutivos
  return {
    ...state,
    currentCandidate: {
      ...candidate,
      consecutiveHits: 0,
      lastSeenAt: now,
    },
  };
}

/**
 * Reseta o estado (quando usuário para a detecção)
 */
export function resetStableKeyState(): StableKeyState {
  return createStableKeyState();
}

/**
 * Soft reset (nova detecção sem parar microfone)
 */
export function softResetStableKeyState(state: StableKeyState): StableKeyState {
  return {
    ...createStableKeyState(),
    detectionStartedAt: Date.now(),
  };
}

/**
 * Obtém o estado visível ao usuário
 */
export function getUserVisibleState(state: StableKeyState): UserVisibleState {
  if (state.lockedKey) return 'confirmed';
  if (state.internalStage === 'listening') return 'listening';
  return 'analyzing';
}

/**
 * Verifica se deve mostrar o tom ao usuário
 */
export function shouldShowKey(state: StableKeyState): boolean {
  return state.lockedKey !== null;
}

/**
 * Obtém o tom atual (apenas se travado)
 */
export function getDisplayKey(state: StableKeyState): {
  tonic: number;
  quality: 'major' | 'minor';
  keyName: string;
  confidence: number;
} | null {
  if (!state.lockedKey) return null;
  
  return {
    tonic: state.lockedKey.tonic,
    quality: state.lockedKey.quality,
    keyName: state.lockedKey.keyName,
    confidence: state.visualConfidence / 100,
  };
}

/**
 * Verifica se houve mudança de tom recente
 */
export function hasRecentKeyChange(state: StableKeyState): boolean {
  if (!state.lockedKey) return false;
  const lockAge = Date.now() - state.lockedKey.lockedAt;
  // Considera "recente" se travou nos últimos 3 segundos
  return lockAge < 3000 && state.lockedKey.totalAnalyses > 1;
}

/**
 * Incrementa confiança visual gradualmente (chamado periodicamente)
 */
export function incrementVisualConfidence(state: StableKeyState): StableKeyState {
  if (!state.lockedKey) return state;
  if (state.visualConfidence >= CONFIG.MAX_VISUAL_CONFIDENCE) return state;
  
  return {
    ...state,
    visualConfidence: state.visualConfidence + 1,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// EXPORTS DE CONFIGURAÇÃO (para UI poder acessar)
// ═══════════════════════════════════════════════════════════════════════════

export const STABLE_KEY_CONFIG = CONFIG;
