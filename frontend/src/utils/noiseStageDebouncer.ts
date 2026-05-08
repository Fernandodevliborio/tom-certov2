// ═══════════════════════════════════════════════════════════════════════════
// noiseStageDebouncer.ts — Histerese para o noise_stage do backend
// ═══════════════════════════════════════════════════════════════════════════
//
// O backend reporta `noise_rejection.stage` a cada análise (~1.5-2s). Mostrar
// esse estado direto no UI causa flicker quando o áudio oscila entre clean
// e noisy. Esta camada aplica HISTERESE/DEBOUNCE:
//
//   - 'clean' é o estado padrão e tem prioridade na exibição;
//   - para sair de 'clean' para um estado "ruim" (noisy/percussion/silence),
//     o backend precisa reportar o mesmo estado por pelo menos `MIN_HOLD_MS`
//     (default 1500ms);
//   - para voltar de "ruim" para 'clean', precisa reportar 'clean' por pelo
//     menos `MIN_RECOVER_MS` (default 1200ms) — assim mensagens informativas
//     não desaparecem instantaneamente quando o usuário pausa.
//
// Resultado: sem piscadas, sem trocas a cada 100ms.
// ═══════════════════════════════════════════════════════════════════════════

import type { NoiseStage } from './mlKeyAnalyzer';

export interface NoiseStageDisplay {
  stage: NoiseStage;
  label: string;        // mensagem em pt-BR para o usuário
  hint?: string;        // sub-mensagem opcional
  isWarning: boolean;   // true quando o estado merece atenção visual
}

const STAGE_LABELS: Record<NoiseStage, { label: string; hint?: string; isWarning: boolean }> = {
  clean:      { label: 'Áudio limpo',           hint: undefined,                                                  isWarning: false },
  noisy:      { label: 'Ambiente com ruído',    hint: 'Tente um lugar mais silencioso para melhor detecção.',     isWarning: true  },
  percussion: { label: 'Percussão detectada',   hint: 'Cante uma melodia — sem batidas no microfone.',            isWarning: true  },
  silence:    { label: 'Aguardando voz',        hint: 'Cante mais perto do microfone.',                            isWarning: true  },
};

export function describeStage(stage: NoiseStage): NoiseStageDisplay {
  const meta = STAGE_LABELS[stage] ?? STAGE_LABELS.clean;
  return { stage, ...meta };
}

interface DebouncerOptions {
  minHoldMs?: number;     // tempo mínimo no novo estado antes de assumi-lo
  minRecoverMs?: number;  // tempo mínimo em 'clean' antes de voltar a 'clean'
}

/**
 * Cria um debouncer para `noise_stage`.
 *
 * Uso:
 *   const deb = createNoiseStageDebouncer();
 *   const stable = deb.update('noisy', Date.now()); // pode ser 'clean' ainda
 *   ... 1500ms depois ...
 *   const stable2 = deb.update('noisy', Date.now()); // agora vira 'noisy'
 */
export function createNoiseStageDebouncer(opts: DebouncerOptions = {}) {
  const MIN_HOLD_MS = opts.minHoldMs ?? 1500;
  const MIN_RECOVER_MS = opts.minRecoverMs ?? 1200;

  let displayed: NoiseStage = 'clean';
  let candidate: NoiseStage = 'clean';
  let candidateSinceMs = 0;

  function update(incoming: NoiseStage, nowMs: number): NoiseStage {
    if (incoming !== candidate) {
      candidate = incoming;
      candidateSinceMs = nowMs;
    }
    const heldMs = nowMs - candidateSinceMs;
    if (candidate === displayed) {
      return displayed;
    }
    // Voltando para 'clean' — exige tempo mínimo de recuperação
    if (candidate === 'clean') {
      if (heldMs >= MIN_RECOVER_MS) {
        displayed = 'clean';
      }
      return displayed;
    }
    // Saindo de qualquer estado para um estado "ruim"
    if (heldMs >= MIN_HOLD_MS) {
      displayed = candidate;
    }
    return displayed;
  }

  function reset() {
    displayed = 'clean';
    candidate = 'clean';
    candidateSinceMs = 0;
  }

  function getDisplayed(): NoiseStage {
    return displayed;
  }

  return { update, reset, getDisplayed };
}
