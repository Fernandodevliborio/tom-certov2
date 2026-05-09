"""
test_vocal_instrument_focus.py — Testes do pré-processador modo Voz+Instrumento

Garante que:
  1. INSTRUMENT_CONFIG é mais permissivo que VocalFocusConfig() padrão
  2. Aceita áudio de instrumento isolado (seno em frequência típica de violão)
  3. Mantém rejeição de percussão (não relaxar isso)
  4. Bass de violão (E2 ~82Hz) é aceito (vocal_focus padrão rejeitaria)

Para rodar:
    cd /app/backend && pytest -xvs tests/test_vocal_instrument_focus.py
"""

from __future__ import annotations

import os
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from vocal_focus import apply_vocal_focus, VocalFocusConfig  # noqa: E402
from vocal_instrument_focus import INSTRUMENT_CONFIG  # noqa: E402

SR = 16000
HOP_MS = 10.0
HOP = int(SR * HOP_MS / 1000)


def _make_sine(freq_hz: float, duration_s: float = 2.0, amp: float = 0.4):
    n = int(SR * duration_s)
    t = np.arange(n) / SR
    audio = (amp * np.sin(2 * np.pi * freq_hz * t)).astype(np.float32)
    n_frames = n // HOP
    f0 = np.full(n_frames, freq_hz, dtype=np.float64)
    conf = np.full(n_frames, 0.80, dtype=np.float64)
    return audio, f0, conf


def _make_percussion(duration_s: float = 2.0, n_clicks: int = 6):
    n = int(SR * duration_s)
    audio = np.zeros(n, dtype=np.float32)
    rng = np.random.default_rng(7)
    burst_len = HOP * 4
    spacing = n // (n_clicks + 1)
    for i in range(n_clicks):
        s = (i + 1) * spacing
        e = min(s + burst_len, n)
        env = np.exp(-np.linspace(0, 4, e - s))
        click = rng.standard_normal(e - s).astype(np.float32) * 0.85
        audio[s:e] = (click * env).astype(np.float32)
    n_frames = n // HOP
    f0 = np.full(n_frames, np.nan, dtype=np.float64)
    conf = np.zeros(n_frames, dtype=np.float64)
    return audio, f0, conf


def test_instrument_config_is_more_permissive():
    default = VocalFocusConfig()
    assert INSTRUMENT_CONFIG.f0_min_hz < default.f0_min_hz
    assert INSTRUMENT_CONFIG.f0_max_hz > default.f0_max_hz
    assert INSTRUMENT_CONFIG.min_rms <= default.min_rms
    assert INSTRUMENT_CONFIG.min_frame_confidence <= default.min_frame_confidence


def test_bass_guitar_E2_passa_no_modo_instrumento():
    """E2 (82.4 Hz) é a corda mais grave do violão. vocal_focus padrão a rejeita
    (f0_min=80Hz é limite-borda), instrumento aceita (f0_min=50Hz)."""
    audio, f0, conf = _make_sine(82.41, duration_s=2.0, amp=0.3)
    # Garantir que conf alta
    res = apply_vocal_focus(audio, f0, conf, config=INSTRUMENT_CONFIG)
    assert res.passed is True, f"E2 deveria passar; reason: {res.rejection_reason}"
    assert res.noise_stage == 'clean'


def test_violao_dedilhado_simulado_passa():
    """Frequências típicas de violão (D3 ~146Hz)."""
    audio, f0, conf = _make_sine(146.83, duration_s=2.0)
    res = apply_vocal_focus(audio, f0, conf, config=INSTRUMENT_CONFIG)
    assert res.passed is True, f"D3 violão deveria passar; reason: {res.rejection_reason}"


def test_instrumento_agudo_C6_passa():
    """C6 (~1046Hz) — limite de teclado/piano. vocal_focus padrão (max 1100Hz)
    aceita; instrumento (max 1500Hz) também aceita com folga."""
    audio, f0, conf = _make_sine(1046.5, duration_s=2.0)
    res = apply_vocal_focus(audio, f0, conf, config=INSTRUMENT_CONFIG)
    assert res.passed is True


def test_percussao_continua_sendo_rejeitada():
    """REGRA: rejeição de percussão NÃO pode relaxar no modo instrumento."""
    audio, f0, conf = _make_percussion(duration_s=2.5, n_clicks=8)
    res = apply_vocal_focus(audio, f0, conf, config=INSTRUMENT_CONFIG)
    assert res.passed is False, "percussão NUNCA pode passar, mesmo no modo instrumento"
    assert res.noise_stage != 'clean'


def test_silencio_continua_rejeitado():
    n = SR * 2
    audio = np.zeros(n, dtype=np.float32)
    f0 = np.full(n // HOP, np.nan)
    conf = np.zeros(n // HOP)
    res = apply_vocal_focus(audio, f0, conf, config=INSTRUMENT_CONFIG)
    assert res.passed is False


if __name__ == '__main__':
    pytest.main([__file__, '-xvs'])
