"""
vocal_focus.py — Vocal Focus / Noise Rejection Layer v1.0
═══════════════════════════════════════════════════════════════════════════════

Tom Certo — Pré-processador de áudio antes do motor tonal.
Filtra frames ANTES de alimentar o key_detection_v10.

ROLLBACK IMEDIATO:
  Em key_detection_v10.py → setar VOCAL_FOCUS_ENABLED = False
  Ou neste arquivo → VocalFocusConfig(enabled=False)

Pipeline:
    áudio raw (float32, 16kHz, normalizado)
    + F0 em Hz por frame (de torchcrepe)
    + confiança 0..1 por frame (de torchcrepe)
    ↓
    1. Calcular RMS por frame (janelização idêntica ao CREPE: 10ms/frame)
    2. Detectar onsets percussivos (dRMS/dt rápido + sem pitch sustentado)
    3. Filtrar frames: silêncio | confiança baixa | percussão | fora da faixa vocal
    4. Filtrar segmentos: duração < mínima | pitch instável (std em semitons)
    5. Retornar F0/conf filtrado + estatísticas de rejeição para logs e UX

Logs obrigatórios por clip:
  - Frames totais / válidos / rejeitados
  - Motivo de rejeição: percussion_noise | low_confidence | background_noise |
                        too_short | unstable_pitch | no_vocal_presence
  - Confiança/qualidade final
  - Estado de ruído: clean | noisy | percussion | silence
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from typing import Dict, Optional

import numpy as np

logger = logging.getLogger(__name__)

# ─────────────────────────────────────────────────────────────────────────────
# CLASSIFICAÇÕES DE FRAME (usadas em logs e no campo noise_rejection)
# ─────────────────────────────────────────────────────────────────────────────
FRAME_VALID         = "valid_tonal_evidence"
FRAME_PERCUSSION    = "percussion_noise"
FRAME_BACKGROUND    = "background_noise"
FRAME_UNSTABLE      = "unstable_pitch"
FRAME_TOO_SHORT     = "too_short"
FRAME_LOW_CONF      = "low_confidence"
FRAME_NO_VOCAL      = "no_vocal_presence"


# ─────────────────────────────────────────────────────────────────────────────
# CONFIGURAÇÃO (todos os parâmetros ajustáveis para fine-tuning)
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class VocalFocusConfig:
    """
    Configuração equilibrada do filtro vocal focus.

    Nível padrão: equilibrado — rejeita percussão, notas curtas e pitch instável;
    aceita voz cantada sustentada e instrumentos melódicos.

    Para desativar completamente: VocalFocusConfig(enabled=False)
    Ou setar VOCAL_FOCUS_ENABLED = False em key_detection_v10.py
    """

    # ─── SWITCH GLOBAL ──────────────────────────────────────────────────────
    # False = sem filtragem alguma (rollback imediato)
    enabled: bool = True

    # ─── CONFIANÇA MÍNIMA DO PITCH (torchcrepe periodicity) ─────────────────
    # 0.40 filtra frames ruidosos sem rejeitar voz com vibrato ou microfone simples.
    # key_detection_v10 usa 0.35 (mais permissivo) — vocal_focus é uma camada extra.
    min_frame_confidence: float = 0.40

    # ─── DURAÇÃO MÍNIMA DE SEGMENTO CONTÍNUO ────────────────────────────────
    # Segmentos < 120ms: percussão, ataques, notas soltas ou artefatos.
    # Voz cantada sustenta tipicamente ≥ 150-200ms por nota.
    min_note_duration_ms: float = 120.0

    # ─── ESTABILIDADE DE PITCH ──────────────────────────────────────────────
    # Janela deslizante de 7 frames (70ms) para medir std de MIDI em semitons.
    # Std > 1.5 st = pitch instável (músico procurando tom ou ruído).
    # Vibrato normal: amplitude ±0.5st → std ≈ 0.35st → bem abaixo do threshold.
    stability_window_frames: int = 7
    max_pitch_std_semitones: float = 1.5

    # ─── ENERGIA (RMS normalizada 0..1) ──────────────────────────────────────
    min_rms: float = 0.008   # silêncio / abaixo do ruído de fundo
    max_rms: float = 0.98    # clipping / distorção

    # ─── DETECÇÃO DE PERCUSSÃO (onset detection) ────────────────────────────
    # Um onset percussivo tem: subida rápida de energia + SEM pitch sustentado.
    # Se há pitch sustentado após o onset = voz/instrumento começando → NÃO percussão.
    percussion_onset_drms: float = 0.040       # dRMS mínimo para onset
    percussion_lookahead_frames: int = 8        # 80ms de lookahead após onset
    percussion_min_pitch_ratio: float = 0.35    # < 35% frames com pitch = percussão
    percussion_reject_frames: int = 5           # frames rejeitados após onset confirmado

    # ─── FAIXA DE FREQUÊNCIA ACEITÁVEL ───────────────────────────────────────
    f0_min_hz: float = 65.0    # C2 — voz masculina grave
    f0_max_hz: float = 1100.0  # C6 — voz feminina aguda / soprano

    # ─── EVIDÊNCIA MÍNIMA PARA PASSAR ────────────────────────────────────────
    # Se < X% dos frames do clip são válidos, retorna passed=False
    min_valid_frame_ratio: float = 0.08


# Instância padrão (equilibrada)
DEFAULT_CONFIG = VocalFocusConfig()


# ─────────────────────────────────────────────────────────────────────────────
# RESULTADO
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class VocalFocusResult:
    """Resultado da camada Vocal Focus."""

    # Resultado principal
    passed: bool                          # True = evidência tonal válida suficiente
    rejection_reason: Optional[str] = None  # Motivo principal se passed=False

    # Arrays filtrados (alimentam o motor tonal)
    filtered_f0: Optional[np.ndarray] = None
    filtered_conf: Optional[np.ndarray] = None

    # Estatísticas de frames
    total_frames: int = 0
    valid_frames: int = 0
    rejected_frames: int = 0

    # Contagem por motivo de rejeição (para logs)
    rejection_counts: Dict[str, int] = field(default_factory=lambda: {
        FRAME_PERCUSSION: 0,
        FRAME_BACKGROUND: 0,
        FRAME_LOW_CONF:   0,
        FRAME_UNSTABLE:   0,
        FRAME_TOO_SHORT:  0,
        FRAME_NO_VOCAL:   0,
    })

    # Qualidade geral do áudio (0..1)
    audio_quality_score: float = 0.0

    # Estado de ruído para UX/logs
    # 'clean' | 'noisy' | 'percussion' | 'silence'
    noise_stage: str = "clean"

    # Tempo de processamento (diagnóstico)
    processing_ms: float = 0.0


# ─────────────────────────────────────────────────────────────────────────────
# FUNÇÕES INTERNAS
# ─────────────────────────────────────────────────────────────────────────────

def _compute_frame_rms(audio: np.ndarray, hop_length: int) -> np.ndarray:
    """
    Calcula RMS por frame com a mesma janelização do CREPE (hop_length=160 samples).
    """
    n_samples = len(audio)
    n_frames = max(1, (n_samples + hop_length - 1) // hop_length)
    rms = np.zeros(n_frames, dtype=np.float32)
    for i in range(n_frames):
        start = i * hop_length
        end = min(start + hop_length, n_samples)
        frame = audio[start:end]
        if len(frame) > 0:
            rms[i] = float(np.sqrt(np.mean(frame.astype(np.float64) ** 2)))
    return rms


def _smooth(arr: np.ndarray, window: int = 3) -> np.ndarray:
    """Suavização por média móvel simples."""
    if window < 2 or len(arr) < window:
        return arr.copy()
    kernel = np.ones(window) / window
    return np.convolve(arr.astype(np.float64), kernel, mode='same').astype(np.float32)


def _midi_std(f0_array: np.ndarray) -> float:
    """Desvio padrão em semitons (MIDI) de um array de frequências Hz."""
    valid = f0_array[~np.isnan(f0_array)]
    valid = valid[valid > 0]
    if len(valid) < 2:
        return 0.0
    midi = 69.0 + 12.0 * np.log2(valid / 440.0)
    return float(np.std(midi))


def _detect_percussion_onsets(
    rms: np.ndarray,
    f0: np.ndarray,
    conf: np.ndarray,
    config: VocalFocusConfig,
) -> np.ndarray:
    """
    Detecta frames percussivos via onset detection + verificação de pitch sustentado.

    Algoritmo:
    1. Computar dRMS = derivada suavizada do RMS (taxa de subida de energia)
    2. Onset quando dRMS > threshold
    3. Após onset, verificar nos próximos N frames:
       - Se >= 35% têm pitch válido → voz/instrumento começando → NÃO percussão
       - Se < 35% têm pitch válido  → percussão confirmada → marcar frames

    Retorna máscara booleana (True = percussivo/ruído impulsivo)
    """
    n = len(rms)
    mask = np.zeros(n, dtype=bool)

    if n < 4:
        return mask

    smooth_rms = _smooth(rms, 3)
    drms = np.zeros(n, dtype=np.float64)
    drms[1:] = np.diff(smooth_rms.astype(np.float64))

    i = 0
    while i < n:
        if drms[i] > config.percussion_onset_drms:
            look_end = min(n, i + config.percussion_lookahead_frames)
            window_size = look_end - i

            if window_size > 0:
                pitch_valid = int(np.sum(
                    (~np.isnan(f0[i:look_end])) & (conf[i:look_end] >= config.min_frame_confidence)
                ))
                pitch_ratio = pitch_valid / window_size

                if pitch_ratio < config.percussion_min_pitch_ratio:
                    # Percussão confirmada
                    reject_end = min(n, i + config.percussion_reject_frames)
                    mask[i:reject_end] = True
                    i = reject_end
                    continue
        i += 1

    return mask


# ─────────────────────────────────────────────────────────────────────────────
# FUNÇÃO PRINCIPAL
# ─────────────────────────────────────────────────────────────────────────────

def apply_vocal_focus(
    audio: np.ndarray,
    f0: np.ndarray,
    conf: np.ndarray,
    sample_rate: int = 16000,
    hop_ms: float = 10.0,
    config: Optional[VocalFocusConfig] = None,
) -> VocalFocusResult:
    """
    Aplica a camada Vocal Focus / Noise Rejection antes do motor tonal.

    Args:
        audio:       áudio raw float32 normalizado (16kHz mono)
        f0:          F0 em Hz por frame, NaN = sem pitch (de torchcrepe)
        conf:        periodicidade/confiança 0..1 por frame (de torchcrepe)
        sample_rate: 16000 Hz
        hop_ms:      10ms (padrão CREPE)
        config:      configuração (None = padrão equilibrado)

    Returns:
        VocalFocusResult com filtered_f0, filtered_conf, estatísticas e noise_stage
    """
    if config is None:
        config = DEFAULT_CONFIG

    t0 = time.time()
    n_frames = len(f0)
    hop_length = int(sample_rate * hop_ms / 1000)

    result = VocalFocusResult(passed=False, total_frames=n_frames)

    # ── BYPASS GLOBAL (rollback) ──────────────────────────────────────────────
    if not config.enabled:
        result.passed = True
        result.filtered_f0 = f0.copy().astype(np.float64)
        result.filtered_conf = conf.copy().astype(np.float64)
        result.valid_frames = int(np.sum(~np.isnan(f0)))
        result.noise_stage = "clean"
        result.audio_quality_score = 1.0
        result.processing_ms = (time.time() - t0) * 1000
        logger.debug("[VocalFocus] disabled — bypass total")
        return result

    if n_frames == 0:
        result.rejection_reason = 'no_frames'
        result.processing_ms = (time.time() - t0) * 1000
        return result

    # ── 1. RMS POR FRAME ──────────────────────────────────────────────────────
    frame_rms = _compute_frame_rms(audio, hop_length)
    rms_aligned = np.zeros(n_frames, dtype=np.float32)
    copy_len = min(n_frames, len(frame_rms))
    rms_aligned[:copy_len] = frame_rms[:copy_len]

    # ── 2. DETECÇÃO DE PERCUSSÃO ────────────────────────────────────────────
    percussion_mask = _detect_percussion_onsets(rms_aligned, f0, conf, config)

    # ── 3. FILTROS POR FRAME ────────────────────────────────────────────────
    filtered_f0 = f0.copy().astype(np.float64)
    filtered_conf = conf.copy().astype(np.float64)
    rc = result.rejection_counts

    for i in range(n_frames):
        rms_i = float(rms_aligned[i])

        if rms_i < config.min_rms:
            filtered_f0[i] = np.nan
            filtered_conf[i] = 0.0
            rc[FRAME_BACKGROUND] += 1
            continue

        if rms_i > config.max_rms:
            filtered_f0[i] = np.nan
            filtered_conf[i] = 0.0
            rc[FRAME_NO_VOCAL] += 1
            continue

        if percussion_mask[i]:
            filtered_f0[i] = np.nan
            filtered_conf[i] = 0.0
            rc[FRAME_PERCUSSION] += 1
            continue

        if np.isnan(f0[i]) or float(conf[i]) < config.min_frame_confidence:
            filtered_f0[i] = np.nan
            filtered_conf[i] = 0.0
            rc[FRAME_LOW_CONF] += 1
            continue

        hz = float(f0[i])
        if hz < config.f0_min_hz or hz > config.f0_max_hz:
            filtered_f0[i] = np.nan
            filtered_conf[i] = 0.0
            rc[FRAME_NO_VOCAL] += 1
            continue

    # ── 4. FILTROS POR SEGMENTO CONTÍNUO (duração + estabilidade) ──────────
    # Identifica runs de frames não-NaN consecutivos e filtra por duração e estabilidade.
    i = 0
    while i < n_frames:
        if np.isnan(filtered_f0[i]):
            i += 1
            continue

        # Encontrar fim do segmento
        seg_start = i
        j = i + 1
        while j < n_frames and not np.isnan(filtered_f0[j]):
            j += 1
        seg_end = j
        seg_dur_ms = (seg_end - seg_start) * hop_ms

        # Filtro 1: duração mínima
        if seg_dur_ms < config.min_note_duration_ms:
            for k in range(seg_start, seg_end):
                filtered_f0[k] = np.nan
                filtered_conf[k] = 0.0
                rc[FRAME_TOO_SHORT] += 1
            i = seg_end
            continue

        # Filtro 2: estabilidade de pitch (janela deslizante dentro do segmento)
        win = config.stability_window_frames
        seg_f0_original = f0[seg_start:seg_end]

        for k in range(seg_start, seg_end):
            if np.isnan(filtered_f0[k]):
                continue
            w_start = max(seg_start, k - win // 2)
            w_end = min(seg_end, k + win // 2 + 1)
            local_std = _midi_std(seg_f0_original[w_start - seg_start: w_end - seg_start])
            if local_std > config.max_pitch_std_semitones:
                filtered_f0[k] = np.nan
                filtered_conf[k] = 0.0
                rc[FRAME_UNSTABLE] += 1

        i = seg_end

    # ── 5. ESTATÍSTICAS FINAIS ───────────────────────────────────────────────
    valid_frames = int(np.sum(~np.isnan(filtered_f0)))
    rejected_frames = n_frames - valid_frames
    valid_ratio = valid_frames / max(n_frames, 1)

    result.filtered_f0 = filtered_f0
    result.filtered_conf = filtered_conf
    result.valid_frames = valid_frames
    result.rejected_frames = rejected_frames

    # Score de qualidade: válidos × confiança média
    if valid_frames > 0:
        avg_conf = float(np.nanmean(filtered_conf[~np.isnan(filtered_f0)]))
        result.audio_quality_score = round(valid_ratio * avg_conf, 3)
    else:
        result.audio_quality_score = 0.0

    # Noise stage
    perc_ratio = rc[FRAME_PERCUSSION] / max(n_frames, 1)
    bg_ratio = rc[FRAME_BACKGROUND] / max(n_frames, 1)

    if valid_ratio < 0.05:
        result.noise_stage = "silence" if bg_ratio > 0.50 else "percussion" if perc_ratio > 0.20 else "noisy"
    elif perc_ratio > 0.25:
        result.noise_stage = "percussion"
    elif valid_ratio < 0.15:
        result.noise_stage = "noisy"
    else:
        result.noise_stage = "clean"

    # Decisão
    if valid_ratio >= config.min_valid_frame_ratio:
        result.passed = True
    else:
        result.passed = False
        max_reason = max(rc.items(), key=lambda x: x[1]) if any(v > 0 for v in rc.values()) else None
        result.rejection_reason = max_reason[0] if max_reason and max_reason[1] > 0 else 'insufficient_evidence'

    # ── 6. LOGS OBRIGATÓRIOS ─────────────────────────────────────────────────
    proc_ms = (time.time() - t0) * 1000
    result.processing_ms = round(proc_ms, 1)

    logger.info(
        f"[VocalFocus v1.0] frames={n_frames} válidos={valid_frames} ({valid_ratio:.0%}) "
        f"estágio={result.noise_stage} qualidade={result.audio_quality_score:.2f} "
        f"passed={result.passed} [{proc_ms:.0f}ms]"
    )

    if rejected_frames > 0:
        reasons_str = " | ".join(
            f"{k}={v}" for k, v in sorted(rc.items(), key=lambda x: -x[1]) if v > 0
        )
        logger.info(f"[VocalFocus] Rejeições: {reasons_str}")

    if not result.passed:
        logger.info(f"[VocalFocus] BLOQUEADO — motivo={result.rejection_reason}")

    return result
