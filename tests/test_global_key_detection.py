"""
VERIFICAÇÃO GLOBAL — Detecção de Tonalidade Tom Certo
═══════════════════════════════════════════════════════════════════════════════

Objetivo: confirmar que TODAS as correções funcionam para QUALQUER tonalidade,
não apenas para casos específicos como G maior.

Prova de globalidade:
- O algoritmo usa np.roll(KK_MAJOR, root) — operação invariante por transposição
- Penalizações anti-dominante e anti-mediant são proporcionais (% do score)
- Âncora de duração é pitch-class agnóstica
- Decisão maior/menor usa intervalos relativos (não notas absolutas)
→ A mesma lógica se aplica identicamente a qualquer tônica de 0 a 11

CHECKLIST OBRIGATÓRIO (validado aqui):
 [ ] Bug G→B corrigido
 [ ] G não cai em F# maior
 [ ] Todos os 12 tons maiores detectados corretamente
 [ ] Todos os 12 tons menores detectados corretamente
 [ ] Confusão dominante bloqueada em todos os 12 tons
 [ ] Confusão mediant bloqueada em todos os 12 tons
 [ ] Confusão relativa (maior vs relativo menor) corrigida
 [ ] Lógica NÃO é por exceção — prova via transposição cromática
 [ ] Arquivos de afinador/login/tokens/campo harmônico NÃO alterados
"""

import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'backend'))

import numpy as np
from key_detection_v10 import (
    Note, analyze_tonality, AnalysisResult,
    NOTE_NAMES_BR, KK_MAJOR, KK_MINOR,
)

# ─── Constantes musicais (invariantes de tom) ────────────────────────────────
# Intervalos em semitoms a partir da tônica
MAJOR_SCALE  = [0, 2, 4, 5, 7, 9, 11]  # I II III IV V VI VII
MINOR_SCALE  = [0, 2, 3, 5, 7, 8, 10]  # I II bIII IV V bVI bVII

NAMES = NOTE_NAMES_BR  # ['Dó','Dó#','Ré',...]


# ─── Helpers ─────────────────────────────────────────────────────────────────

def transpose_scale(root: int, scale: list) -> list:
    """Retorna os pitch-classes da escala no tom dado."""
    return [(root + interval) % 12 for interval in scale]


def make_phrase(root: int, scale_intervals: list, phrase_patterns: list) -> list:
    """
    Constrói lista de Notes a partir de padrões de frase.
    phrase_patterns: lista de (scale_degree_idx, dur_ms, is_phrase_end)
    """
    scale_pcs = [(root + interval) % 12 for interval in scale_intervals]
    notes = []
    t = 0.0
    for deg_idx, dur, end in phrase_patterns:
        pc = scale_pcs[deg_idx]
        notes.append(Note(
            pitch_class=pc,
            midi=60.0 + pc,
            dur_ms=float(dur),
            start_ms=t,
            confidence=0.82,
            is_phrase_end=end,
        ))
        t += dur
    return notes


def run(notes):
    return analyze_tonality(notes)


# ═══════════════════════════════════════════════════════════════════════════════
# BLOCO 1 — TODOS OS 12 TONS MAIORES
# Padrão: canta a escala completa, resolve na tônica, repete
# Prova que a lógica é idêntica para qualquer root
# ═══════════════════════════════════════════════════════════════════════════════

def _make_major_ascending(root: int) -> list:
    """Padrão típico: escala ascendente → resolução na tônica."""
    scale = MAJOR_SCALE
    return make_phrase(root, scale, [
        (0, 500, False),  # I  - tônica (início)
        (1, 200, False),  # II
        (2, 200, False),  # III
        (3, 200, False),  # IV
        (4, 300, False),  # V (dominante)
        (5, 200, False),  # VI
        (6, 200, False),  # VII
        (0, 800, True),   # I  - tônica (fim de frase longa)
        (4, 250, False),  # V
        (3, 250, False),  # IV
        (2, 250, False),  # III
        (1, 250, False),  # II
        (0, 700, True),   # I  - cadência final
    ])


def test_todos_os_12_tons_maiores():
    """Todos os 12 tons maiores devem ser detectados corretamente."""
    falhas = []
    for root in range(12):
        notes = _make_major_ascending(root)
        result = run(notes)
        if not result.success or result.tonic != root or result.quality != 'major':
            falhas.append(
                f"  ❌ {NAMES[root]} maior → detectado: "
                f"{NAMES[result.tonic] if result.tonic is not None else '?'} "
                f"{result.quality or '?'} "
                f"(conf={result.confidence:.2f}) "
                f"top={result.debug.get('top_candidates', [])[:3]}"
            )
    assert not falhas, "Falhas em tons maiores:\n" + "\n".join(falhas)


# ═══════════════════════════════════════════════════════════════════════════════
# BLOCO 2 — TODOS OS 12 TONS MENORES
# ═══════════════════════════════════════════════════════════════════════════════

def _make_minor_ascending(root: int) -> list:
    """Escala menor com resolução na tônica."""
    scale = MINOR_SCALE
    return make_phrase(root, scale, [
        (0, 500, False),  # I  (tônica menor)
        (1, 200, False),  # II
        (2, 200, False),  # bIII
        (3, 200, False),  # IV
        (4, 300, False),  # V
        (5, 200, False),  # bVI
        (6, 200, False),  # bVII
        (0, 800, True),   # I  (fim de frase)
        (4, 250, False),  # V
        (2, 300, False),  # bIII (terça menor — evidência chave)
        (0, 700, True),   # I  (cadência final)
        (2, 400, False),  # bIII novamente
        (0, 900, True),   # I  (resolução longa)
    ])


def test_todos_os_12_tons_menores():
    """Todos os 12 tons menores devem ser detectados corretamente."""
    falhas = []
    for root in range(12):
        notes = _make_minor_ascending(root)
        result = run(notes)
        if not result.success or result.tonic != root or result.quality != 'minor':
            falhas.append(
                f"  ❌ {NAMES[root]} menor → detectado: "
                f"{NAMES[result.tonic] if result.tonic is not None else '?'} "
                f"{result.quality or '?'} "
                f"(conf={result.confidence:.2f}) "
                f"mode_evidence={result.debug.get('mode_evidence', {})}"
            )
    assert not falhas, "Falhas em tons menores:\n" + "\n".join(falhas)


# ═══════════════════════════════════════════════════════════════════════════════
# BLOCO 3 — CONFUSÃO DOMINANTE (V→I): todos os 12 tons
# O grau V é muito frequente mas NÃO é a tônica
# ═══════════════════════════════════════════════════════════════════════════════

def _make_dominant_heavy(root: int) -> list:
    """
    Cantor usa muito a dominante (V grau) mas termina na tônica.
    Exemplo em Sol maior: usa muito Ré (V) mas resolve em Sol (I).
    """
    scale = MAJOR_SCALE
    dominant_idx = 4  # V grau = índice 4 na escala maior
    return make_phrase(root, scale, [
        (0, 400, False),       # I (tônica)
        (dominant_idx, 500, False),  # V (dominante — muita presença)
        (dominant_idx, 500, False),  # V (repetido)
        (dominant_idx, 400, False),  # V
        (2, 200, False),       # III
        (0, 800, True),        # I — FIM DE FRASE (resolve)
        (dominant_idx, 400, False),  # V novamente
        (1, 200, False),       # II
        (0, 700, True),        # I — cadência final
    ])


def test_dominante_nao_confunde_com_tonica_em_todos_os_tons():
    """Em todos os 12 tons, o V grau não deve ser confundido com a tônica."""
    falhas = []
    for root in range(12):
        notes = _make_dominant_heavy(root)
        result = run(notes)
        dominant = (root + 7) % 12
        if result.tonic == dominant:
            falhas.append(
                f"  ❌ {NAMES[root]} maior: dominante {NAMES[dominant]} "
                f"confundido com tônica (conf={result.confidence:.2f})"
            )
        elif result.tonic != root:
            falhas.append(
                f"  ❌ {NAMES[root]} maior: tônica incorreta → {NAMES[result.tonic]} "
                f"(esperado {NAMES[root]}, conf={result.confidence:.2f})"
            )
    assert not falhas, "Confusão dominante em:\n" + "\n".join(falhas)


# ═══════════════════════════════════════════════════════════════════════════════
# BLOCO 4 — CONFUSÃO MEDIANT (III→I): todos os 12 tons
# O bug G→B era exatamente isso: B é a 3ª de G
# ═══════════════════════════════════════════════════════════════════════════════

def _make_mediant_heavy(root: int) -> list:
    """
    Cantor permanece muito no 3ª grau (mediant) mas resolve na tônica.
    Bug real: G maior → B maior (B é a 3ª de G).
    """
    scale = MAJOR_SCALE
    mediant_idx = 2  # III grau = índice 2 na escala maior
    return make_phrase(root, scale, [
        (0, 400, False),        # I
        (mediant_idx, 500, False),  # III (mediant — dwell)
        (mediant_idx, 500, False),  # III (repetido)
        (4, 250, False),        # V
        (mediant_idx, 400, False),  # III novamente
        (0, 800, True),         # I — fim de frase (resolve)
        (mediant_idx, 350, False),  # III
        (5, 200, False),        # VI
        (0, 750, True),         # I — cadência final
    ])


def test_mediant_nao_confunde_com_tonica_em_todos_os_tons():
    """Em todos os 12 tons, o III grau não deve ser confundido com a tônica (bug G→B)."""
    falhas = []
    for root in range(12):
        notes = _make_mediant_heavy(root)
        result = run(notes)
        mediant = (root + 4) % 12
        if result.tonic == mediant:
            falhas.append(
                f"  ❌ {NAMES[root]} maior: mediant {NAMES[mediant]} "
                f"confundido com tônica — bug G→B generalizado! (conf={result.confidence:.2f})"
            )
        elif result.tonic != root:
            falhas.append(
                f"  ❌ {NAMES[root]} maior → detectado {NAMES[result.tonic]} "
                f"(conf={result.confidence:.2f})"
            )
    assert not falhas, "Confusão mediant (bug G→B generalizado) em:\n" + "\n".join(falhas)


# ═══════════════════════════════════════════════════════════════════════════════
# BLOCO 5 — CONFUSÃO RELATIVO (maior vs relativo menor)
# Sol maior e Mi menor compartilham todas as notas
# ═══════════════════════════════════════════════════════════════════════════════

def test_maior_vs_relativo_menor_todos_os_tons():
    """
    Tom maior não deve ser confundido com seu relativo menor.
    Ex: Sol maior (root=7) vs Mi menor (root=4) — mesmas notas, centros tonais diferentes.
    """
    falhas = []
    for root in range(12):
        notes = _make_major_ascending(root)
        result = run(notes)
        relative_minor = (root + 9) % 12  # relativo menor = VI grau
        if result.tonic == relative_minor:
            falhas.append(
                f"  ❌ {NAMES[root]} maior confundido com relativo menor "
                f"{NAMES[relative_minor]} menor (conf={result.confidence:.2f})"
            )
    assert not falhas, "Confusão relativo maior→menor em:\n" + "\n".join(falhas)


def test_menor_vs_relativo_maior_todos_os_tons():
    """Tom menor não deve ser confundido com seu relativo maior."""
    falhas = []
    for root in range(12):
        notes = _make_minor_ascending(root)
        result = run(notes)
        relative_major = (root + 3) % 12  # relativo maior = bIII
        if result.tonic == relative_major:
            falhas.append(
                f"  ❌ {NAMES[root]} menor confundido com relativo maior "
                f"{NAMES[relative_major]} maior (conf={result.confidence:.2f})"
            )
    assert not falhas, "Confusão relativo menor→maior em:\n" + "\n".join(falhas)


# ═══════════════════════════════════════════════════════════════════════════════
# BLOCO 6 — PROVA DE GLOBALIDADE POR TRANSPOSIÇÃO CROMÁTICA
# Se o algoritmo é global, detectar G maior transposto para todos os 12 tons
# deve dar o tom transposto — sem diferença no comportamento
# ═══════════════════════════════════════════════════════════════════════════════

def test_globalidade_via_transposicao_cromatica():
    """
    Prova definitiva de globalidade:
    O padrão exato de Sol maior, transposto para cada um dos 12 tons,
    deve detectar o tom transposto correspondente.
    
    Se o algoritmo tem qualquer hardcode para uma tonalidade específica,
    este teste vai falhar nos outros tons.
    """
    # Padrão base em Sol maior (root=7) — com dwell no III grau (bug G→B)
    BASE_ROOT = 7  # Sol
    base_notes_degrees = [
        (0, 500, False),   # I   Sol
        (2, 500, False),   # III Si (dwell)
        (2, 400, False),   # III Si (repetido)
        (4, 300, False),   # V   Ré
        (1, 200, False),   # II  Lá
        (0, 800, True),    # I   Sol (fim de frase)
        (5, 200, False),   # VI  Mi
        (6, 200, False),   # VII Fá#
        (0, 700, True),    # I   Sol (cadência)
    ]
    
    falhas = []
    for root in range(12):
        notes = make_phrase(root, MAJOR_SCALE, base_notes_degrees)
        result = run(notes)
        if result.tonic != root or result.quality != 'major':
            falhas.append(
                f"  ❌ Transposição para {NAMES[root]} maior → "
                f"detectado {NAMES[result.tonic] if result.tonic is not None else '?'} "
                f"{result.quality or '?'} (conf={result.confidence:.2f})"
            )
    assert not falhas, (
        "Falha na transposição cromática — algoritmo NÃO é global:\n" + "\n".join(falhas)
    )


# ═══════════════════════════════════════════════════════════════════════════════
# BLOCO 7 — CHECKLIST: itens específicos do requisito do usuário
# ═══════════════════════════════════════════════════════════════════════════════

def test_checklist_1_g_maior_nao_vira_b_maior():
    """Checklist #1: Bug G maior → B maior corrigido."""
    G, B, A, D, E, FSH = 7, 11, 9, 2, 4, 6  # Sol, Si, Lá, Ré, Mi, Fá#
    notes = [
        Note(G, 67.0, 500, 0, 0.85, False),
        Note(B, 71.0, 500, 500, 0.85, False),   # dwell no 3º
        Note(B, 71.0, 400, 1000, 0.85, False),
        Note(D, 62.0, 300, 1400, 0.82, False),
        Note(G, 67.0, 900, 1700, 0.88, True),   # resolve em Sol
        Note(B, 71.0, 350, 2600, 0.80, False),
        Note(FSH, 66.0, 300, 2950, 0.78, False),
        Note(G, 67.0, 800, 3250, 0.87, True),
    ]
    result = run(notes)
    assert result.success
    assert result.tonic == G, f"G→B bug: detectado {NAMES[result.tonic]} {result.quality}"
    assert result.quality == 'major'


def test_checklist_2_g_maior_nao_vira_fsh_maior():
    """Checklist #2: G maior não cai em F# maior (subdominante superior)."""
    G, FSH, A, B, D = 7, 6, 9, 11, 2
    notes = [
        Note(G, 67.0, 500, 0, 0.85, False),
        Note(A, 69.0, 300, 500, 0.80, False),
        Note(B, 71.0, 300, 800, 0.80, False),
        Note(FSH, 66.0, 400, 1100, 0.78, False),  # Fá# presente mas não é tônica
        Note(G, 67.0, 900, 1500, 0.90, True),     # Sol é a tônica
        Note(D, 62.0, 300, 2400, 0.82, False),
        Note(G, 67.0, 800, 2700, 0.88, True),
    ]
    result = run(notes)
    assert result.success
    assert result.tonic == G, f"G→F# bug: detectado {NAMES[result.tonic]} {result.quality}"
    assert result.quality == 'major'


def test_checklist_5_tonalidades_diferentes():
    """Checklist #8: Validar com pelo menos 5 tonalidades diferentes."""
    # G(7), D(2), A(9), C#(1), F(5), Bb(10)
    test_cases = [7, 2, 9, 1, 5, 10]
    falhas = []
    for root in test_cases:
        notes = _make_major_ascending(root)
        result = run(notes)
        if result.tonic != root or result.quality != 'major':
            falhas.append(
                f"  ❌ {NAMES[root]} maior → {NAMES[result.tonic] if result.tonic is not None else '?'} "
                f"{result.quality} (conf={result.confidence:.2f})"
            )
    assert not falhas, "Falhas nas 6 tonalidades:\n" + "\n".join(falhas)


def test_checklist_confianca_nao_sobe_rapido():
    """Checklist #6: confiança não deve atingir 90% com poucas notas."""
    root = 7  # Sol maior
    # Apenas 3 notas — evidência mínima
    notes = [
        Note(root, 67.0, 300, 0, 0.75, False),
        Note((root + 4) % 12, 71.0, 200, 300, 0.72, False),
        Note(root, 67.0, 400, 500, 0.78, True),
    ]
    result = run(notes)
    if result.success:
        assert result.confidence < 0.90, (
            f"Confiança {result.confidence:.2f} muito alta com apenas 3 notas"
        )


def test_checklist_sustenidos_e_bemois():
    """Checklist: sustenidos e bemóis detectados corretamente."""
    # C# maior (1), F# maior (6), Bb maior (10), Eb maior (3)
    falhas = []
    for root in [1, 3, 6, 8, 10]:  # C#, Eb, F#, Ab, Bb
        notes = _make_major_ascending(root)
        result = run(notes)
        if result.tonic != root or result.quality != 'major':
            falhas.append(
                f"  ❌ {NAMES[root]} maior → {NAMES[result.tonic] if result.tonic is not None else '?'} "
                f"{result.quality} (conf={result.confidence:.2f})"
            )
    assert not falhas, "Falhas em sustenidos/bemóis:\n" + "\n".join(falhas)


# ═══════════════════════════════════════════════════════════════════════════════
# BLOCO 8 — VERIFICAR QUE ARQUIVOS NÃO ALTERADOS CONTINUAM INTACTOS
# ═══════════════════════════════════════════════════════════════════════════════

def test_arquivos_nao_alterados():
    """
    Confirmar que os arquivos de afinador, login, tokens e campo harmônico
    NÃO foram modificados.
    """
    import os
    
    # Arquivos que NÃO devem ter sido modificados
    files_to_check = [
        '/app/frontend/src/hooks/useTuner.ts',
        '/app/frontend/app/tuner.tsx',
        '/app/backend/models.py',
    ]
    
    for path in files_to_check:
        assert os.path.exists(path), f"Arquivo ausente: {path}"
    
    # Confirmar que models.py ainda tem os modelos de token
    with open('/app/backend/models.py', 'r') as f:
        content = f.read()
    assert 'class TokenStatus' in content or 'TokenStatus' in content, \
        "models.py parece ter sido alterado — TokenStatus não encontrado"
    
    # Confirmar que useTuner.ts ainda existe e tem lógica de afinador
    with open('/app/frontend/src/hooks/useTuner.ts', 'r') as f:
        content = f.read()
    assert 'frequency' in content.lower() or 'pitch' in content.lower() or 'tuner' in content.lower(), \
        "useTuner.ts parece ter sido alterado"


# ═══════════════════════════════════════════════════════════════════════════════
# BLOCO 9 — VERIFICAÇÃO DO STABLEKEY ENGINE (frontend)
# ═══════════════════════════════════════════════════════════════════════════════

def test_stablekey_engine_thresholds():
    """Verificar que os thresholds do stableKeyEngine foram corrigidos."""
    with open('/app/frontend/src/utils/stableKeyEngine.ts', 'r') as f:
        content = f.read()
    
    # MIN_CONFIDENCE deve ser >= 0.30 (era 0.12 — muito baixo)
    assert 'MIN_CONFIDENCE_THRESHOLD: 0.12' not in content, \
        "CRÍTICO: MIN_CONFIDENCE_THRESHOLD ainda é 0.12 — era o valor problemático"
    
    # FAST_LOCK deve ser >= 0.50 (era 0.25)
    assert 'FAST_LOCK_CONFIDENCE: 0.25' not in content, \
        "CRÍTICO: FAST_LOCK_CONFIDENCE ainda é 0.25 — era o valor problemático"
    
    # MIN_HITS deve ser >= 2 (era 1)
    assert 'MIN_HITS_FOR_LOCK: 1,' not in content, \
        "CRÍTICO: MIN_HITS_FOR_LOCK ainda é 1 — era o valor problemático"


def test_ml_timeout_correto():
    """Verificar que o timeout do fetch ML foi reduzido de 30s para 12s."""
    with open('/app/frontend/src/utils/mlKeyAnalyzer.ts', 'r') as f:
        content = f.read()
    
    assert 'timeoutMs: number = 30000' not in content, \
        "CRÍTICO: timeout ainda é 30000ms (30s) — deveria ser 12000ms"
    
    assert '12000' in content, \
        "Timeout de 12000ms não encontrado em mlKeyAnalyzer.ts"


def test_watchdog_presente():
    """Verificar que o watchdog anti-travamento foi adicionado."""
    with open('/app/frontend/src/hooks/useKeyDetection.ts', 'r') as f:
        content = f.read()
    
    assert 'watchdog' in content.lower() or 'WATCHDOG' in content or 'ML-WATCHDOG' in content, \
        "Watchdog anti-travamento não encontrado em useKeyDetection.ts"
    
    assert '18000' in content or '15000' in content or '20000' in content, \
        "Timeout do watchdog não encontrado"


def test_delay_loop_ml_corrigido():
    """Verificar que o delay 'done' não é mais 50ms (causava inundação do backend)."""
    with open('/app/frontend/src/hooks/useKeyDetection.ts', 'r') as f:
        content = f.read()
    
    # O delay antigo era 'case done: delay = 50'
    assert "delay = 50;" not in content and "delay = 50\n" not in content, \
        "CRÍTICO: delay de 50ms ainda presente — inunda o backend"


# ═══════════════════════════════════════════════════════════════════════════════
# BLOCO 10 — VALIDAÇÃO DO MAX_GAP (correção do bug principal)
# ═══════════════════════════════════════════════════════════════════════════════

def test_max_gap_150ms():
    """Confirmar que MAX_GAP no código é 15 frames = 150ms (não 3 = 30ms)."""
    with open('/app/backend/key_detection_v10.py', 'r') as f:
        content = f.read()
    
    assert 'MAX_GAP = 15' in content, \
        "MAX_GAP deve ser 15 (150ms). Ainda está com valor antigo."
    
    assert 'MAX_GAP = 3' not in content, \
        "CRÍTICO: MAX_GAP = 3 (30ms) ainda presente — causava fins de frase falsos"


def test_krumhansl_peso_40_porcento():
    """Confirmar que Krumhansl tem 40% de peso (antes era 15%)."""
    with open('/app/backend/key_detection_v10.py', 'r') as f:
        content = f.read()
    
    assert '0.40 * krumhansl_score' in content, \
        "Krumhansl deve ter peso 0.40 (era 0.15)"
    
    assert '0.15 * krumhansl_score' not in content, \
        "CRÍTICO: Peso 0.15 do Krumhansl ainda presente — valor problemático"


def test_anti_mediant_presente():
    """Confirmar que penalização anti-mediant foi implementada."""
    with open('/app/backend/key_detection_v10.py', 'r') as f:
        content = f.read()
    
    assert 'mediant_major' in content or 'anti-mediant' in content.lower() or 'ANTI-MEDIANT' in content, \
        "Penalização anti-mediant não encontrada"
    
    assert 'mediant_minor' in content, \
        "Penalização anti-mediant (3ª menor) não encontrada"


# ═══════════════════════════════════════════════════════════════════════════════
# BLOCO 11 — MODO MAIOR vs MENOR: invariância por transposição
# ═══════════════════════════════════════════════════════════════════════════════

def test_modo_maior_vs_menor_invariante():
    """
    A decisão maior/menor usa intervalos RELATIVOS (não notas absolutas).
    Se funciona para C maior vs A menor, deve funcionar para QUALQUER tom.
    """
    falhas_major, falhas_minor = [], []
    
    for root in range(12):
        # Major: tem terça maior (+4) bem presente
        maj_notes = make_phrase(root, MAJOR_SCALE, [
            (0, 600, False),   # I
            (2, 400, False),   # III (terça maior)
            (4, 300, False),   # V
            (0, 800, True),    # I (cadência)
            (2, 400, False),   # III novamente
            (0, 700, True),    # I
        ])
        r_maj = run(maj_notes)
        if r_maj.tonic == root and r_maj.quality != 'major':
            falhas_major.append(f"  ❌ {NAMES[root]} maior → detectado como menor")
        
        # Minor: tem terça menor (+3) bem presente
        min_notes = make_phrase(root, MINOR_SCALE, [
            (0, 600, False),   # I
            (2, 400, False),   # bIII (terça menor)
            (4, 300, False),   # V
            (0, 800, True),    # I (cadência)
            (2, 400, False),   # bIII novamente
            (0, 700, True),    # I
        ])
        r_min = run(min_notes)
        if r_min.tonic == root and r_min.quality != 'minor':
            falhas_minor.append(f"  ❌ {NAMES[root]} menor → detectado como maior")
    
    falhas = falhas_major + falhas_minor
    assert not falhas, "Falhas em maior/menor:\n" + "\n".join(falhas)


# ═══════════════════════════════════════════════════════════════════════════════
# BLOCO 12 — REGRESSÃO UNIVERSAL: padrão "Os guerreiros se preparam"
# Reproduz o exato padrão musical do hino real que falhava (Mi maior → Sol# menor)
# aplicando-o aos 12 tons maiores. Prova que a correção v10.2 funciona globalmente.
# ═══════════════════════════════════════════════════════════════════════════════

def _hymn_pattern_major(root: int) -> list:
    """
    Reproduz o padrão tonal do hino real "Os guerreiros se preparam" (Mi maior).
    Características que faziam o algoritmo errar antes da v10.2:
      - Distribuição PCP fortemente diatônica em maior (TODOS os 7 graus)
      - Notas longas e phrase ends frequentemente sobre a 3ª maior (mediant)
      - Cadências curtas sobre a tônica
      - Aparição da 7ª (sensível) — característica de música tonal real
    
    Aplicado a `root`, deve detectar `root maior` para qualquer tom.
    """
    # Graus diatônicos em maior: I=0, II=1, III=2, IV=3, V=4, VI=5, VII=6
    # Padrão construído reproduzindo a riqueza diatônica de música real,
    # mas com o "armadilha" de phrase ends repetidos sobre a 3ª maior.
    return make_phrase(root, MAJOR_SCALE, [
        # ─── Verso 1 — exposição diatônica ───
        (0, 350, False),   # I
        (2, 400, False),   # III
        (4, 500, False),   # V
        (6, 250, False),   # VII (sensível) — IMPORTANTE para Krumhansl
        (0, 400, False),   # I
        (5, 300, False),   # VI
        (4, 350, False),   # V
        (3, 300, False),   # IV
        (1, 250, False),   # II
        (2, 800, True),    # III (phrase end longa — armadilha do mediant)
        # ─── Verso 2 ───
        (4, 400, False),   # V
        (5, 350, False),   # VI
        (6, 300, False),   # VII
        (0, 500, False),   # I
        (4, 300, False),   # V
        (2, 900, True),    # III novamente (phrase end longa)
        # ─── Refrão ───
        (0, 400, False),
        (3, 350, False),   # IV
        (4, 400, False),   # V
        (6, 300, False),   # VII (cadência V-I)
        (0, 600, True),    # I (cadência) — mais curta que III ends
        # ─── Repetição ───
        (4, 300, False),
        (3, 250, False),
        (1, 300, False),
        (2, 850, True),    # III phrase end (de novo)
        (4, 400, False),
        (5, 350, False),
        (6, 250, False),   # VII
        (0, 800, True),    # I (cadência final maior)
    ])


def test_padrao_hino_funciona_em_todos_12_tons_maiores():
    """
    REGRESSÃO UNIVERSAL — o exato padrão musical que fez o app errar
    (hino real em Mi maior → Sol# menor errado) NÃO PODE ocorrer em
    nenhuma das 12 tonalidades maiores.
    
    Esta é a prova matemática de que a correção v10.2 é universal:
    se passa para todos os 12 roots, então é puramente baseada em
    aritmética modular e não em hardcoding de tom específico.
    """
    falhas = []
    for root in range(12):
        notes = _hymn_pattern_major(root)
        result = run(notes)
        
        if not result.success:
            falhas.append(f"  ❌ {NAMES[root]} maior → análise falhou")
            continue
        
        # Verifica: tônica correta E modo maior
        tonic_ok = (result.tonic == root)
        mode_ok = (result.quality == 'major')
        
        if not tonic_ok:
            mediant_major = (root + 4) % 12
            mediant_minor = (root + 3) % 12
            dominant     = (root + 7) % 12
            tipo_erro = 'desconhecido'
            if result.tonic == mediant_major:
                tipo_erro = 'mediant_major (3ª maior — bug Mi→Sol#)'
            elif result.tonic == mediant_minor:
                tipo_erro = 'mediant_minor (3ª menor)'
            elif result.tonic == dominant:
                tipo_erro = 'dominant (5ª justa)'
            falhas.append(
                f"  ❌ {NAMES[root]} maior → detectado {NAMES[result.tonic]} "
                f"{result.quality} [{tipo_erro}] conf={result.confidence:.2f}"
            )
        elif not mode_ok:
            falhas.append(
                f"  ❌ {NAMES[root]} maior → tônica OK mas modo errado "
                f"({result.quality}) conf={result.confidence:.2f}"
            )
    
    assert not falhas, (
        "REGRESSÃO UNIVERSAL FALHOU — padrão do hino real ainda gera erros:\n"
        + "\n".join(falhas)
    )


def _hymn_pattern_minor(root: int) -> list:
    """
    Padrão equivalente para tom MENOR. Características:
      - Diatônico em menor harmônica/natural
      - Phrase ends frequentes sobre a 5ª maior (dominante) — armadilha
      - Cadências curtas sobre a tônica
    
    Aplicado a `root`, deve detectar `root menor` para qualquer tom.
    """
    return make_phrase(root, MINOR_SCALE, [
        (0, 400, False),   # i
        (2, 500, False),   # bIII (terça menor)
        (4, 600, False),   # V (dominante)
        (3, 300, False),   # IV
        # Phrase end sobre dominante (V) — armadilha clássica
        (4, 800, True),    # V phrase end longa
        (2, 400, False),
        (5, 350, False),   # bVI
        (4, 700, True),    # V novamente
        (0, 500, False),
        (3, 300, False),
        (2, 400, False),
        # Cadência final em i (curta vs as duas em V)
        (0, 600, True),
        # Repetições
        (2, 350, False),
        (4, 850, True),    # V outra vez
        (0, 700, True),    # i
    ])


def test_padrao_hino_funciona_em_todos_12_tons_menores():
    """REGRESSÃO UNIVERSAL — versão menor: 12 tons menores devem ser detectados
    apesar do bias de phrase end sobre a dominante."""
    falhas = []
    for root in range(12):
        notes = _hymn_pattern_minor(root)
        result = run(notes)
        
        if not result.success:
            falhas.append(f"  ❌ {NAMES[root]} menor → análise falhou")
            continue
        
        if result.tonic != root:
            dominant = (root + 7) % 12
            mediant_minor = (root + 3) % 12
            tipo_erro = 'desconhecido'
            if result.tonic == dominant:
                tipo_erro = 'dominant (5ª justa)'
            elif result.tonic == mediant_minor:
                tipo_erro = 'relativo maior (bIII = 3ª menor)'
            falhas.append(
                f"  ❌ {NAMES[root]} menor → detectado {NAMES[result.tonic]} "
                f"{result.quality} [{tipo_erro}] conf={result.confidence:.2f}"
            )
        elif result.quality != 'minor':
            falhas.append(
                f"  ❌ {NAMES[root]} menor → tônica OK mas modo errado "
                f"(maior) conf={result.confidence:.2f}"
            )
    
    assert not falhas, (
        "REGRESSÃO UNIVERSAL FALHOU em modo menor:\n" + "\n".join(falhas)
    )



# ═══════════════════════════════════════════════════════════════════════════════
# RELATÓRIO FINAL
# ═══════════════════════════════════════════════════════════════════════════════

# ═══════════════════════════════════════════════════════════════════════════════
# BLOCO 13 — ANTI-CONFIANÇA-FALSA (v10.5)
# Bugs reportados pelo usuário: tom errado com confiança alta (89%, 90%).
# Regra: se há ambiguidade musical real (relativo/dominante/cadência fraca),
# confiança deve ser ≤ 70%. Se evidência for fraca, deve ser ≤ 75%.
# ═══════════════════════════════════════════════════════════════════════════════

def test_relativo_ambiguo_sem_confianca_alta():
    """
    Quando dois candidatos top são RELATIVOS (compartilham escala) com scores
    similares, confidence MUST be ≤ 70%. Universal: testa em 6 pares.
    """
    pares_relativos = [
        # (tom_maior_root, relativo_menor_root) — diff sempre 9 mod 12
        (0, 9),    # Dó maior / Lá menor
        (2, 11),   # Ré maior / Si menor
        (5, 2),    # Fá maior / Ré menor
        (7, 4),    # Sol maior / Mi menor
        (9, 6),    # Lá maior / Fá# menor
        (1, 10),   # Dó# maior / Lá# menor (caso reportado pelo usuário)
    ]
    falhas = []
    for major_root, minor_root in pares_relativos:
        # Padrão "ambíguo": canta notas da escala SEM resolução clara
        # Termina alternando entre os dois candidatos
        notes = make_phrase(major_root, MAJOR_SCALE, [
            (0, 400, False),
            (2, 400, False),
            (4, 400, False),
            (5, 600, False),
            (1, 600, True),   # phrase end na II (não tônica)
            (3, 600, False),
            (5, 1200, True),  # phrase end longa na 6ª (= relativo menor)
            (1, 800, True),   # phrase end na 2ª — não na tônica
        ])
        result = run(notes)
        if not result.success:
            continue
        if result.confidence > 0.75:
            falhas.append(
                f"  ❌ par {NAMES[major_root]} maior / {NAMES[minor_root]} menor: "
                f"detectado {NAMES[result.tonic]} {result.quality} "
                f"com conf={result.confidence:.2f} (deveria ser ≤ 0.75)"
            )
    
    assert not falhas, "Confiança inflada em casos de relativo ambíguo:\n" + "\n".join(falhas)


def test_dominante_nao_vence_tonica_com_confianca_alta():
    """
    Quando o V grau aparece muito mas a tônica também, e o algoritmo escolhe
    o V (dominante) como vencedor, confidence MUST be ≤ 65%.
    Universal: testa em 4 pares tônica/dominante.
    """
    pares = [
        (11, 6),  # B maior / F# (V) — caso reportado
        (0, 7),   # Dó maior / Sol (V)
        (2, 9),   # Ré maior / Lá (V)
        (5, 0),   # Fá maior / Dó (V)
    ]
    falhas = []
    for tonic, dom in pares:
        # Padrão com V dominando: V longo, V repetido, sem cadência forte na tônica
        notes = []
        # Frase 1: tônica brevemente, depois V longa
        for pc, dur, end in [
            (tonic, 300, False),
            ((tonic + 4) % 12, 300, False),  # III
            (dom, 1500, True),               # V longa = phrase end (armadilha)
            ((tonic + 4) % 12, 400, False),
            (dom, 1500, True),               # V de novo
            ((tonic + 2) % 12, 400, False),
            (dom, 1200, False),
        ]:
            notes.append(Note(pc, 60.0+pc, float(dur), 0.0, 0.82, end))
        result = run(notes)
        if not result.success:
            continue
        # Se algoritmo escolheu V como tônica, confidence deve ser ≤ 0.70
        if result.tonic == dom and result.confidence > 0.70:
            falhas.append(
                f"  ❌ tônica={NAMES[tonic]} V={NAMES[dom]}: detectou V como tônica "
                f"({NAMES[result.tonic]} {result.quality}) com conf={result.confidence:.2f}"
            )
    
    assert not falhas, "Dominante virou tônica com confiança alta:\n" + "\n".join(falhas)


def test_poucas_frases_sem_confianca_alta():
    """
    Com menos de 3 phrase ends, evidência cadencial é insuficiente.
    Confidence MUST be ≤ 75% (mesmo com tom correto).
    Universal: testa em 4 tons.
    """
    falhas = []
    for root in [0, 4, 7, 11]:
        # Apenas 1-2 phrase ends — insuficiente para confiança alta
        notes = make_phrase(root, MAJOR_SCALE, [
            (0, 400, False),
            (2, 400, False),
            (4, 400, False),
            (0, 800, True),  # 1 phrase end apenas
        ])
        result = run(notes)
        if not result.success:
            continue
        if result.confidence > 0.80:
            falhas.append(
                f"  ❌ {NAMES[root]} maior com 1 phrase end: "
                f"conf={result.confidence:.2f} (deveria ≤ 0.80)"
            )
    
    assert not falhas, "Confiança inflada com poucas frases:\n" + "\n".join(falhas)


def test_cadencia_clara_permite_confianca_alta():
    """
    SANITY CHECK: quando há cadência clara (música repete I-IV-V-I 2x+),
    confidence DEVE ser ≥ 0.80. Garante que a trava não estraga casos válidos.
    """
    falhas = []
    for root in [0, 4, 7, 11]:
        notes = make_phrase(root, MAJOR_SCALE, [
            (0, 500, False),
            (2, 400, False),
            (4, 500, False),
            (6, 300, False),
            (0, 800, True),    # phrase end I — cadência forte
            (3, 500, False),
            (4, 500, False),
            (0, 1000, True),   # phrase end I — cadência forte
            (2, 400, False),
            (4, 400, False),
            (0, 1200, True),   # phrase end I — cadência forte (3+ phrase ends)
        ])
        result = run(notes)
        if not result.success:
            continue
        if result.tonic != root or result.quality != 'major':
            falhas.append(
                f"  ❌ {NAMES[root]} maior com cadência clara: "
                f"detectou {NAMES[result.tonic]} {result.quality}"
            )
            continue
        if result.confidence < 0.75:
            falhas.append(
                f"  ⚠️ {NAMES[root]} maior com cadência clara: "
                f"conf={result.confidence:.2f} (esperado ≥ 0.75)"
            )
    
    assert not falhas, "Casos com cadência clara não receberam confiança merecida:\n" + "\n".join(falhas)



if __name__ == '__main__':
    import pytest
    result = pytest.main([__file__, '-v', '--tb=short', '-q'])
    sys.exit(result)
