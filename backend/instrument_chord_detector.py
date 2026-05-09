"""
instrument_chord_detector.py — Detector de acordes e notas-baixo via chroma
═══════════════════════════════════════════════════════════════════════════════

Para o modo Voz + Instrumento. Não substitui o motor tonal — produz EVIDÊNCIAS
adicionais (acordes detectados + notas-baixo) que viram "notas com peso alto"
alimentadas no acumulador existente.

Pipeline:
  1. HPSS (separação harmônica/percussiva) — librosa.effects.hpss
  2. Chroma CQT do componente harmônico — librosa.feature.chroma_cqt
  3. Match com 24 templates (12 maior + 12 menor) por janela de ~500ms
  4. Bass note: F0 mais grave persistente em janelas de ~500ms (banda < 200Hz)

Saída:
  detect_chords_and_bass(audio, sr) →
    [
      {
        'time_s':       float,    # início da janela
        'chord_pc':     int,      # pitch-class (0=C, 11=B)
        'chord_quality': str,     # 'major' | 'minor'
        'chord_strength': float,  # 0..1 (correlação com template)
        'bass_pc':      int|None, # pitch-class da nota grave dominante
        'bass_strength': float,   # 0..1
      },
      ...
    ]

Rollback: setar INSTRUMENT_MODE_ENABLED = False em key_detection_v10.py.
═══════════════════════════════════════════════════════════════════════════════
"""

from __future__ import annotations

import logging
from typing import Dict, List, Optional

import numpy as np
import librosa

logger = logging.getLogger(__name__)

# ─── Templates de acordes (vetores chroma 12-dim normalizados) ──────────────
# Pesos: 1.0 na fundamental, 0.7 na 3ª, 0.6 na 5ª. Outras = 0.
def _build_chord_templates() -> Dict[str, np.ndarray]:
    """24 templates: 12 maior + 12 menor."""
    templates: Dict[str, np.ndarray] = {}
    for root in range(12):
        # Maior: 1, 3M, 5J → root, root+4, root+7
        major = np.zeros(12, dtype=np.float64)
        major[root] = 1.0
        major[(root + 4) % 12] = 0.7
        major[(root + 7) % 12] = 0.6
        major /= np.linalg.norm(major)
        templates[f'{root}_major'] = major

        # Menor: 1, 3m, 5J → root, root+3, root+7
        minor = np.zeros(12, dtype=np.float64)
        minor[root] = 1.0
        minor[(root + 3) % 12] = 0.7
        minor[(root + 7) % 12] = 0.6
        minor /= np.linalg.norm(minor)
        templates[f'{root}_minor'] = minor
    return templates


_CHORD_TEMPLATES = _build_chord_templates()


def _match_chord(chroma_vec: np.ndarray) -> Dict[str, object]:
    """Retorna o template com maior similaridade cosseno."""
    if np.linalg.norm(chroma_vec) < 1e-6:
        return {'chord_pc': 0, 'chord_quality': 'major', 'chord_strength': 0.0}
    v = chroma_vec / np.linalg.norm(chroma_vec)
    best_label = '0_major'
    best_score = -1.0
    for label, tmpl in _CHORD_TEMPLATES.items():
        score = float(np.dot(v, tmpl))
        if score > best_score:
            best_score = score
            best_label = label
    root_str, qual = best_label.split('_')
    return {
        'chord_pc': int(root_str),
        'chord_quality': qual,
        'chord_strength': max(0.0, best_score),
    }


def _detect_bass_note(
    audio: np.ndarray,
    sample_rate: int,
    start_sample: int,
    end_sample: int,
) -> Dict[str, object]:
    """Encontra nota mais grave dominante na janela (banda 50-200 Hz)."""
    seg = audio[start_sample:end_sample]
    if len(seg) < sample_rate // 4:
        return {'bass_pc': None, 'bass_strength': 0.0}

    # FFT da banda grave
    n_fft = 1024
    if len(seg) < n_fft:
        return {'bass_pc': None, 'bass_strength': 0.0}
    # Janela de Hann + FFT real
    window = np.hanning(n_fft).astype(np.float64)
    seg_w = seg[:n_fft].astype(np.float64) * window
    spec = np.abs(np.fft.rfft(seg_w))
    freqs = np.fft.rfftfreq(n_fft, d=1.0 / sample_rate)

    # Banda 50-200 Hz (bass real)
    mask = (freqs >= 50.0) & (freqs <= 200.0)
    if not np.any(mask):
        return {'bass_pc': None, 'bass_strength': 0.0}
    band_spec = spec[mask]
    band_freqs = freqs[mask]
    if band_spec.max() <= 1e-6:
        return {'bass_pc': None, 'bass_strength': 0.0}

    peak_idx = int(np.argmax(band_spec))
    peak_hz = float(band_freqs[peak_idx])
    peak_amp = float(band_spec[peak_idx])
    total_energy = float(spec.sum() + 1e-9)
    strength = min(1.0, (peak_amp * 5.0) / total_energy)  # heurística

    # Hz → pitch class
    if peak_hz < 30.0:
        return {'bass_pc': None, 'bass_strength': 0.0}
    midi = 69.0 + 12.0 * np.log2(peak_hz / 440.0)
    pc = int(round(midi)) % 12
    return {
        'bass_pc': pc,
        'bass_strength': float(strength),
        'bass_hz': float(peak_hz),
    }


def detect_chords_and_bass(
    audio: np.ndarray,
    sample_rate: int = 16000,
    window_ms: float = 500.0,
    hop_ms: float = 250.0,
    min_chord_strength: float = 0.55,
) -> List[Dict[str, object]]:
    """
    Detecta acordes e notas-baixo em janelas deslizantes.

    Args:
        audio:           float32 mono normalizado
        sample_rate:     16000 (default app)
        window_ms:       500ms — janela suficiente para um acorde
        hop_ms:          250ms — overlap 50%
        min_chord_strength: similaridade cosseno mínima para aceitar acorde

    Returns:
        Lista de detecções por janela. Janelas sem evidência são omitidas.
    """
    if len(audio) < int(sample_rate * 1.0):
        return []

    # ─── HPSS para separar harmônico do percussivo ──────────────────────
    try:
        # margin agressivo: mais separação harmônica vs percussiva
        y_harm, _y_perc = librosa.effects.hpss(audio.astype(np.float32), margin=3.0)
    except Exception as exc:
        logger.warning(f"[InstrChord] HPSS falhou ({exc}) — usando sinal raw")
        y_harm = audio.astype(np.float32)

    # ─── Chroma CQT do componente harmônico ─────────────────────────────
    hop_length = int(sample_rate * 0.020)  # 20ms hop pra chroma
    try:
        chroma = librosa.feature.chroma_cqt(
            y=y_harm.astype(np.float32),
            sr=sample_rate,
            hop_length=hop_length,
            n_chroma=12,
        )
    except Exception as exc:
        logger.warning(f"[InstrChord] chroma_cqt falhou ({exc})")
        return []

    chroma_frames_per_sec = sample_rate / hop_length
    win_chroma_frames = max(1, int(window_ms / 1000.0 * chroma_frames_per_sec))
    hop_chroma_frames = max(1, int(hop_ms / 1000.0 * chroma_frames_per_sec))
    win_samples = int(window_ms / 1000.0 * sample_rate)
    hop_samples = int(hop_ms / 1000.0 * sample_rate)

    detections: List[Dict[str, object]] = []
    n_chroma = chroma.shape[1]
    n_audio = len(audio)
    chroma_idx = 0
    audio_idx = 0
    while chroma_idx + win_chroma_frames <= n_chroma:
        # Vetor chroma médio na janela
        seg_chroma = chroma[:, chroma_idx:chroma_idx + win_chroma_frames]
        avg_chroma = seg_chroma.mean(axis=1)

        chord = _match_chord(avg_chroma)
        if chord['chord_strength'] >= min_chord_strength:
            # Bass na mesma janela
            audio_end = min(audio_idx + win_samples, n_audio)
            bass = _detect_bass_note(audio, sample_rate, audio_idx, audio_end)
            detections.append({
                'time_s': round(audio_idx / sample_rate, 3),
                'chord_pc': chord['chord_pc'],
                'chord_quality': chord['chord_quality'],
                'chord_strength': round(float(chord['chord_strength']), 3),
                'bass_pc': bass['bass_pc'],
                'bass_strength': round(float(bass['bass_strength']), 3),
            })

        chroma_idx += hop_chroma_frames
        audio_idx += hop_samples

    return detections
