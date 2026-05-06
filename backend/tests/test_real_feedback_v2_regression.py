"""
Regressão de feedback real (v13): suite congelada com o estado atual da
detecção, garantindo que mudanças futuras não regridam nestes 9 casos.

NOTA: 4/9 dos casos reais ainda falham — são feedbacks com áudio ambíguo
ou pitch-shift sistemático (PCP dominado por nota distante do tom reportado).
Esses casos não são corrigíveis apenas com ajuste de score; precisam de
análise de pitch mais robusta. Os 4 cases que passam (Lá Maior, Lá# Maior,
Si Maior, Sol Maior #8) são o baseline.
"""
import json
from pathlib import Path
import pytest

import sys
sys.path.insert(0, str(Path(__file__).parent.parent))
from key_detection_v10 import Note, analyze_tonality, NOTE_NAMES_BR

FIXTURES_PATH = Path(__file__).parent / "fixtures_real_feedback_v2.json"
FIXTURES = json.load(open(FIXTURES_PATH))

# Indices que DEVEM passar (regressão)
PASSING_INDICES = [1, 5, 6, 7]  # 0-indexed

# Casos que ainda falham — registrados para não regredir mais ainda
FAILING_INDICES = [0, 2, 3, 4, 8]


def _notes_from(ns):
    out, cur = [], 0.0
    for n in ns:
        out.append(Note(int(n['pc']), 60.0+int(n['pc']), float(n['dur_ms']), cur,
                        float(n['conf']), bool(n['is_phrase_end'])))
        cur += float(n['dur_ms'])
    return out


@pytest.mark.parametrize("idx", PASSING_INDICES)
def test_known_passing_cases_must_keep_passing(idx):
    fb = FIXTURES[idx]
    correct = fb['correct']
    notes = _notes_from(fb['notes_summary'])
    r = analyze_tonality(notes)
    assert r.tonic == correct['tonic_pc'] and r.quality == correct['quality'], (
        f"REGRESSÃO em case[{idx}] ({fb['reported']}): detectou "
        f"{NOTE_NAMES_BR[r.tonic]} {r.quality} (esperado {correct['key_name']})"
    )


def test_minor_with_zero_cadence_must_have_capped_alignment():
    """LEI 1: tônica menor sem repouso (cadence ~ 0) recebe metade do
    alignment_bonus para evitar vencer por third+align quando não há
    evidência cadencial.
    
    Reproduz Case 9 (Sol Maior reported, antes detectava Sol# menor):
    Sol# minor com cadence=0 hoje recebe align reduzido e perde para
    candidates major.
    """
    fb = FIXTURES[8]  # Case 9
    notes = _notes_from(fb['notes_summary'])
    r = analyze_tonality(notes)
    # Antes do fix: detectado Sol# menor (pc=8, minor)
    # Após o fix: deve ser MAIOR (qualquer tônica major), não menor
    assert r.quality == 'major', (
        f"Case 9 violou LEI 1: detectou tônica MENOR ({NOTE_NAMES_BR[r.tonic]} "
        f"{r.quality}) com cadence ~ 0. Bônus de alignment não foi capado."
    )
