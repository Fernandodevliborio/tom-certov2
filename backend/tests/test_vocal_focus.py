"""
test_vocal_focus.py — Testes unitários da camada Vocal Focus / Noise Rejection
═══════════════════════════════════════════════════════════════════════════════

Cobre cenários:
  1. SILÊNCIO     → noise_stage='silence', passed=False
  2. RUÍDO BRANCO → noise_stage='noisy' ou 'silence', passed=False (sem pitch)
  3. PERCUSSÃO    → noise_stage='percussion' (cliques sem pitch sustentado)
  4. VOZ LIMPA    → noise_stage='clean', passed=True, valid_ratio alto
  5. NOTA CURTA   → segmentos < min_note_duration_ms são rejeitados
  6. PITCH INSTÁVEL → segmento com std MIDI alto é rejeitado
  7. BYPASS       → enabled=False ⇒ passed=True com fallback transparente

Para rodar:
    cd /app/backend && pytest -xvs tests/test_vocal_focus.py
"""

from __future__ import annotations

import os
import sys

import numpy as np
import pytest

# Garantir que /app/backend está no path para importar vocal_focus
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from vocal_focus import (  # noqa: E402
    apply_vocal_focus,
    VocalFocusConfig,
    VocalFocusResult,
    FRAME_VALID,
    FRAME_PERCUSSION,
    FRAME_BACKGROUND,
    FRAME_LOW_CONF,
    FRAME_UNSTABLE,
    FRAME_TOO_SHORT,
    FRAME_NO_VOCAL,
)


SAMPLE_RATE = 16000
HOP_MS = 10.0
HOP = int(SAMPLE_RATE * HOP_MS / 1000)  # 160 samples


# ───────────────────────────────────────────────────────────────────────────
# Fixtures sintéticas
# ───────────────────────────────────────────────────────────────────────────

def _make_silence(duration_s: float = 2.0):
    n = int(SAMPLE_RATE * duration_s)
    audio = np.zeros(n, dtype=np.float32)
    n_frames = n // HOP
    f0 = np.full(n_frames, np.nan, dtype=np.float64)
    conf = np.zeros(n_frames, dtype=np.float64)
    return audio, f0, conf


def _make_white_noise(duration_s: float = 2.0, level: float = 0.3):
    n = int(SAMPLE_RATE * duration_s)
    rng = np.random.default_rng(42)
    audio = (rng.standard_normal(n).astype(np.float32) * level)
    audio = np.clip(audio, -0.99, 0.99)
    n_frames = n // HOP
    # CREPE em ruído puro: sem pitch (NaN) ou pitch errático com confiança baixa
    f0 = np.full(n_frames, np.nan, dtype=np.float64)
    conf = (rng.random(n_frames) * 0.30).astype(np.float64)  # 0..0.30
    return audio, f0, conf


def _make_percussion(duration_s: float = 2.0, n_clicks: int = 6):
    """Percussão: bursts de energia alta + sem pitch sustentado."""
    n = int(SAMPLE_RATE * duration_s)
    audio = np.zeros(n, dtype=np.float32)
    rng = np.random.default_rng(7)
    burst_len = HOP * 4  # 40ms por click
    spacing = n // (n_clicks + 1)
    for i in range(n_clicks):
        start = (i + 1) * spacing
        end = min(start + burst_len, n)
        # ataque forte com decaimento exponencial
        env = np.exp(-np.linspace(0, 4, end - start))
        click = rng.standard_normal(end - start).astype(np.float32) * 0.85
        audio[start:end] = (click * env).astype(np.float32)
    n_frames = n // HOP
    f0 = np.full(n_frames, np.nan, dtype=np.float64)
    conf = np.zeros(n_frames, dtype=np.float64)
    # Em alguns frames de click, CREPE pode reportar pitch instável com conf baixa
    for i in range(n_clicks):
        f_idx = ((i + 1) * spacing) // HOP
        if f_idx < n_frames:
            conf[f_idx] = 0.15  # baixíssima
    return audio, f0, conf


def _make_clean_voice(duration_s: float = 2.0, freq_hz: float = 220.0):
    """Voz cantada limpa sustentada (seno)."""
    n = int(SAMPLE_RATE * duration_s)
    t = np.arange(n) / SAMPLE_RATE
    audio = (0.4 * np.sin(2 * np.pi * freq_hz * t)).astype(np.float32)
    n_frames = n // HOP
    f0 = np.full(n_frames, freq_hz, dtype=np.float64)
    conf = np.full(n_frames, 0.85, dtype=np.float64)
    return audio, f0, conf


def _make_short_note(note_dur_ms: float = 80.0, total_dur_s: float = 1.5,
                     freq_hz: float = 220.0):
    """Uma nota curta isolada cercada de silêncio."""
    n = int(SAMPLE_RATE * total_dur_s)
    audio = np.zeros(n, dtype=np.float32)
    note_samples = int(SAMPLE_RATE * note_dur_ms / 1000)
    start = (n - note_samples) // 2
    t = np.arange(note_samples) / SAMPLE_RATE
    audio[start:start + note_samples] = (0.4 * np.sin(2 * np.pi * freq_hz * t)).astype(np.float32)
    n_frames = n // HOP
    f0 = np.full(n_frames, np.nan, dtype=np.float64)
    conf = np.zeros(n_frames, dtype=np.float64)
    f_start = start // HOP
    f_end = (start + note_samples) // HOP
    f0[f_start:f_end] = freq_hz
    conf[f_start:f_end] = 0.80
    return audio, f0, conf


def _make_unstable_pitch(duration_s: float = 2.0):
    """Pitch oscilando >2 semitons aleatoriamente — músico procurando tom."""
    n = int(SAMPLE_RATE * duration_s)
    n_frames = n // HOP
    rng = np.random.default_rng(11)
    # Pitch oscilando em torno de A3 (220Hz) com amplitude grande (±3st)
    base_midi = 57.0  # A3
    midi_jitter = rng.normal(0, 2.5, n_frames)  # std 2.5 semitons
    midis = base_midi + midi_jitter
    f0 = (440.0 * (2.0 ** ((midis - 69.0) / 12.0))).astype(np.float64)
    # Áudio: sintetizar seno frame-a-frame
    audio = np.zeros(n, dtype=np.float32)
    phase = 0.0
    for i in range(n_frames):
        f = float(f0[i])
        for s in range(HOP):
            idx = i * HOP + s
            if idx < n:
                phase += 2 * np.pi * f / SAMPLE_RATE
                audio[idx] = 0.4 * np.sin(phase)
    conf = np.full(n_frames, 0.75, dtype=np.float64)
    return audio, f0, conf


# ───────────────────────────────────────────────────────────────────────────
# Testes
# ───────────────────────────────────────────────────────────────────────────

def test_bypass_when_disabled():
    """enabled=False ⇒ passa direto, sem alterar f0/conf."""
    audio, f0, conf = _make_clean_voice(duration_s=1.5)
    cfg = VocalFocusConfig(enabled=False)
    res = apply_vocal_focus(audio, f0, conf, config=cfg)
    assert isinstance(res, VocalFocusResult)
    assert res.passed is True
    assert res.noise_stage == 'clean'
    assert res.audio_quality_score == 1.0
    # Filtered arrays devem ser idênticos aos originais
    assert res.filtered_f0 is not None
    assert np.allclose(res.filtered_f0, f0, equal_nan=True)


def test_silence_classified_as_silence():
    """Silêncio absoluto → noise_stage='silence', passed=False."""
    audio, f0, conf = _make_silence(duration_s=2.0)
    res = apply_vocal_focus(audio, f0, conf)
    assert res.passed is False
    # background_noise é o motivo dominante quando RMS ~ 0
    bg = res.rejection_counts.get(FRAME_BACKGROUND, 0)
    total = res.total_frames
    assert bg / max(total, 1) > 0.5, f"silêncio deveria ter >50% frames rejeitados como background, teve {bg}/{total}"
    assert res.noise_stage in ('silence', 'noisy'), f"esperado 'silence' ou 'noisy', recebeu '{res.noise_stage}'"


def test_white_noise_rejected():
    """Ruído branco → sem pitch sustentado, passed=False."""
    audio, f0, conf = _make_white_noise(duration_s=2.0, level=0.3)
    res = apply_vocal_focus(audio, f0, conf)
    assert res.passed is False
    # Quase tudo rejeitado por low_confidence ou no_vocal
    valid_ratio = res.valid_frames / max(res.total_frames, 1)
    assert valid_ratio < 0.10, f"ruído branco deveria rejeitar >90%, válidos: {valid_ratio:.0%}"
    assert res.noise_stage in ('noisy', 'silence', 'percussion')


def test_percussion_rejected():
    """Cliques percussivos → frames de percussão detectados."""
    audio, f0, conf = _make_percussion(duration_s=2.5, n_clicks=8)
    res = apply_vocal_focus(audio, f0, conf)
    assert res.passed is False
    # Espera-se que o detector de onset capture pelo menos alguns clicks.
    # Aceitamos como evidência: ou frames percussion>0, ou stage='percussion',
    # ou a maioria dos frames foi rejeitada (por low_conf).
    perc = res.rejection_counts.get(FRAME_PERCUSSION, 0)
    valid_ratio = res.valid_frames / max(res.total_frames, 1)
    assert valid_ratio < 0.15, f"percussão deveria rejeitar >85%, válidos: {valid_ratio:.0%}"
    # Heurística: o stage final deve ser ruim (não 'clean')
    assert res.noise_stage != 'clean'


def test_clean_voice_passes():
    """Voz limpa sustentada → passed=True, noise_stage='clean'."""
    audio, f0, conf = _make_clean_voice(duration_s=2.0, freq_hz=220.0)
    res = apply_vocal_focus(audio, f0, conf)
    assert res.passed is True, f"voz limpa deveria passar; razão: {res.rejection_reason}"
    assert res.noise_stage == 'clean'
    assert res.audio_quality_score >= 0.5
    valid_ratio = res.valid_frames / res.total_frames
    assert valid_ratio >= 0.70, f"voz limpa deveria ter >=70% frames válidos, teve {valid_ratio:.0%}"


def test_short_note_rejected():
    """Nota curta isolada (<120ms) é rejeitada como too_short."""
    audio, f0, conf = _make_short_note(note_dur_ms=80.0, total_dur_s=1.5, freq_hz=220.0)
    res = apply_vocal_focus(audio, f0, conf)
    # A nota curta deve ser rejeitada — verificamos que pelo menos alguns
    # frames foram marcados como too_short OU que valid_ratio é baixo.
    too_short_count = res.rejection_counts.get(FRAME_TOO_SHORT, 0)
    valid_ratio = res.valid_frames / res.total_frames
    assert too_short_count > 0 or valid_ratio < 0.10, (
        f"nota curta deveria gerar too_short>0 ou valid<10%, "
        f"too_short={too_short_count}, valid={valid_ratio:.0%}"
    )


def test_unstable_pitch_rejected():
    """Pitch oscilante > max_pitch_std_semitones → frames marcados unstable."""
    audio, f0, conf = _make_unstable_pitch(duration_s=2.0)
    cfg = VocalFocusConfig(max_pitch_std_semitones=1.5)  # padrão
    res = apply_vocal_focus(audio, f0, conf, config=cfg)
    unstable = res.rejection_counts.get(FRAME_UNSTABLE, 0)
    # Pelo menos alguns frames devem ser marcados como unstable
    assert unstable > 0, f"pitch instável deveria gerar unstable>0, teve {unstable}"


def test_clean_voice_with_aggressive_config_still_passes():
    """Mesmo com config agressiva, voz limpa não deve ser rejeitada."""
    audio, f0, conf = _make_clean_voice(duration_s=2.0, freq_hz=330.0)
    cfg = VocalFocusConfig(
        min_frame_confidence=0.50,
        min_note_duration_ms=200.0,
        max_pitch_std_semitones=1.0,
    )
    res = apply_vocal_focus(audio, f0, conf, config=cfg)
    assert res.passed is True, f"voz limpa deveria passar mesmo com config agressiva; reason: {res.rejection_reason}"


def test_payload_contract():
    """O resultado expõe sempre os campos contratados (não muda formato)."""
    audio, f0, conf = _make_clean_voice(duration_s=1.5)
    res = apply_vocal_focus(audio, f0, conf)
    assert hasattr(res, 'passed')
    assert hasattr(res, 'noise_stage')
    assert hasattr(res, 'audio_quality_score')
    assert hasattr(res, 'rejection_reason')
    assert hasattr(res, 'rejection_counts')
    assert hasattr(res, 'filtered_f0')
    assert hasattr(res, 'filtered_conf')
    assert hasattr(res, 'total_frames')
    assert hasattr(res, 'valid_frames')
    assert hasattr(res, 'rejected_frames')
    assert hasattr(res, 'processing_ms')
    assert res.noise_stage in ('clean', 'noisy', 'percussion', 'silence')


def test_no_frames_returns_gracefully():
    """Áudio com 0 frames não deve quebrar."""
    audio = np.zeros(10, dtype=np.float32)
    f0 = np.array([], dtype=np.float64)
    conf = np.array([], dtype=np.float64)
    res = apply_vocal_focus(audio, f0, conf)
    assert res.passed is False
    assert res.rejection_reason == 'no_frames'


if __name__ == '__main__':
    pytest.main([__file__, '-xvs'])
