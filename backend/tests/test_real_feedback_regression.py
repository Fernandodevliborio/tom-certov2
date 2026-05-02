"""
Testes de regressão baseados em 5 casos REAIS de erro reportados pelo usuário
via o botão "Tom errado?" no app (salvos no MongoDB).

Objetivo: O algoritmo v11 corrigido DEVE acertar todos estes 5 casos reais,
sem quebrar os testes sintéticos globais existentes (test_global_key_detection.py).

Cada fixture tem:
  - correct.tonic_pc / quality  → gabarito
  - notes_summary              → lista de {pc, dur_ms, conf, is_phrase_end}
                                   reconstituída do áudio real do usuário
"""
import json
import os
import pytest
from pathlib import Path

from key_detection_v10 import Note, analyze_tonality, NOTE_NAMES_BR

FIXTURES_PATH = Path(__file__).parent / "fixtures_real_feedback.json"


def load_fixtures():
    with open(FIXTURES_PATH) as fp:
        return json.load(fp)


def notes_from_summary(notes_summary):
    """Converte notes_summary (feedback) em List[Note] para analyze_tonality."""
    notes = []
    cursor_ms = 0.0
    for ns in notes_summary:
        notes.append(Note(
            pitch_class=int(ns["pc"]),
            midi=60.0 + int(ns["pc"]),  # MIDI placeholder (não afeta análise)
            dur_ms=float(ns["dur_ms"]),
            start_ms=cursor_ms,
            confidence=float(ns["conf"]),
            is_phrase_end=bool(ns["is_phrase_end"]),
        ))
        cursor_ms += float(ns["dur_ms"])
    return notes


FIXTURES = load_fixtures()


@pytest.mark.parametrize("fb_idx", range(len(FIXTURES)))
def test_real_feedback_case(fb_idx):
    """Cada um dos 5 feedbacks reais deve ser resolvido corretamente."""
    fb = FIXTURES[fb_idx]
    correct_pc = fb["correct"]["tonic_pc"]
    correct_quality = fb["correct"]["quality"]
    correct_name = fb["correct"]["key_name"]

    notes = notes_from_summary(fb["notes_summary"])
    result = analyze_tonality(notes)

    assert result.success, f"Case {fb_idx+1}: análise falhou"

    detected_name = (
        f"{NOTE_NAMES_BR[result.tonic]} "
        f"{'Maior' if result.quality == 'major' else 'menor'}"
    )

    assert result.tonic == correct_pc and result.quality == correct_quality, (
        f"Case {fb_idx+1} ({correct_name}): detectou {detected_name} "
        f"(tonic_pc={result.tonic}, quality={result.quality}, conf={result.confidence:.2f})\n"
        f"Debug: {result.debug}"
    )
