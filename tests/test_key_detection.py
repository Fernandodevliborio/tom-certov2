"""
Testes Obrigatórios — Detecção de Tonalidade Tom Certo v10.1
============================================================
Execução: python -m pytest tests/test_key_detection.py -v
"""

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'backend'))

from key_detection_v10 import (
    Note, analyze_tonality, AnalysisResult,
    NOTE_NAMES_BR, KK_MAJOR, KK_MINOR
)

# ─── Helper ───────────────────────────────────────────────────────────────────

def make_notes(pitches_dur_end: list) -> list:
    """
    Cria lista de notas simuladas.
    pitches_dur_end: lista de (pitch_class, dur_ms, is_phrase_end)
    """
    notes = []
    t = 0.0
    for pc, dur, end in pitches_dur_end:
        notes.append(Note(
            pitch_class=pc,
            midi=60.0 + pc,
            dur_ms=float(dur),
            start_ms=t,
            confidence=0.80,
            is_phrase_end=end,
        ))
        t += dur
    return notes


# ─── Notas das escalas ────────────────────────────────────────────────────────
# Pitch classes: Dó=0, Ré=2, Mi=4, Fá=5, Sol=7, Lá=9, Si=11, Fá#=6

SOL = 7   # G
LA = 9    # A
SI = 11   # B
DO = 0    # C
RE = 2    # D
MI = 4    # E
FAsh = 6  # F#
FA = 5    # F


# ═══════════════════════════════════════════════════════════════════════════════
# TESTE 1 — Sol Maior NÃO pode virar Lá Maior
# ═══════════════════════════════════════════════════════════════════════════════
def test_sol_maior_nao_vira_la_maior():
    """
    Simula cantor em Sol Maior terminando frases em Sol e cantando a escala.
    Resultado esperado: Sol Maior (tônica=7, quality=major)
    O app estava retornando Lá Maior — isso NÃO deve acontecer.
    """
    notes = make_notes([
        # Escala de Sol Maior (Sol Si Ré Sol terminando forte)
        (SOL, 500, False),
        (LA, 200, False),
        (SI, 200, False),
        (DO, 200, False),
        (RE, 200, False),
        (MI, 200, False),
        (FAsh, 200, False),
        (SOL, 800, True),   # fim de frase em Sol — longa
        # Segunda frase
        (MI, 300, False),
        (RE, 300, False),
        (DO, 300, False),
        (SI, 300, False),
        (SOL, 700, True),   # fim de frase em Sol
        # Nota Lá presente mas não dominante
        (LA, 150, False),
        (SOL, 600, True),   # resolve em Sol
    ])
    
    result = analyze_tonality(notes)
    
    assert result.success, "Análise deve ter sucesso"
    assert result.tonic == SOL, (
        f"Sol Maior detectado como {NOTE_NAMES_BR[result.tonic]} {result.quality} "
        f"(esperado Sol Maior). "
        f"Debug: {result.debug.get('top_candidates', [])[:3]}"
    )
    assert result.quality == 'major', (
        f"Sol Maior classificado como {result.quality} (esperado major). "
        f"Mode evidence: {result.debug.get('mode_evidence', {})}"
    )


# ═══════════════════════════════════════════════════════════════════════════════
# TESTE 2 — Sol Maior NÃO pode virar Mi Menor sem evidência
# ═══════════════════════════════════════════════════════════════════════════════
def test_sol_maior_nao_vira_mi_menor():
    """
    Sol Maior e Mi Menor compartilham as mesmas notas mas têm centros tonais diferentes.
    Com frases terminando em Sol, deve detectar Sol Maior, não Mi Menor.
    """
    notes = make_notes([
        (SOL, 600, False),
        (MI, 300, False),
        (RE, 300, False),
        (DO, 300, False),
        (SI, 300, False),
        (LA, 250, False),
        (SOL, 900, True),   # repouso longo em Sol
        (FAsh, 200, False),
        (SOL, 800, True),   # outra frase termina em Sol
    ])
    
    result = analyze_tonality(notes)
    
    assert result.success
    assert result.tonic == SOL, (
        f"Esperado Sol, detectado {NOTE_NAMES_BR[result.tonic]} {result.quality}. "
        f"Top: {result.debug.get('top_candidates', [])[:3]}"
    )
    assert result.quality == 'major', (
        f"Esperado maior, detectado {result.quality}. "
        f"Mode evidence: {result.debug.get('mode_evidence', {})}"
    )


# ═══════════════════════════════════════════════════════════════════════════════
# TESTE 3 — Dó Maior NÃO pode virar Lá Menor sem centro tonal menor
# ═══════════════════════════════════════════════════════════════════════════════
def test_do_maior_nao_vira_la_menor():
    notes = make_notes([
        (DO, 500, False),
        (RE, 300, False),
        (MI, 300, False),
        (FA, 200, False),
        (SOL, 300, False),
        (LA, 200, False),
        (SI, 200, False),
        (DO, 800, True),    # fim de frase em Dó
        (SOL, 300, False),
        (FA, 300, False),
        (MI, 300, False),
        (RE, 300, False),
        (DO, 700, True),    # fim de frase em Dó
    ])
    
    result = analyze_tonality(notes)
    
    assert result.success
    assert result.tonic == DO, (
        f"Esperado Dó, detectado {NOTE_NAMES_BR[result.tonic]} {result.quality}"
    )
    assert result.quality == 'major'


# ═══════════════════════════════════════════════════════════════════════════════
# TESTE 4 — Ré Maior NÃO pode virar Fá# Menor sem cadência menor
# ═══════════════════════════════════════════════════════════════════════════════
def test_re_maior_nao_vira_fash_menor():
    RE_PC = 2
    MI_PC = 4
    FAsh_PC = 6
    SOL_PC = 7
    LA_PC = 9
    SI_PC = 11
    DOsh_PC = 1
    
    notes = make_notes([
        (RE_PC, 500, False),
        (MI_PC, 300, False),
        (FAsh_PC, 300, False),
        (SOL_PC, 200, False),
        (LA_PC, 300, False),
        (SI_PC, 200, False),
        (DOsh_PC, 200, False),
        (RE_PC, 800, True),   # fim de frase em Ré
        (LA_PC, 300, False),
        (SOL_PC, 300, False),
        (FAsh_PC, 250, False),
        (RE_PC, 700, True),   # fim de frase em Ré
    ])
    
    result = analyze_tonality(notes)
    
    assert result.success
    assert result.tonic == RE_PC, (
        f"Esperado Ré, detectado {NOTE_NAMES_BR[result.tonic]} {result.quality}"
    )
    assert result.quality == 'major'


# ═══════════════════════════════════════════════════════════════════════════════
# TESTE 5 — Tom Menor detectado quando há evidência real de menor
# ═══════════════════════════════════════════════════════════════════════════════
def test_la_menor_detectado_corretamente():
    """
    Lá Menor: Lá Dó Mi Lá — terça menor (Dó), 7ª menor (Sol), sem Fá#
    """
    LA_PC = 9
    SI_PC = 11
    DO_PC = 0
    RE_PC = 2
    MI_PC = 4
    FA_PC = 5
    SOL_PC = 7
    
    notes = make_notes([
        (LA_PC, 500, False),
        (SI_PC, 250, False),
        (DO_PC, 250, False),
        (RE_PC, 250, False),
        (MI_PC, 250, False),
        (FA_PC, 200, False),
        (SOL_PC, 200, False),
        (LA_PC, 900, True),   # fim de frase em Lá — longa
        (MI_PC, 300, False),
        (RE_PC, 300, False),
        (DO_PC, 400, False),
        (SI_PC, 250, False),
        (LA_PC, 800, True),   # outra frase termina em Lá
        (DO_PC, 400, False),  # Dó natural (terça menor de Lá)
        (MI_PC, 300, False),
        (LA_PC, 700, True),   # resolve em Lá
    ])
    
    result = analyze_tonality(notes)
    
    assert result.success
    assert result.tonic == LA_PC, (
        f"Esperado Lá, detectado {NOTE_NAMES_BR[result.tonic]} {result.quality}"
    )
    assert result.quality == 'minor', (
        f"Esperado menor, detectado {result.quality}. "
        f"Mode evidence: {result.debug.get('mode_evidence', {})}"
    )


# ═══════════════════════════════════════════════════════════════════════════════
# TESTE 6 — Resistência a notas passageiras fora do campo
# ═══════════════════════════════════════════════════════════════════════════════
def test_resistencia_notas_passageiras():
    """
    O app deve ignorar notas curtas passageiras e manter Sol Maior.
    Simulando cromatismo passageiro (notas de 80ms que não são do campo).
    """
    LAsh = 10  # Lá# — fora de Sol Maior
    DOsh = 1   # Dó# — fora de Sol Maior
    
    notes = make_notes([
        (SOL, 500, False),
        (LAsh, 80, False),   # nota passageira — fora do campo, muito curta
        (LA, 200, False),
        (DOsh, 80, False),   # nota passageira
        (SI, 300, False),
        (DO, 200, False),
        (RE, 300, False),
        (SOL, 800, True),    # fim de frase forte em Sol
        (MI, 300, False),
        (FAsh, 250, False),
        (SOL, 700, True),    # outra frase em Sol
    ])
    
    result = analyze_tonality(notes)
    
    assert result.success
    assert result.tonic == SOL, (
        f"Esperado Sol Maior, detectado {NOTE_NAMES_BR[result.tonic]} {result.quality}"
    )
    assert result.quality == 'major'


# ═══════════════════════════════════════════════════════════════════════════════
# TESTE 7 — Verificar que MAX_GAP é 150ms (não 30ms)
# ═══════════════════════════════════════════════════════════════════════════════
def test_phrase_end_gap_threshold():
    """
    Verificar que a constante MAX_GAP no código é 15 frames (150ms).
    Isso garante que vibratos e micro-pausas não viram fins de frase.
    """
    from key_detection_v10 import HOP_MS
    
    # MAX_GAP está na função pitch_to_notes, mas o HOP_MS deve ser 10ms
    assert HOP_MS == 10, f"HOP_MS esperado 10ms, obtido {HOP_MS}"
    
    # O MAX_GAP equivalente em ms (15 × 10ms = 150ms) — verificar indiretamente
    # Notas curtas com gaps de 50ms não devem ser marcadas como fim de frase
    # (isso é garantido pelo MAX_GAP = 15 frames = 150ms no código)
    
    # Teste indireto: gerar áudio sintético com gap de 50ms e verificar
    # que a nota anterior NÃO é marcada como phrase_end
    import numpy as np
    from key_detection_v10 import pitch_to_notes, SAMPLE_RATE
    
    sr = SAMPLE_RATE
    hop = int(sr * 0.010)  # 10ms hop
    
    # Simular: Sol por 0.5s, silêncio por 0.05s (50ms), Sol por 0.5s
    total_frames = int(1.1 * 1000 / 10)  # 1.1s em frames de 10ms
    f0 = np.zeros(total_frames)
    conf = np.zeros(total_frames)
    
    sol_hz = 392.0  # G4
    
    # 0-500ms: Sol
    for i in range(50):
        f0[i] = sol_hz
        conf[i] = 0.9
    
    # 500-550ms: silêncio (gap de 50ms = 5 frames) → NÃO deve ser fim de frase (< 15 frames)
    # f0 permanece 0 (nan após conversão)
    
    # 550-1100ms: Sol
    for i in range(55, 110):
        f0[i] = sol_hz
        conf[i] = 0.9
    
    import numpy as np
    f0_nan = np.where(f0 > 0, f0, np.nan)
    
    notes = pitch_to_notes(f0_nan, conf)
    
    # Deve ter 1 nota Sol (gap de 50ms é menor que 150ms, então não houve fim de frase)
    # OU 2 notas Sol, mas nenhuma marcada como is_phrase_end no meio
    phrase_ends_mid = [n for n in notes if n.is_phrase_end and n.pitch_class == 7 and notes.index(n) < len(notes) - 1]
    assert len(phrase_ends_mid) == 0, (
        f"Gap de 50ms não deve gerar fim de frase no meio. Notas: {[(n.pitch_class, n.dur_ms, n.is_phrase_end) for n in notes]}"
    )


# ═══════════════════════════════════════════════════════════════════════════════
# TESTE 8 — Maior detectado como padrão quando terça é ambígua
# ═══════════════════════════════════════════════════════════════════════════════
def test_default_para_maior_quando_ambiguo():
    """
    Quando a evidência de maior/menor é igual, deve ser maior.
    Músicas populares têm maioria de tonalidades maiores.
    """
    # Escala sem terça nenhuma (só tônica, 5ª e 4ª)
    DO_PC = 0
    SOL_PC = 7
    FA_PC = 5
    RE_PC = 2
    LA_PC = 9
    
    notes = make_notes([
        (DO_PC, 500, False),
        (SOL_PC, 400, False),
        (FA_PC, 300, False),
        (RE_PC, 300, False),
        (DO_PC, 800, True),
        (SOL_PC, 400, False),
        (DO_PC, 700, True),
    ])
    
    result = analyze_tonality(notes)
    
    assert result.success
    # Quando ambíguo, deve retornar maior
    assert result.quality == 'major', (
        f"Esperado maior (padrão), detectado {result.quality}"
    )


if __name__ == '__main__':
    import pytest
    pytest.main([__file__, '-v', '--tb=short'])
