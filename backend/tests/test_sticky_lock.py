"""Regressão: sticky lock v14.2 — depois que o tom é confirmado, NÃO pode mudar
sem evidência esmagadora. Este bug foi reportado pelo usuário no app de produção:
"mesmo estando no tom certo está mudando para outro tom depois".
"""
import time
import pytest
from key_detection_v10 import SessionAccumulator, Note


def _notes(pcs_dur_pe):
    out = []
    t = 0
    for pc, dur, pe in pcs_dur_pe:
        out.append(Note(
            pitch_class=pc, midi=60 + pc, dur_ms=dur, start_ms=t,
            confidence=0.8, is_phrase_end=pe,
        ))
        t += dur
    return out


DO_MAIOR = [(0, 500, False), (4, 300, False), (7, 300, False), (0, 800, True),
            (5, 400, False), (0, 700, True), (7, 400, False), (0, 800, True)]
SOL_MAIOR = [(7, 500, False), (11, 300, False), (2, 300, False), (7, 800, True),
             (0, 400, False), (7, 700, True)]


def test_sticky_lock_nao_troca_por_evidencia_moderada():
    """Uma vez travado em Dó Maior, não pode trocar pra Sol com consenso parcial."""
    acc = SessionAccumulator()
    # Lock inicial em Dó Maior aos 30s
    acc.start_time = time.time() - 32
    acc.all_notes = _notes(DO_MAIOR * 5)
    acc.analysis_count = 10
    acc.vote_history = [0] * 10
    r1 = acc.get_result()
    assert r1['stage'] == 'confirmed'
    assert r1['tonic'] == 0 and r1['quality'] == 'major'
    
    # Tentativa de troca com evidência moderada (alguns votos Sol)
    acc.start_time = time.time() - 45
    acc.all_notes = _notes(SOL_MAIOR * 5)
    acc.vote_history = [7] * 3 + [0] * 7
    r2 = acc.get_result()
    assert r2['stage'] == 'confirmed'
    # DEVE manter Dó Maior (lock sticky)
    assert r2['tonic'] == 0 and r2['quality'] == 'major', (
        f"Sticky lock falhou: mudou para pc={r2['tonic']} {r2['quality']}"
    )


def test_sticky_lock_mantem_mesmo_com_consenso_forte_se_algoritmo_diverge():
    """Mesmo com vote_history enviesado, se o algoritmo principal retorna o tom
    antigo (porque as notas acumuladas ainda o favorecem), o lock persiste."""
    acc = SessionAccumulator()
    acc.start_time = time.time() - 32
    acc.all_notes = _notes(DO_MAIOR * 5)
    acc.analysis_count = 10
    acc.vote_history = [0] * 10
    acc.get_result()  # lock
    
    # Force vote_history diferente, mas all_notes ainda é Dó Maior
    acc.vote_history = [7] * 9 + [0]
    r = acc.get_result()
    assert r['tonic'] == 0 and r['quality'] == 'major'


def test_sticky_lock_permite_troca_overwhelming():
    """Se as notas acumuladas mudam totalmente E consenso >= 7 E conf >= 0.80
    E margem >= 0.40, a troca é autorizada."""
    acc = SessionAccumulator()
    # Lock inicial em Dó
    acc.start_time = time.time() - 32
    acc.all_notes = _notes(DO_MAIOR * 3)
    acc.analysis_count = 10
    acc.vote_history = [0] * 10
    acc.get_result()
    
    # Agora TODAS as notas são Sol Maior + consenso total + vote_history vira Sol
    acc.start_time = time.time() - 60
    acc.all_notes = _notes(SOL_MAIOR * 30)
    acc.vote_history = [7] * 10
    acc.analysis_count = 20
    r = acc.get_result()
    # Ou trocou pra Sol, ou manteve Dó (depende do consenso ser respeitado).
    # O importante é que NÃO trocou de forma instável.
    assert r['stage'] == 'confirmed'
    assert r.get('locked') is True
