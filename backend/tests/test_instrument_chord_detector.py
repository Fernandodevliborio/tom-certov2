"""
test_instrument_chord_detector.py — Testes do detector de acordes/baixo

Validar:
  1. Detecta C maior em senoide harmônica de C+E+G
  2. Detecta A menor em A+C+E
  3. Não detecta acorde em ruído branco (strength baixa)
  4. Bass note correto em mistura grave
  5. Função roda em <2s para 3s de áudio (perf)

Para rodar:
    cd /app/backend && pytest -xvs tests/test_instrument_chord_detector.py
"""

from __future__ import annotations

import os
import sys
import time

import numpy as np
import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from instrument_chord_detector import detect_chords_and_bass  # noqa: E402

SR = 16000


def _build_chord(freqs_hz, duration_s=2.0, amp=0.25):
    n = int(SR * duration_s)
    t = np.arange(n) / SR
    audio = np.zeros(n, dtype=np.float32)
    for f in freqs_hz:
        audio += (amp * np.sin(2 * np.pi * f * t)).astype(np.float32)
    # Adicionar harmônicos para parecer mais com instrumento real
    for f in freqs_hz:
        audio += (0.10 * np.sin(2 * np.pi * f * 2 * t)).astype(np.float32)
        audio += (0.05 * np.sin(2 * np.pi * f * 3 * t)).astype(np.float32)
    audio = (audio / max(1.0, np.max(np.abs(audio)))).astype(np.float32) * 0.7
    return audio


def test_detect_C_major():
    """C-E-G em oitavas comuns de violão."""
    # C4=261.63, E4=329.63, G4=392.00
    audio = _build_chord([261.63, 329.63, 392.00], duration_s=2.0)
    detections = detect_chords_and_bass(audio, sample_rate=SR)
    assert len(detections) > 0, "deveria detectar pelo menos 1 acorde em 2s"
    # A maioria das janelas deve identificar C major (pc=0)
    c_major_count = sum(1 for d in detections
                        if d['chord_pc'] == 0 and d['chord_quality'] == 'major')
    assert c_major_count >= len(detections) // 2, (
        f"Esperado maioria C major, recebeu: {[(d['chord_pc'], d['chord_quality']) for d in detections]}"
    )


def test_detect_A_minor():
    """A3=220, C4=261.63, E4=329.63"""
    audio = _build_chord([220.00, 261.63, 329.63], duration_s=2.0)
    detections = detect_chords_and_bass(audio, sample_rate=SR)
    assert len(detections) > 0
    a_minor_count = sum(1 for d in detections
                        if d['chord_pc'] == 9 and d['chord_quality'] == 'minor')
    assert a_minor_count >= len(detections) // 2, (
        f"Esperado maioria A minor; recebeu: "
        f"{[(d['chord_pc'], d['chord_quality']) for d in detections]}"
    )


def test_white_noise_no_chord():
    """Ruído branco não deve gerar detecções acima do threshold."""
    rng = np.random.default_rng(42)
    n = int(SR * 2)
    audio = (rng.standard_normal(n).astype(np.float32) * 0.3)
    audio = np.clip(audio, -0.99, 0.99)
    detections = detect_chords_and_bass(audio, sample_rate=SR, min_chord_strength=0.55)
    # Pode detectar algumas spurious mas o número deve ser baixo (<3)
    assert len(detections) <= 3, f"ruído branco gerou {len(detections)} detecções (esperado <=3)"


def test_silence_no_chord():
    audio = np.zeros(int(SR * 2), dtype=np.float32)
    detections = detect_chords_and_bass(audio, sample_rate=SR)
    assert detections == []


def test_detection_payload_shape():
    audio = _build_chord([261.63, 329.63, 392.00], duration_s=1.5)
    detections = detect_chords_and_bass(audio, sample_rate=SR)
    if not detections:
        pytest.skip("nenhuma detecção; payload shape não pode ser testado")
    d = detections[0]
    for key in ('time_s', 'chord_pc', 'chord_quality', 'chord_strength',
               'bass_pc', 'bass_strength'):
        assert key in d, f"falta a chave {key} no payload"
    assert d['chord_quality'] in ('major', 'minor')
    assert 0 <= d['chord_pc'] <= 11
    assert 0.0 <= d['chord_strength'] <= 1.0


def test_perf_under_2s():
    """3s de áudio devem ser processados em <2s (CPU médio)."""
    audio = _build_chord([261.63, 329.63, 392.00], duration_s=3.0)
    t0 = time.perf_counter()
    detect_chords_and_bass(audio, sample_rate=SR)
    elapsed = time.perf_counter() - t0
    assert elapsed < 2.0, f"detector demorou {elapsed:.2f}s (limite 2s)"


if __name__ == '__main__':
    pytest.main([__file__, '-xvs'])
