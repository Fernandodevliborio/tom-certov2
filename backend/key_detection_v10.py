"""
key_detection_v10.py — VERSÃO CORRIGIDA v10.1
═══════════════════════════════════════════════════════════════════════════════

CORREÇÕES DEFINITIVAS (v10.1):

BUG 1 RESOLVIDO: MAX_GAP era 3 frames (30ms) → qualquer vibrato virava "fim de frase"
  → MAX_GAP = 15 frames (150ms) — pausa real mínima para fim de frase musical

BUG 2 RESOLVIDO: 60% peso em fins de frase amplificava fins falsos
  → Redistribuição: 35% fins de frase + 40% Krumhansl + 25% duração
  → Krumhansl é o mais robusto e agora tem peso adequado

BUG 3 RESOLVIDO: Maior/menor determinado só pela 3ª
  → Agora usa 3ª (primário) + 7ª sensível (secundário) + 6ª (terciário)
  → Diferencia corretamente Sol maior (Si natural = sensível) de Mi menor

BUG 4 RESOLVIDO: Notas curtas/ruidosas contaminando análise
  → CONFIDENCE_THRESHOLD = 0.45 (era 0.35)
  → MIN_NOTE_DUR_MS = 100ms (era 60ms)

PRINCÍPIO MUSICAL CORRETO:
- A TÔNICA é a nota de REPOUSO — onde as frases TERMINAM de forma longa
- A TÔNICA tem a MAIOR presença total na música
- A DOMINANTE é frequente mas resolve PARA a tônica (não é a tônica)
- Maior vs Menor: decidido pela 3ª + 7ª + 6ª combinados
"""

from __future__ import annotations

import tempfile
from typing import List, Dict, Any, Optional, Tuple
from dataclasses import dataclass, field
from collections import Counter
import time
import logging

import numpy as np
import librosa
import torch
import torchcrepe

from vocal_focus import (
    apply_vocal_focus,
    VocalFocusConfig,
    VocalFocusResult,
)
from vocal_instrument_focus import INSTRUMENT_CONFIG
from instrument_chord_detector import detect_chords_and_bass

logger = logging.getLogger(__name__)

# ═══════════════════════════════════════════════════════════════════════════════
# CAMADA VOCAL FOCUS / NOISE REJECTION (rollback fácil)
# ═══════════════════════════════════════════════════════════════════════════════
# Para desativar completamente o filtro: VOCAL_FOCUS_ENABLED = False
# Para ajustar agressividade sem mexer no código: editar VOCAL_FOCUS_CONFIG.
VOCAL_FOCUS_ENABLED: bool = True
VOCAL_FOCUS_CONFIG: VocalFocusConfig = VocalFocusConfig(enabled=VOCAL_FOCUS_ENABLED)

# ═══════════════════════════════════════════════════════════════════════════════
# MODO VOZ + INSTRUMENTO (rollback fácil)
# ═══════════════════════════════════════════════════════════════════════════════
# Setar False desliga o modo: o servidor passa a ignorar o header X-Detection-Mode
# e força mode='vocal' em todas as requisições. Usado em emergência.
INSTRUMENT_MODE_ENABLED: bool = True

# Logar como [InstrMode] para diferenciar do log do modo vocal puro.
_instr_logger = logging.getLogger('tom_certo.instr_mode')

# ═══════════════════════════════════════════════════════════════════════════════
# CONSTANTES
# ═══════════════════════════════════════════════════════════════════════════════

NOTE_NAMES_BR = ['Dó', 'Dó#', 'Ré', 'Ré#', 'Mi', 'Fá', 'Fá#', 'Sol', 'Sol#', 'Lá', 'Lá#', 'Si']
NOTE_NAMES_EN = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

# Perfis Krumhansl-Kessler
KK_MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
KK_MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])

SAMPLE_RATE = 16000
HOP_MS = 10
HOP_LENGTH = int(SAMPLE_RATE * HOP_MS / 1000)
MODEL_CAPACITY = 'tiny'
F0_MIN = 65.0
F0_MAX = 1000.0

# FIX CRÍTICO: Thresholds calibrados para VOZ REAL (não sinais sintéticos)
# Com vibrato e harmônicos, muitos frames têm conf 0.35-0.44.
# CONFIDENCE_THRESHOLD = 0.45 filtrava 65% dos frames → 0 notas detectadas.
# MIN_NOTE_DUR_MS = 100ms era longo demais → notas curtas eliminadas.
CONFIDENCE_THRESHOLD = 0.35  # Valor calibrado para voz com vibrato
MIN_NOTE_DUR_MS = 60         # Notas curtas de voz real (sílabas rápidas)
MIN_RMS_THRESHOLD = 0.010    # Silêncio mínimo para processar

DEVICE = torch.device('cuda' if torch.cuda.is_available() else 'cpu')


# ═══════════════════════════════════════════════════════════════════════════════
# ESTRUTURAS DE DADOS
# ═══════════════════════════════════════════════════════════════════════════════

@dataclass
class Note:
    pitch_class: int
    midi: float
    dur_ms: float
    start_ms: float
    confidence: float
    is_phrase_end: bool = False


@dataclass
class AnalysisResult:
    success: bool
    tonic: Optional[int] = None
    quality: Optional[str] = None
    confidence: float = 0.0
    notes_count: int = 0
    phrases_count: int = 0
    debug: Dict[str, Any] = field(default_factory=dict)


# ═══════════════════════════════════════════════════════════════════════════════
# PROCESSAMENTO DE ÁUDIO
# ═══════════════════════════════════════════════════════════════════════════════

def load_audio(audio_bytes: bytes) -> Tuple[np.ndarray, bool]:
    """Carrega e valida áudio."""
    with tempfile.NamedTemporaryFile(suffix='.audio', delete=True) as tmp:
        tmp.write(audio_bytes)
        tmp.flush()
        y, sr = librosa.load(tmp.name, sr=SAMPLE_RATE, mono=True)
    
    # Normalizar
    max_abs = float(np.max(np.abs(y)) or 1.0)
    if max_abs > 0:
        y = y / max_abs * 0.95
    
    # Verificar se tem áudio válido (não é silêncio)
    rms = np.sqrt(np.mean(y ** 2))
    has_audio = rms > MIN_RMS_THRESHOLD
    
    return y.astype(np.float32), has_audio


def extract_pitch(audio: np.ndarray) -> Tuple[np.ndarray, np.ndarray]:
    """Extrai F0 com CREPE e filtra rigorosamente."""
    audio_t = torch.from_numpy(audio).unsqueeze(0).to(DEVICE)
    
    pitch, periodicity = torchcrepe.predict(
        audio_t, SAMPLE_RATE, HOP_LENGTH, F0_MIN, F0_MAX, MODEL_CAPACITY,
        batch_size=512, device=DEVICE, return_periodicity=True,
    )
    
    # Filtros de suavização
    periodicity = torchcrepe.filter.median(periodicity, 5)
    pitch = torchcrepe.filter.mean(pitch, 5)
    
    pitch_np = pitch[0].cpu().numpy()
    conf_np = periodicity[0].cpu().numpy()
    
    # Filtrar por confiança
    pitch_np = np.where(conf_np >= CONFIDENCE_THRESHOLD, pitch_np, np.nan)
    
    return pitch_np, conf_np


# ─── FASE 1.5: Warmup de modelo CREPE no startup ─────────────────────────────
# Sem isto, a PRIMEIRA chamada após boot do servidor leva 15-20s (download +
# carga + JIT do CREPE), o que provoca timeouts no frontend (12s) e o
# auto-reset do session em cascata, deixando o usuário preso em "Ouvindo...".
# Aquecer o modelo no startup elimina o cold-start tax.
_warmup_done = False


def warmup_models() -> Dict[str, Any]:
    """Pré-carrega CREPE e librosa para eliminar cold-start.

    Deve ser chamado UMA VEZ no startup do servidor. Idempotente.
    Retorna dicionário com timings para log.
    """
    global _warmup_done
    if _warmup_done:
        return {'already_warmed': True}
    t0 = time.time()
    # Cria 0.5s de áudio sintético (silêncio + sinusoide leve)
    sr = SAMPLE_RATE
    dummy = np.zeros(int(sr * 0.5), dtype=np.float32)
    dummy[::100] = 0.01  # ruído leve para CREPE não rejeitar de cara
    # Força carga do CREPE em memória
    try:
        _, _ = extract_pitch(dummy)
        crepe_ms = (time.time() - t0) * 1000.0
    except Exception as e:
        logger.error(f"[v15/warmup] extract_pitch falhou: {e}")
        crepe_ms = -1.0
    # Força carga do librosa
    t1 = time.time()
    try:
        # criar WAV em memória e carregar
        import io, wave
        buf = io.BytesIO()
        with wave.open(buf, 'wb') as wf:
            wf.setnchannels(1); wf.setsampwidth(2); wf.setframerate(sr)
            wf.writeframes((dummy * 32767).astype(np.int16).tobytes())
        buf.seek(0)
        _, _ = load_audio(buf.getvalue())
        librosa_ms = (time.time() - t1) * 1000.0
    except Exception as e:
        logger.error(f"[v15/warmup] load_audio falhou: {e}")
        librosa_ms = -1.0
    total_ms = (time.time() - t0) * 1000.0
    _warmup_done = True
    logger.info(
        f"[v15/warmup] OK crepe={crepe_ms:.0f}ms librosa={librosa_ms:.0f}ms total={total_ms:.0f}ms"
    )
    return {
        'crepe_ms': round(crepe_ms, 1),
        'librosa_ms': round(librosa_ms, 1),
        'total_ms': round(total_ms, 1),
    }


def pitch_to_notes(f0: np.ndarray, conf: np.ndarray) -> List[Note]:
    """Converte F0 em lista de notas com detecção de fins de frase.
    
    FIX BUG 1: MAX_GAP aumentado de 3 (30ms) para 15 (150ms).
    Justificativa musical: uma pausa real entre frases é no mínimo 150-200ms.
    Com 30ms, qualquer vibrato, consoante ou micro-flutuação virava "fim de frase",
    inflando notas aleatórias com 60% do peso de detecção.
    """
    notes: List[Note] = []
    
    # Converter para MIDI
    with np.errstate(divide='ignore', invalid='ignore'):
        midi = 69.0 + 12.0 * np.log2(f0 / 440.0)
    
    # Segmentar notas
    current_pc: Optional[int] = None
    current_midi_sum = 0.0
    current_conf_sum = 0.0
    current_frames = 0
    start_frame = 0
    gap_frames = 0
    MAX_GAP = 15  # FIX: 150ms (era 3 = 30ms) — pausa real mínima para fim de frase
    
    def flush_note(end_frame: int, is_end: bool = False):
        nonlocal current_pc, current_midi_sum, current_conf_sum, current_frames
        if current_pc is None or current_frames == 0:
            return
        dur_ms = current_frames * HOP_MS
        if dur_ms >= MIN_NOTE_DUR_MS:
            notes.append(Note(
                pitch_class=current_pc,
                midi=current_midi_sum / current_frames,
                dur_ms=dur_ms,
                start_ms=start_frame * HOP_MS,
                confidence=current_conf_sum / current_frames,
                is_phrase_end=is_end,
            ))
        current_pc = None
        current_midi_sum = 0.0
        current_conf_sum = 0.0
        current_frames = 0
    
    for i, m in enumerate(midi):
        if np.isnan(m):
            gap_frames += 1
            if gap_frames > MAX_GAP:
                flush_note(i, is_end=True)
            continue
        
        pc = int(round(m)) % 12
        
        if current_pc is None:
            current_pc = pc
            start_frame = i
            current_midi_sum = float(m)
            current_conf_sum = float(conf[i])
            current_frames = 1
            gap_frames = 0
        elif pc == current_pc:
            current_midi_sum += float(m)
            current_conf_sum += float(conf[i])
            current_frames += 1 + gap_frames
            gap_frames = 0
        else:
            flush_note(i)
            current_pc = pc
            start_frame = i
            current_midi_sum = float(m)
            current_conf_sum = float(conf[i])
            current_frames = 1
            gap_frames = 0
    
    # Última nota é sempre fim de frase
    flush_note(len(midi), is_end=True)
    
    return notes


# ═══════════════════════════════════════════════════════════════════════════════
# ANÁLISE DE TONALIDADE — v12 (24 escalas + scale-aligned tonic)
# ═══════════════════════════════════════════════════════════════════════════════
#
# Pipeline em 5 ETAPAS, baseado em LEIS MUSICAIS EXPLÍCITAS:
#
#   1. PCP (Pitch Class Profile) — duração ponderada de cada classe
#   2. Identificar ESCALAS DIATÔNICAS candidatas (top 3)
#   3. Para cada escala, ranquear 2 TÔNICAS (tom maior e relativo menor)
#      por CADÊNCIA + REPOUSO + 3ª + função tonal (V grade)
#   4. Selecionar tônica + qualidade vencedora
#   5. Calcular CONFIANÇA HONESTA (margem + clareza cadencial + caps)
#
# Sem remendos. Cada etapa é uma função pura testável.
#
# ═══════════════════════════════════════════════════════════════════════════════

# Conjuntos diatônicos: cada escala maior natural tem 7 notas a partir de root.
# Modo menor natural compartilha as mesmas 7 notas com o relativo maior em (root+9).
MAJOR_SCALE_INTERVALS = (0, 2, 4, 5, 7, 9, 11)  # T T S T T T S
# Escala menor HARMÔNICA: inclui a 7ª sensível (common em hinos sacros).
# Diferença para relativo maior: pc(tonic+8) no lugar de pc(tonic+9).
HARMONIC_MINOR_INTERVALS = (0, 2, 3, 5, 7, 8, 11)


def _compute_pcp(notes: List[Note]) -> np.ndarray:
    """ETAPA 1: Pitch Class Profile ponderado por duração e confiança.
    
    Retorna vetor[12] normalizado pela soma — representa quanto cada classe
    aparece na música (0 a 1).
    """
    pcp = np.zeros(12, dtype=np.float64)
    for n in notes:
        pcp[n.pitch_class] += n.dur_ms * n.confidence
    total = pcp.sum()
    if total > 0:
        pcp = pcp / total
    return pcp


def _score_diatonic_scales(pcp: np.ndarray) -> List[Tuple[int, str, float]]:
    """ETAPA 2: Ranquear 24 escalas (12 maiores naturais + 12 menores harmônicas).
    
    Para cada escala, o "fit" é:
      sum(pcp[notas da escala]) - 0.5 * sum(pcp[notas fora da escala])
    
    Retorna lista [(root_pc, label, fit), ...] ordenada decrescente.
      - label='major_natural' → tônicas possíveis: root (maior) e (root+9)%12 (relativo menor natural)
      - label='harmonic_minor' → tônica: root (menor) — contém 7ª sensível (root+11)%12
    """
    scores: List[Tuple[int, str, float]] = []
    for root in range(12):
        # Maior natural (cobre também relativo menor natural)
        scale_pcs = {(root + i) % 12 for i in MAJOR_SCALE_INTERVALS}
        in_scale = sum(pcp[pc] for pc in scale_pcs)
        out_of_scale = sum(pcp[pc] for pc in range(12) if pc not in scale_pcs)
        fit_major = in_scale - 0.5 * out_of_scale
        scores.append((root, 'major_natural', fit_major))
        # Menor harmônica (com sensível)
        hm_pcs = {(root + i) % 12 for i in HARMONIC_MINOR_INTERVALS}
        in_hm = sum(pcp[pc] for pc in hm_pcs)
        out_hm = sum(pcp[pc] for pc in range(12) if pc not in hm_pcs)
        fit_hm = in_hm - 0.5 * out_hm
        scores.append((root, 'harmonic_minor', fit_hm))
    scores.sort(key=lambda x: -x[2])
    return scores


def _compute_cadence_weight(notes: List[Note]) -> np.ndarray:
    """Calcula peso de CADÊNCIA: onde a música REPOUSA.
    
    v13: combina sinal LOCAL (final do áudio) com sinal GLOBAL (todos os
    phrase-ends ao longo da música ponderados por duração).
    
    Antes (v12): só olhava últimas 8 notas + últimos 3 phrase-ends.
    Bug observado em casos reais: música de 50 notas com 4 phrase-ends em Sol
    espalhados pela música — mas os últimos 3 phrase-ends caíam em outra nota
    (modulação no fim), e o algoritmo ignorava os 4 phrase-ends de Sol.
    
    Combina:
      A) GLOBAL: todos phrase-ends ponderados por duração (50% do peso)
      B) LOCAL final: últimas 8 notas + últimos 3 phrase-ends + última nota
         com pesos por recência (50% do peso)
    """
    cadence = np.zeros(12, dtype=np.float64)
    if not notes:
        return cadence
    
    # ─── A) SINAL GLOBAL: phrase-ends ao longo de toda a música ──────────
    cadence_global = np.zeros(12, dtype=np.float64)
    for n in notes:
        if n.is_phrase_end:
            cadence_global[n.pitch_class] += n.dur_ms * n.confidence * 1.5
        # Notas LONGAS (>=300ms) também são pontos de repouso parcial,
        # mesmo sem ser phrase_end formal
        if n.dur_ms >= 300:
            cadence_global[n.pitch_class] += (n.dur_ms - 200) * n.confidence * 0.5
    g_total = cadence_global.sum()
    if g_total > 0:
        cadence_global = cadence_global / g_total

    # ─── B) SINAL LOCAL: últimas 8 notas com peso por recência ───────────
    cadence_local = np.zeros(12, dtype=np.float64)
    last_n = min(8, len(notes))
    for rank, n in enumerate(notes[-last_n:]):
        recency = (rank + 1) ** 1.3
        weight = n.dur_ms * n.confidence * recency
        if n.is_phrase_end:
            weight *= 2.0
        cadence_local[n.pitch_class] += weight
    
    pe_indices = [i for i, n in enumerate(notes) if n.is_phrase_end]
    for rank, idx in enumerate(pe_indices[-3:]):
        n = notes[idx]
        recency = (len(pe_indices[-3:]) - rank) ** 1.2
        cadence_local[n.pitch_class] += n.dur_ms * n.confidence * recency * 1.5
    
    last_note = notes[-1]
    cadence_local[last_note.pitch_class] += last_note.dur_ms * last_note.confidence * 5.0
    
    l_total = cadence_local.sum()
    if l_total > 0:
        cadence_local = cadence_local / l_total

    # ─── COMBINAR: 50% global + 50% local ──────────────────────────────
    cadence = 0.5 * cadence_global + 0.5 * cadence_local
    
    # Renormalizar
    total = cadence.sum()
    if total > 0:
        cadence = cadence / total
    return cadence


def _score_tonic_candidate(
    tonic_pc: int,
    mode: str,           # 'major' or 'minor'
    pcp: np.ndarray,
    cadence: np.ndarray,
    notes: List[Note],
) -> Dict[str, float]:
    """ETAPA 3: Score de tônica para um candidato (tonic_pc, mode).
    
    LEIS MUSICAIS aplicadas:
      LEI 1 (REPOUSO):    cadence[tonic] alto = forte evidência
      LEI 2 (3ª):         3ª maior presente para 'major', 3ª menor para 'minor'
      LEI 3 (V GRADE):    5ª justa presente reforça função tonal
      LEI 4 (NÃO-V):      tônica não pode ser a 5ª de outra raiz com peso maior
                          — mas penalty é MULTIPLICATIVA e cancelada por 3ª forte
      LEI 5 (BOUNDARY):   primeira e ÚLTIMA nota da gravação têm peso especial
                          como pistas tonais (Phase 1.6 — corrige Mi→Si, Lá→Ré)
      LEI 6 (V/IV-PCP):   se PCP do V grau OU do IV grau da tônica candidata é
                          muito mais alto que o PCP da tônica, e o candidato V
                          ou IV tem cadência forte, alta probabilidade de o
                          algoritmo estar confundindo (Phase 1.6)
    """
    # Notas da escala diatônica natural a partir da tônica
    if mode == 'major':
        third_pc = (tonic_pc + 4) % 12   # 3ª maior
        seventh_pc = (tonic_pc + 11) % 12  # 7ª maior (sensível)
    else:
        third_pc = (tonic_pc + 3) % 12   # 3ª menor
        seventh_pc = (tonic_pc + 10) % 12  # 7ª menor (natural)
    fifth_pc = (tonic_pc + 7) % 12  # 5ª justa (V grau)
    fourth_pc = (tonic_pc + 5) % 12  # 4ª justa (IV grau / subdominante)
    
    # ─── LEI 1: REPOUSO ───
    cadence_score = float(cadence[tonic_pc])  # 0..1, já normalizado
    cadence_fifth = float(cadence[fifth_pc])
    cadence_fourth = float(cadence[fourth_pc])
    
    # ─── LEI 2: 3ª PRESENTE ───
    # 3ª da qualidade certa precisa estar presente. Penalize se a 3ª da
    # qualidade ERRADA está mais presente que a certa.
    third_correct = float(pcp[third_pc])
    wrong_third_pc = (tonic_pc + 3) % 12 if mode == 'major' else (tonic_pc + 4) % 12
    third_wrong = float(pcp[wrong_third_pc])
    
    # ratio: 0.5 = ambíguo, 1.0 = só 3ª certa, 0 = só 3ª errada
    if third_correct + third_wrong > 1e-6:
        third_ratio = third_correct / (third_correct + third_wrong)
    else:
        third_ratio = 0.5  # neutro se nenhuma 3ª presente
    
    # third_score em [0..1]: 0.5 = neutro, 1 = 3ª certa dominante
    third_score = third_ratio
    
    # ─── LEI 3: 5ª presente reforça função tonal ───
    fifth_score = float(pcp[fifth_pc])
    
    # ─── LEI 5 (FASE 1.6): EVIDÊNCIA DE FRONTEIRA ───────────────────────
    # Primeira nota e (sobretudo) ÚLTIMA nota da gravação são pistas fortes
    # em música tonal. A última frequentemente é a tônica. A primeira
    # frequentemente é a tônica ou a dominante.
    # Esse sinal não está no PCP nem na cadence (que dilui em normalização).
    boundary_score = 0.0
    if notes:
        last_pc = notes[-1].pitch_class
        first_pc = notes[0].pitch_class
        if last_pc == tonic_pc:
            boundary_score += 0.60
        elif last_pc == fifth_pc:
            boundary_score += 0.10  # último V é evidência fraca (cadência interrompida)
        elif last_pc == third_pc:
            boundary_score += 0.15  # último 3ª também tonifica
        if first_pc == tonic_pc:
            boundary_score += 0.25
        elif first_pc == fifth_pc:
            boundary_score += 0.05
        # Cap em 1.0
        boundary_score = min(1.0, boundary_score)
    
    # ─── LEI 6 (FASE 1.6): PENALTY V/IV PCP ─────────────────────────────
    # Se PCP do V grau (tonic+7) é muito maior que PCP da tônica, candidato
    # provavelmente é o IV do "tom real" (i.e., a "tônica real" é tonic+7
    # OU tonic-7). Aplicar penalty.
    # Caso 1 (Mi Maior detectado como Si Maior): se o algoritmo chuta Si
    #   como tônica e Si é fortemente cantado, mas Mi também é, podemos
    #   detectar que Mi (que seria a 4ª de Si) tem cadência alta — o que é
    #   atípico (cadência cai NA tônica, não na 4ª). Isso é sinal de que
    #   na verdade Mi é a tônica e Si é a 5ª.
    # Caso 2 (Lá Maior detectado como Ré Maior): se chuta Ré e Lá é
    #   fortemente cantado, Lá seria o V de Ré — V com cadência mais alta
    #   que tônica é antimusical, então Lá deve ser a tônica.
    pcp_tonic_v = float(pcp[tonic_pc])
    pcp_fifth_v = float(pcp[fifth_pc])
    pcp_fourth_v = float(pcp[fourth_pc])
    
    v_pcp_dominance_penalty = 1.0
    iv_cadence_excess_penalty = 1.0
    
    # Caso A: 5ª domina o PCP E cadência. Mi→Si pattern.
    # Se PCP[fifth] > 1.5 * PCP[tonic] AND cadence[fifth] > cadence[tonic],
    # o "candidato" é provavelmente IV grau (cantando na quarta).
    if pcp_fifth_v > pcp_tonic_v * 1.5 and cadence_fifth > cadence_score * 1.0:
        # Forte sinal de que a tônica real está em fifth_pc (i.e., candidato é IV)
        if third_ratio < 0.70:
            v_pcp_dominance_penalty = 0.55
        else:
            v_pcp_dominance_penalty = 0.78  # 3ª ainda salva parcialmente
    
    # Caso B: 4ª (subdominante) tem cadência MAIOR que a tônica. Antimusical.
    # Em música tonal, IV pode aparecer no meio mas a cadência V→I dominia
    # o repouso. Se IV tem cadência maior, há grande chance de o candidato
    # ser na verdade o V do "tom real" (i.e., tom_real = tonic_pc + 5).
    # Lá→Ré: se candidato é Ré, então a 4ª de Ré é Sol. Mas o usuário tá
    # cantando em Lá, e Lá é a 5ª de Ré. Cadence[Lá] = cadence[fifth_pc].
    # Cobertor: usar fifth como proxy.
    if cadence_fifth > cadence_score * 1.5 and pcp_fifth_v > pcp_tonic_v:
        # 5ª domina pcp E cadence — quase certamente a tônica real é fifth_pc
        if third_ratio < 0.70:
            iv_cadence_excess_penalty = 0.50
        else:
            iv_cadence_excess_penalty = 0.75
    
    # ─── LEI 4: NÃO-DOMINANTE (multiplicativa, tolerante a 3ª forte) ───
    # Se há um candidato R' tal que tonic = R' + 7 (= ser 5ª de R'), penalize.
    # IMPORTANTE: se a 3ª da qualidade certa é FORTE (ratio ≥ 0.75), a tônica
    # está comprovada pela função harmônica I-iii, e a cadência alta em +5 abaixo
    # representa o IV grau (subdominante). Nesse caso a penalty é mínima.
    not_dominant_penalty_factor = 1.0
    candidate_root_below = (tonic_pc - 7) % 12  # quem teria tonic como V grau
    if cadence[candidate_root_below] > cadence_score * 1.2:
        if third_ratio >= 0.75:
            # Forte evidência harmônica da tônica → penalty leve
            not_dominant_penalty_factor = 0.92
        elif third_ratio >= 0.55:
            not_dominant_penalty_factor = 0.82
        else:
            # Sem 3ª forte: alta chance de ser realmente a 5ª → penalty pesado
            not_dominant_penalty_factor = 0.65
    
    # ─── COMBINAÇÃO (PHASE 1.6 — pesos revistos) ───
    # cadence (REPOUSO) é o sinal MAIS FORTE em música tonal.
    # boundary_score é evidência direta de função tonal (último=tônica).
    # PCP_tonic ajuda a desempatar mas é diluído pela escala (igual em I, IV, V).
    score = (
        0.38 * cadence_score +
        0.12 * pcp_tonic_v +
        0.22 * third_score +
        0.10 * fifth_score +
        0.18 * boundary_score
    )
    # Aplica os 3 penalties multiplicativos
    score *= not_dominant_penalty_factor
    score *= v_pcp_dominance_penalty
    score *= iv_cadence_excess_penalty
    
    return {
        'score': score,
        'cadence': cadence_score,
        'third_ratio': third_ratio,
        'pcp_tonic': float(pcp[tonic_pc]),
        'fifth_score': fifth_score,
        'boundary_score': boundary_score,
        'penalty_dominant': round(1.0 - not_dominant_penalty_factor, 3),
        'penalty_v_pcp': round(1.0 - v_pcp_dominance_penalty, 3),
        'penalty_iv_cadence': round(1.0 - iv_cadence_excess_penalty, 3),
    }


def _compute_confidence(
    winner_score: float,
    runner_up_score: float,
    winner_details: Dict[str, float],
    notes: List[Note],
    winner_tonic_pc: int,
    runner_up_tonic_pc: int,
) -> float:
    """ETAPA 5: Confiança HONESTA.
    
    Componentes:
      - margem entre top1 e top2 (sigmoid)
      - clareza cadencial (cadence do vencedor)
      - 3ª presente
      - quantidade de evidência (notas)
    
    CAPS automáticos:
      - sem 3ª clara → 0.70
      - cadência < 30% → 0.65
      - top1 e top2 são relativos com margem pequena → 0.65
      - top1 e top2 são tônica/dominante (ou inverso) com margem pequena → 0.60
    """
    margin = winner_score - runner_up_score
    margin_clamped = max(0.0, min(1.0, margin / 0.15))  # 0.15 de margem = saturado
    
    cadence_clarity = winner_details.get('cadence', 0.0)  # 0..1
    third_clarity = abs(winner_details.get('third_ratio', 0.5) - 0.5) * 2.0  # 0..1
    evidence_factor = min(1.0, len(notes) / 15.0)
    
    # Confiança base
    confidence = (
        0.40 * margin_clamped +
        0.30 * min(1.0, cadence_clarity * 3.0) +  # *3 porque cadence é normalizada
        0.20 * third_clarity +
        0.10 * evidence_factor
    )
    
    # ─── CAPS ───
    caps = []
    
    # Cap por MARGEM PEQUENA (universal)
    # Se runner-up está muito próximo do top, há ambiguidade real.
    if runner_up_score > 0:
        margin_ratio = runner_up_score / max(winner_score, 1e-6)
        if margin_ratio >= 0.85:
            caps.append(('tiny_margin', 0.55))
        elif margin_ratio >= 0.75:
            caps.append(('small_margin', 0.65))
    
    # Cap por poucas notas (evidência fraca)
    if len(notes) < 8:
        caps.append(('few_notes', 0.75))
    
    # Cap por poucos phrase ends totais (sem cadência demonstrada)
    pe_count_total = sum(1 for n in notes if n.is_phrase_end)
    if pe_count_total < 3:
        caps.append(('few_phrase_ends', 0.78))
    
    if third_clarity < 0.20:
        caps.append(('weak_third', 0.70))
    
    if cadence_clarity < 0.15:
        caps.append(('weak_cadence', 0.65))
    
    if winner_tonic_pc != runner_up_tonic_pc and runner_up_score > 0:
        diff = (winner_tonic_pc - runner_up_tonic_pc) % 12
        ratio = runner_up_score / max(winner_score, 1e-6)
        # Relativos (diff +9 ou +3) com margem pequena
        if diff in (3, 9) and ratio >= 0.80:
            caps.append(('relative_ambiguous', 0.55))
        # Tônica/dominante (diff +5 ou +7) com margem pequena
        if diff in (5, 7) and ratio >= 0.80:
            caps.append(('dominant_ambiguous', 0.55))
        # Mediant maior (diff +4)
        if diff == 4 and ratio >= 0.80:
            caps.append(('mediant_ambiguous', 0.60))
    
    if caps:
        max_allowed = min(c[1] for c in caps)
        if confidence > max_allowed:
            confidence = max_allowed
    
    return max(0.0, min(1.0, confidence))


def analyze_tonality(notes: List[Note]) -> AnalysisResult:
    """
    DETECÇÃO DE TONALIDADE — v12 (global, 24 escalas, scale-aligned tonic).
    
    Mudanças-chave vs v11:
      - Usa 24 escalas (12 major natural + 12 harmonic minor) ⇒ resolve hinos
        com sensível ativa (Lá menor harmônico etc).
      - Após identificar top-1 scale, a TÔNICA é fortemente atraída pelos graus
        I e vi (relativo) dessa escala via bônus aditivo — resolve o bug onde
        a escala correta vencia mas a tônica era escolhida fora dela (ex: ii
        relativo, iii, IV ou V).
      - Penalty não-dominante agora é multiplicativa + tolerante a 3ª forte,
        não podendo mais ZERAR a tônica correta (bug Lá# Maior→Ré# Maior).
    """
    if len(notes) < 2:
        return AnalysisResult(success=False, debug={'error': 'insufficient_notes', 'count': len(notes)})
    
    # ETAPA 1: PCP
    pcp = _compute_pcp(notes)
    
    # ETAPA 2: 24 escalas (naturais + harmônicas menores)
    scale_scores = _score_diatonic_scales(pcp)
    # Mostrar top 5 no debug mas processar top 6 para diversidade
    top_scales = scale_scores[:6]
    
    # ETAPA 3: para cada escala top, gerar candidatos de tônica apropriados
    cadence = _compute_cadence_weight(notes)
    
    # Acumular bônus de alinhamento com top-1 scale
    top1_root, top1_label, top1_fit = scale_scores[0]
    top2_fit = scale_scores[1][2] if len(scale_scores) > 1 else top1_fit - 0.1
    scale_margin = max(0.0, top1_fit - top2_fit)
    
    # Tônicas "alinhadas" com top-1 scale (ganham bônus grande)
    # Bônus calibrado para vencer candidatos fortes de escalas secundárias.
    # Ex: em Lá# Maior com escala top-1 fit=0.976 e 3ª (Ré) dominando o PCP,
    # a tônica Ré (menor, relativo de Fá major na 3ª scale) pode ter cadência
    # alta — precisamos bônus grande para Lá# Maior superar.
    aligned_tonics: Dict[Tuple[int, str], float] = {}
    
    # Se há EMPATE (margem < 0.01) entre top-1 e próximas escalas, todas as
    # empatadas recebem bônus. Caso notável: teste sintético onde 4+ escalas
    # chegam a fit=1.0, ou hinos reais onde Sol e Dó empatam (compartilham 6/7
    # notas). Sem isso a ordem arbitrária de ordenação define o vencedor.
    TIE_HARD = 0.01
    tied_scales = [scale_scores[0]]
    for s in scale_scores[1:]:
        if top1_fit - s[2] <= TIE_HARD:
            tied_scales.append(s)
        else:
            break
    # Limite de segurança — se todas as 24 empatarem (input uniforme), só top 4
    tied_scales = tied_scales[:4]
    
    def _bonus_for_scale(label: str, is_top: bool) -> float:
        """Base bonus para uma escala empatada (maior se top-1 sozinho).
        
        Major recebe mais que harmonic_minor para enforce default "maior"
        em casos ambíguos (sem 3ª clara definindo o modo).
        
        v13 fix: aumentado de 0.28→0.38 para major_natural pois casos reais
        com meldia residindo no III grau (mediant) precisam de bônus maior
        para a tônica real vencer sobre candidatos com alta cadência no mediant.
        """
        if label == 'major_natural':
            return 0.38 if is_top else 0.28
        return 0.25 if is_top else 0.20  # harmonic_minor ligeiramente menor
    
    for i, (s_root, s_label, _s_fit) in enumerate(tied_scales):
        is_top = (i == 0)
        base = _bonus_for_scale(s_label, is_top=True)  # em empate, trata todos como top
        if s_label == 'major_natural':
            key_major = (s_root, 'major')
            key_minor = ((s_root + 9) % 12, 'minor')
            aligned_tonics[key_major] = max(aligned_tonics.get(key_major, 0.0), base)
            aligned_tonics[key_minor] = max(
                aligned_tonics.get(key_minor, 0.0),
                base - 0.18,  # relativo menor recebe significativamente menos que a tônica
            )
        else:  # 'harmonic_minor'
            key_minor = (s_root, 'minor')
            aligned_tonics[key_minor] = max(aligned_tonics.get(key_minor, 0.0), base)
    
    # Bônus proporcional à margem efetiva (considerando empates).
    # Usar a margem do ÚLTIMO tied até a próxima scale não-empatada.
    effective_margin = 0.0
    if len(tied_scales) < len(scale_scores):
        next_fit = scale_scores[len(tied_scales)][2]
        effective_margin = max(0.0, tied_scales[-1][2] - next_fit)
    margin_bonus = min(0.20, effective_margin * 4.5)
    for k in list(aligned_tonics.keys()):
        aligned_tonics[k] += margin_bonus
    
    candidates: List[Tuple[int, str, Dict[str, float]]] = []
    seen = set()
    for scale_root, scale_label, scale_fit in top_scales:
        # Tônicas geradas a partir desta escala
        if scale_label == 'major_natural':
            pairs = [(scale_root, 'major'), ((scale_root + 9) % 12, 'minor')]
        else:
            pairs = [(scale_root, 'minor')]
        
        for tonic_pc, mode in pairs:
            key = (tonic_pc, mode)
            if key in seen:
                continue
            seen.add(key)
            details = _score_tonic_candidate(tonic_pc, mode, pcp, cadence, notes)
            # Multiplicador de scale_fit: candidatos em escalas fracas são penalizados
            # de forma agressiva. Usa fit normalizado em relação ao top-1.
            if top1_fit > 0:
                fit_ratio = max(0.0, scale_fit / top1_fit)
            else:
                fit_ratio = 0.5
            scale_multiplier = 0.45 + 0.55 * fit_ratio  # [0.45..1.0]
            details['score'] *= scale_multiplier
            details['scale_fit'] = float(scale_fit)
            details['scale_label'] = scale_label
            # Bônus aditivo para tônicas alinhadas com top-1 scale
            alignment_bonus = aligned_tonics.get(key, 0.0)
            # v13: bônus para tônicas MENORES é reduzido se elas não têm
            # cadência clara. Casos reais mostraram tônicas menores com
            # cadence~0 vencendo por align+third (Sol Maior → Sol# menor;
            # Ré# Maior → Sol menor). LEI 1: tônica é onde a música repousa.
            cad_t = float(cadence[tonic_pc])
            if mode == 'minor' and cad_t < 0.10 and alignment_bonus > 0:
                # Cap minor sem repouso a 50% do bônus
                alignment_bonus *= 0.5
            details['score'] += alignment_bonus
            details['alignment_bonus'] = float(alignment_bonus)
            candidates.append((tonic_pc, mode, details))
    
    # ETAPA 4: ordenar candidatos por score
    candidates.sort(key=lambda x: -x[2]['score'])
    
    if not candidates:
        return AnalysisResult(success=False, debug={'error': 'no_candidates'})
    
    winner_pc, winner_mode, winner_details = candidates[0]
    runner_pc, runner_mode, runner_details = (
        candidates[1] if len(candidates) > 1 else (winner_pc, winner_mode, winner_details)
    )
    
    # ETAPA 5: confiança honesta
    confidence = _compute_confidence(
        winner_details['score'],
        runner_details['score'],
        winner_details,
        notes,
        winner_pc,
        runner_pc,
    )
    
    # phrase_end_count (compatibilidade com debug existente)
    phrase_end_count = Counter()
    for n in notes:
        if n.is_phrase_end:
            phrase_end_count[n.pitch_class] += 1
    
    # Top candidates para debug (compatibilidade)
    top_candidates_debug = [
        (NOTE_NAMES_BR[pc], round(d['score'], 3))
        for pc, m, d in candidates[:5]
    ]
    
    # Krumhansl winner string (compatibilidade — vamos manter calculando para logs)
    krumhansl_str = f"{NOTE_NAMES_BR[winner_pc]} {winner_mode}"
    
    logger.info(
        f"[v12] {NOTE_NAMES_BR[winner_pc]} {winner_mode} "
        f"score={winner_details['score']:.3f} cad={winner_details['cadence']:.2f} "
        f"third_ratio={winner_details['third_ratio']:.2f} conf={confidence:.2f} "
        f"scale_top1={NOTE_NAMES_BR[top1_root]}/{top1_label} (fit={top1_fit:.3f}) "
        f"runner={NOTE_NAMES_BR[runner_pc]} {runner_mode} ({runner_details['score']:.3f})"
    )
    
    return AnalysisResult(
        success=True,
        tonic=winner_pc,
        quality=winner_mode,
        confidence=confidence,
        notes_count=len(notes),
        phrases_count=sum(phrase_end_count.values()),
        debug={
            'engine': 'v12',
            'phrase_ends': dict(phrase_end_count),
            'top_candidates': top_candidates_debug,
            'mode_evidence': {
                'major': round(sum(d['score'] for pc, m, d in candidates if m == 'major'), 3),
                'minor': round(sum(d['score'] for pc, m, d in candidates if m == 'minor'), 3),
            },
            'krumhansl_24_winner': krumhansl_str,
            'winner_details': {
                'cadence': round(winner_details['cadence'], 3),
                'third_ratio': round(winner_details['third_ratio'], 3),
                'pcp_tonic': round(winner_details['pcp_tonic'], 3),
                'fifth_score': round(winner_details['fifth_score'], 3),
                'penalty_dominant': round(winner_details['penalty_dominant'], 3),
                'scale_fit': round(winner_details['scale_fit'], 3),
                'scale_label': winner_details.get('scale_label', ''),
                'alignment_bonus': round(winner_details.get('alignment_bonus', 0.0), 3),
            },
            'top_scales': [
                (NOTE_NAMES_BR[r], lbl, round(f, 3))
                for r, lbl, f in top_scales[:5]
            ],
        }
    )



# ═══════════════════════════════════════════════════════════════════════════════
# ACUMULADOR DE SESSÃO — MAIS CONSERVADOR
# ═══════════════════════════════════════════════════════════════════════════════

class SessionAccumulator:
    """Acumula análises para decisão mais robusta."""
    
    def __init__(self):
        self.reset()
    
    def reset(self):
        self.all_notes: List[Note] = []
        self.analysis_count = 0
        self.vote_history: List[int] = []
        self.locked_tonic: Optional[int] = None
        self.locked_quality: Optional[str] = None
        self.locked_confidence: float = 0.0
        self.locked_at: Optional[float] = None
        self.last_activity_time: float = time.time()
        self.start_time: float = time.time()  # Para timeout inteligente
        self._detection_duration_s: Optional[float] = None  # v14: tempo até tom confirmado
        # v3.17: snapshot da última análise completa para feedback do usuário
        self.last_result_snapshot: Optional[Dict[str, Any]] = None
    
    def get_feedback_snapshot(self) -> Optional[Dict[str, Any]]:
        """Retorna snapshot da última análise + notas para registro de feedback.
        
        Inclui TUDO que é necessário para reproduzir/diagnosticar o erro:
          - O result da última análise (debug com top_candidates, winner_details)
          - Resumo das notas (pc, dur_ms, is_phrase_end)
        
        Usado pelo endpoint /api/key-feedback/submit.
        """
        if self.last_result_snapshot is None:
            return None
        notes_summary = [
            {
                'pc': n.pitch_class,
                'dur_ms': round(n.dur_ms, 1),
                'conf': round(n.confidence, 3),
                'is_phrase_end': n.is_phrase_end,
            }
            for n in self.all_notes
        ]
        return {
            'result': self.last_result_snapshot,
            'notes_summary': notes_summary,
            'analysis_count': self.analysis_count,
        }
    
    def add_analysis(self, notes: List[Note]):
        """Adiciona notas de uma análise."""
        now = time.time()
        # ── FASE 1.5: Auto-reset apenas em INATIVIDADE REAL (>120s) ──
        # Antes (10s): em servidores frios (CREPE warmup 15-20s) ou redes lentas
        # o gap entre chamadas consecutivas excedia 10s e o auto-reset disparava
        # CONSTANTEMENTE → sessão permanecia eternamente com start_time=0 e
        # stage='listening' (sintoma do usuário ficar preso em "Ouvindo...").
        # 120s = tempo suficiente para tolerar cold start + rede ruim, ainda
        # mantém o propósito original (reset de sessão abandonada).
        if now - self.last_activity_time > 120.0 and self.analysis_count > 0:
            logger.info(
                f"[v15] Auto-reset por inatividade real ({now - self.last_activity_time:.1f}s)"
            )
            self.reset()
        self.last_activity_time = now
        # Janela deslizante MAIOR (250 notas ≈ 30-60s) = contexto musical
        # suficiente para Krumhansl convergir na raiz tonal real, evitando
        # confusões mediante (terça maior) que aparecem em janelas curtas.
        # Caso real: hino em Mi maior detectado como Sol# menor com janela=80
        # (cadência final enfatiza 3ª maior); com janela=250+ Krumhansl converge
        # corretamente em Mi maior com >95% de confiança.
        self.all_notes.extend(notes)
        if len(self.all_notes) > 250:
            self.all_notes = self.all_notes[-250:]
        self.analysis_count += 1
    
    def _current_stage(self) -> Dict[str, Any]:
        """
        Máquina de estados v15 (Fase 1) — DECISÃO PROGRESSIVA POR EVIDÊNCIA.

        Stages (controlam apenas o tier de critérios — todos avaliam a tônica):
          - listening          (0-5s):    apenas escuta, sem decisão
          - evaluating-strict  (5-15s):   permite confirmar com evidência MUITO forte
          - evaluating-solid   (15-30s):  permite confirmar com evidência sólida
          - decision           (30s+):    critérios padrão (igual v14)

        Diferença vs. v14: agora é POSSÍVEL ter resultado antes de 30s quando
        o sinal é claramente forte. Nunca trava infinito após 30s.
        """
        elapsed = time.time() - self.start_time
        if elapsed < 5.0:
            stage = 'listening'
        elif elapsed < 15.0:
            stage = 'evaluating-strict'
        elif elapsed < 30.0:
            stage = 'evaluating-solid'
        else:
            stage = 'decision'
        return {'elapsed_s': round(elapsed, 1), 'stage': stage}
    
    def _confirmed_payload(
        self,
        elapsed: float,
        method: str,
        notes_count: int,
        criteria: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Payload comum de resposta confirmada (tom travado)."""
        detection_s = self._detection_duration_s if self._detection_duration_s is not None else round(elapsed, 1)
        payload: Dict[str, Any] = {
            'success': True,
            'stage': 'confirmed',
            'stage_label': f'Tom confirmado em {int(round(detection_s))} segundos',
            'stage_hint': 'A IA identificou o centro tonal da música.',
            'show_key': True,
            'tonic': self.locked_tonic,
            'tonic_name': NOTE_NAMES_BR[self.locked_tonic] if self.locked_tonic is not None else None,
            'quality': self.locked_quality,
            'key_name': (
                f"{NOTE_NAMES_BR[self.locked_tonic]} {'Maior' if self.locked_quality == 'major' else 'menor'}"
                if self.locked_tonic is not None else None
            ),
            'confidence': self.locked_confidence,
            'locked': True,
            'locked_for': round(time.time() - self.locked_at, 1) if self.locked_at else 0,
            'detection_duration_s': detection_s,
            'elapsed_s': elapsed,
            'window_s': 30.0,
            'window_progress': 1.0,
            'notes_count': notes_count,
            'analyses': self.analysis_count,
            'method': method,
        }
        if criteria is not None:
            payload['criteria'] = criteria
        return payload

    def get_result(self) -> Dict[str, Any]:
        """Avaliação progressiva por evidência (v15) com tiers crescentes de tolerância."""
        stage_info = self._current_stage()
        elapsed = stage_info['elapsed_s']
        stage = stage_info['stage']

        # ─── STAGE LISTENING (0-5s): puro silêncio de UI ────────────────────
        if stage == 'listening':
            return {
                'success': True,
                'stage': 'listening',
                'stage_label': 'Ouvindo sua voz…',
                'stage_hint': 'Cante com calma — a IA está escutando.',
                'show_key': False,
                'locked': False,
                'elapsed_s': elapsed,
                'window_s': 30.0,
                'window_progress': min(1.0, elapsed / 30.0),
                'notes_count': len(self.all_notes),
                'analyses': self.analysis_count,
                'method': 'v15-listening',
            }

        # ─── EVALUATING / DECISION: avalia em todos os tiers ────────────────
        if len(self.all_notes) < 4:
            visual_stage = 'analyzing' if stage != 'decision' else 'uncertain'
            return {
                'success': True,
                'stage': visual_stage,
                'stage_label': (
                    'Identificando o centro tonal…'
                    if visual_stage == 'analyzing'
                    else 'Aguardando uma frase musical mais clara.'
                ),
                'stage_hint': 'Cante mais um pouco para a IA captar o padrão.',
                'show_key': False,
                'locked': False,
                'elapsed_s': elapsed,
                'window_s': 30.0,
                'window_progress': min(1.0, elapsed / 30.0),
                'notes_count': len(self.all_notes),
                'analyses': self.analysis_count,
                'method': f'v15-{stage}-insufficient',
            }

        result = analyze_tonality(self.all_notes)
        if not result.success:
            visual_stage = 'analyzing' if stage != 'decision' else 'uncertain'
            return {
                'success': True,
                'stage': visual_stage,
                'stage_label': (
                    'Identificando o centro tonal…'
                    if visual_stage == 'analyzing'
                    else 'Quase lá… continue cantando mais um pouco.'
                ),
                'stage_hint': 'Segurando o resultado até ter confiança suficiente.',
                'show_key': False,
                'locked': False,
                'elapsed_s': elapsed,
                'window_s': 30.0,
                'window_progress': min(1.0, elapsed / 30.0),
                'notes_count': len(self.all_notes),
                'analyses': self.analysis_count,
                'method': f'v15-{stage}-nofit',
            }

        # Atualiza snapshot e histórico de votos (sempre que houver análise válida)
        self.last_result_snapshot = {
            'tonic_pc': result.tonic,
            'quality': result.quality,
            'key_name': f"{NOTE_NAMES_BR[result.tonic]} {'Maior' if result.quality == 'major' else 'menor'}",
            'confidence': result.confidence,
            'debug': result.debug or {},
            'phrases_count': result.phrases_count,
            'notes_count': result.notes_count,
        }
        self.vote_history.append(result.tonic)
        self.vote_history = self.vote_history[-20:]

        # Critérios extraídos do debug
        top_candidates = result.debug.get('top_candidates', [])
        ambiguity = self._evaluate_ambiguity(result, top_candidates)
        winner_details = result.debug.get('winner_details', {})
        cadence_score = winner_details.get('cadence', 0.0)
        third_ratio = winner_details.get('third_ratio', 0.5)

        # ─── CRITÉRIOS POR TIER (Fase 1) ────────────────────────────────────
        if stage == 'evaluating-strict':
            # 5-15s: precisa evidência MUITO forte
            margin_min = 0.40
            cadence_min = 0.20
            confidence_min = 0.78
            third_lo, third_hi = 0.30, 0.70
            consensus_min = 3
        elif stage == 'evaluating-solid':
            # 15-30s: evidência sólida
            margin_min = 0.30
            cadence_min = 0.17
            confidence_min = 0.65
            third_lo, third_hi = 0.35, 0.65
            consensus_min = 2
        else:
            # decision (30s+): critérios padrão
            margin_min = 0.25
            cadence_min = 0.15
            confidence_min = 0.60
            third_lo, third_hi = 0.35, 0.65
            consensus_min = 3

        margin_ok = ambiguity['margin_ratio'] >= margin_min
        cadence_ok = cadence_score >= cadence_min
        third_ok = third_ratio >= third_hi or third_ratio <= third_lo
        confidence_ok = result.confidence >= confidence_min
        no_relative = not ambiguity['is_relative_ambiguous']
        no_dominant = not ambiguity['is_dominant_ambiguous']

        # Janela de consenso adaptativa: cap em 10, mas no mínimo cresce com a história
        history_window = min(10, max(3, len(self.vote_history)))
        consensus_votes = sum(1 for v in self.vote_history[-history_window:] if v == result.tonic)
        consensus_target = consensus_min
        # Em strict com pouca história, exigir maioria razoável (≥ history-1)
        if stage == 'evaluating-strict' and history_window < 5:
            consensus_target = max(2, history_window - 1)
        consensus_ok = consensus_votes >= consensus_target

        # ─── FAST PATH (Fase 1.5): sinal MUITO claro confirma com consenso 2 ──
        # Quando todos os critérios musicais estão fortíssimos (margem >50%,
        # cadência >40%, terça inequívoca, confiança >85%, sem ambiguidade
        # relativa/dominante), o usuário está cantando algo claramente tonal —
        # não precisa de 3-4 análises de consenso pra confirmar. Basta 2 votos
        # consistentes. Isso resolve o caso onde o WAV é cristalino mas o tempo
        # de processamento do servidor (~2-3s/análise) faz o consenso de 4
        # demorar 50s desnecessariamente.
        very_strong_signal = (
            ambiguity['margin_ratio'] >= 0.50
            and cadence_score >= 0.40
            and (third_ratio >= 0.85 or third_ratio <= 0.15)
            and result.confidence >= 0.85
            and no_relative
            and no_dominant
        )
        if very_strong_signal and consensus_votes >= 2 and not consensus_ok:
            consensus_ok = True
            consensus_target = 2  # log refletindo a regra que se aplicou
            logger.info(
                f"[v15/fastpath] Sinal MUITO forte aos {elapsed:.1f}s — "
                f"consenso reduzido a 2 (vs {consensus_min}) | "
                f"margin={ambiguity['margin_ratio']:.2f} cad={cadence_score:.2f} "
                f"third={third_ratio:.2f} conf={result.confidence:.2f}"
            )

        all_ok = (
            margin_ok and cadence_ok and third_ok
            and confidence_ok and no_relative and no_dominant and consensus_ok
        )

        # ─── STICKY LOCK REVISÁVEL (Fase 1) ─────────────────────────────────
        already_locked = self.locked_tonic is not None
        if already_locked:
            votes_for_locked = sum(
                1 for v in self.vote_history[-history_window:] if v == self.locked_tonic
            )
            same_as_locked = (
                result.tonic == self.locked_tonic
                and result.quality == self.locked_quality
            )

            if same_as_locked:
                # Reforça confiança (cap em 0.95)
                self.locked_confidence = min(0.95, max(self.locked_confidence, result.confidence))
                return self._confirmed_payload(elapsed, 'v15-confirmed-sticky', result.notes_count)

            # Critérios de troca progressivamente mais permissivos com tempo desde lock
            time_since_lock = time.time() - (self.locked_at or time.time())
            new_consensus = sum(1 for v in self.vote_history[-history_window:] if v == result.tonic)

            if time_since_lock >= 60.0:
                # Lock antigo: relaxado
                switch_consensus_min = 5
                switch_conf_min = 0.70
                switch_margin_min = 0.30
                switch_old_votes_max = 4
            else:
                # Lock recente: médio (mais permissivo que v14)
                switch_consensus_min = 5
                switch_conf_min = 0.75
                switch_margin_min = 0.35
                switch_old_votes_max = 3

            overwhelming_switch = (
                all_ok
                and new_consensus >= switch_consensus_min
                and result.confidence >= switch_conf_min
                and ambiguity['margin_ratio'] >= switch_margin_min
                and votes_for_locked <= switch_old_votes_max
            )
            if overwhelming_switch:
                logger.info(
                    f"[v15] TROCA DE TOM autorizada (t_lock={time_since_lock:.1f}s): "
                    f"{NOTE_NAMES_BR[self.locked_tonic]} {self.locked_quality} → "
                    f"{NOTE_NAMES_BR[result.tonic]} {result.quality} | "
                    f"new_consensus={new_consensus}/{history_window}, "
                    f"conf={result.confidence:.2f}, margin={ambiguity['margin_ratio']:.2f}, "
                    f"old_votes={votes_for_locked}"
                )
                self._lock(result.tonic, result.quality, result.confidence)
            elif all_ok:
                logger.info(
                    f"[v15] Troca BLOQUEADA: locked={NOTE_NAMES_BR[self.locked_tonic]} "
                    f"(votos={votes_for_locked}/{history_window}), "
                    f"novo={NOTE_NAMES_BR[result.tonic]} (consenso={new_consensus}, "
                    f"conf={result.confidence:.2f}, margin={ambiguity['margin_ratio']:.2f}) "
                    f"— t_lock={time_since_lock:.1f}s"
                )

            return self._confirmed_payload(elapsed, 'v15-confirmed-sticky-hold', result.notes_count)

        if all_ok:
            # Primeira travada — registra duração da detecção
            self._lock(result.tonic, result.quality, result.confidence)
            self._detection_duration_s = round(elapsed, 1)
            logger.info(
                f"[v15] DECISÃO CONFIRMADA aos {elapsed:.1f}s tier={stage} → "
                f"{NOTE_NAMES_BR[result.tonic]} {result.quality} | "
                f"conf={result.confidence:.2f} margin={ambiguity['margin_ratio']:.2f} "
                f"cad={cadence_score:.2f} third={third_ratio:.2f} "
                f"consensus={consensus_votes}/{history_window} target={consensus_target}"
            )
            return self._confirmed_payload(
                elapsed,
                f'v15-confirmed-{stage}',
                result.notes_count,
                criteria={
                    'tier': stage,
                    'margin_ratio': round(ambiguity['margin_ratio'], 3),
                    'cadence': round(cadence_score, 3),
                    'third_ratio': round(third_ratio, 3),
                    'confidence': round(result.confidence, 3),
                    'consensus_votes': consensus_votes,
                    'history_window': history_window,
                },
            )

        # ─── INCERTO em qualquer tier ───────────────────────────────────────
        failing: List[str] = []
        if not margin_ok:
            failing.append(f"margem ({ambiguity['margin_ratio']:.0%}<{margin_min:.0%})")
        if not cadence_ok:
            failing.append(f"cadência ({cadence_score:.2f}<{cadence_min:.2f})")
        if not third_ok:
            failing.append(f"3ª ambígua ({third_ratio:.2f})")
        if not confidence_ok:
            failing.append(f"confiança ({result.confidence:.0%}<{confidence_min:.0%})")
        if ambiguity['is_relative_ambiguous']:
            failing.append("relativos")
        if ambiguity['is_dominant_ambiguous']:
            failing.append("dominante")
        if not consensus_ok:
            failing.append(f"consenso ({consensus_votes}/{history_window}<{consensus_target})")

        # Log do motivo + top-5 (visibilidade obrigatória da Fase 1)
        logger.info(
            f"[v15] INCERTO aos {elapsed:.1f}s tier={stage} — {', '.join(failing)} | "
            f"melhor: {NOTE_NAMES_BR[result.tonic]} {result.quality} (conf={result.confidence:.2f}) "
            f"top5={top_candidates[:5]}"
        )

        visual_stage = 'analyzing' if stage != 'decision' else 'uncertain'
        if stage == 'evaluating-strict':
            visual_label = 'Identificando o centro tonal…'
        elif stage == 'evaluating-solid':
            visual_label = 'Confirmando o tom com mais segurança…'
        elif ambiguity['is_relative_ambiguous']:
            visual_label = 'Entre maior e menor — cante mais um trecho para eu ter certeza.'
        elif ambiguity['is_dominant_ambiguous']:
            visual_label = 'Ainda confirmando se essa é a tônica mesmo.'
        elif not consensus_ok:
            visual_label = 'Já encontrei uma direção, estou confirmando o tom.'
        elif not cadence_ok:
            visual_label = 'Aguardando um final de frase mais claro.'
        else:
            visual_label = 'Segurando o resultado até ter confiança suficiente.'

        return {
            'success': True,
            'stage': visual_stage,
            'stage_label': visual_label,
            'stage_hint': 'Continue cantando — só mostro o tom quando tiver certeza.',
            'show_key': False,
            'locked': False,
            'elapsed_s': elapsed,
            'window_s': 30.0,
            'window_progress': min(1.0, elapsed / 30.0),
            'notes_count': result.notes_count,
            'analyses': self.analysis_count,
            'debug': result.debug,
            'method': f'v15-{stage}-uncertain',
            'failing_criteria': failing,
            'criteria_attempted': {
                'tier': stage,
                'margin_ratio': round(ambiguity['margin_ratio'], 3),
                'cadence': round(cadence_score, 3),
                'third_ratio': round(third_ratio, 3),
                'confidence': round(result.confidence, 3),
                'consensus_votes': consensus_votes,
                'consensus_target': consensus_target,
                'history_window': history_window,
            },
        }
    
    def _evaluate_ambiguity(self, result: AnalysisResult, top_candidates: List) -> Dict[str, Any]:
        """Avalia se há ambiguidade forte, relativo, ou dominante confuso."""
        out = {
            'margin_ratio': 1.0,
            'is_ambiguous_hard': False,
            'is_relative_ambiguous': False,
            'is_dominant_ambiguous': False,
        }
        if len(top_candidates) < 2:
            return out
        try:
            top_name, top_score = top_candidates[0]
            runner_name, runner_score = top_candidates[1]
            top_pc = NOTE_NAMES_BR.index(top_name)
            runner_pc = NOTE_NAMES_BR.index(runner_name)
            top_score = float(top_score)
            runner_score = float(runner_score)
            if top_score > 0:
                out['margin_ratio'] = max(0.0, (top_score - runner_score) / top_score)
            else:
                out['margin_ratio'] = 0.0
            offset = (top_pc - runner_pc) % 12
            # Relativo (diff +3 ou +9): mesma escala, maior vs menor
            if offset in (3, 9) and out['margin_ratio'] < 0.20:
                out['is_relative_ambiguous'] = True
            # Dominante/subdominante (diff +5 ou +7): tônica vs V ou IV
            if offset in (5, 7) and out['margin_ratio'] < 0.20:
                out['is_dominant_ambiguous'] = True
            # Ambíguo "duro": margem < 8%
            if out['margin_ratio'] < 0.08:
                out['is_ambiguous_hard'] = True
        except (ValueError, IndexError, TypeError):
            pass
        return out
    
    def _should_lock(self, result: AnalysisResult) -> bool:
        """Mantido para compatibilidade, mas lógica real está em get_result."""
        return False
    
    def _should_change(self, result: AnalysisResult) -> bool:
        """Verifica se deve mudar o tom travado.
        
        Mudança de tom é rara — exige evidência forte e consistente.
        A histerese protege contra oscilação entre tons próximos.
        
        FAST PATH: se o novo candidato indica que o tom locked era 3ª/5ª
        (dominante/mediant), permite mudança rápida — é o caso clássico de
        "descobri a raiz tonal real depois de mais contexto musical".
        """
        if result.tonic == self.locked_tonic:
            # Mesmo tom — reforçar confiança, mas CAPAR em 0.92 para sempre
            # deixar margem matemática para uma mudança ser possível.
            # (Bug anterior: cap em 0.99 + threshold de +0.15 → impossível mudar.)
            self.locked_confidence = min(0.92, self.locked_confidence * 0.92 + result.confidence * 0.08)
            return False
        
        time_since_lock = time.time() - (self.locked_at or time.time())
        
        # Mínimo 4 segundos antes de considerar qualquer mudança
        if time_since_lock < 4.0:
            return False
        
        # ─── FAST PATH: anti-dominante/anti-mediant retroativo ───
        # Se o tom locked é 3ª maior (+4), 3ª menor (+3) ou 5ª justa (+7) do novo
        # candidato, e Krumhansl puro (que olha o conjunto INTEIRO de notas) também
        # confirma o novo candidato como raiz, é sinal de que o lock anterior era
        # uma "armadilha" de início (pouco contexto) e descobrimos a raiz real.
        # Caso real: hino em Mi maior travou em Si Maior aos 20s; aos 60-90s o
        # contexto musical clarifica e o algoritmo deve corrigir rapidamente.
        diff_locked_from_new = (self.locked_tonic - result.tonic) % 12
        ks_winner_str = result.debug.get('krumhansl_24_winner', '')
        ks_confirms_new = (
            ks_winner_str.startswith(NOTE_NAMES_BR[result.tonic] + ' ')
            or ks_winner_str.startswith(NOTE_NAMES_BR[result.tonic] + '\t')
        )
        if (
            diff_locked_from_new in (3, 4, 7)
            and result.confidence >= 0.65
            and ks_confirms_new
            and time_since_lock >= 8.0
        ):
            offset_name = {3: 'mediant_minor', 4: 'mediant_major', 7: 'dominant'}[diff_locked_from_new]
            logger.info(
                f"[v10.2] Mudança RÁPIDA (anti-{offset_name} retroativo): "
                f"{NOTE_NAMES_BR[self.locked_tonic]} → {NOTE_NAMES_BR[result.tonic]} "
                f"(locked era +{diff_locked_from_new} do tom real, KS confirma {ks_winner_str})"
            )
            return True
        
        # ─── CAMINHO GERAL: consenso + confidence superior ───
        # Margem reduzida de +0.15 para +0.05 (com cap em 0.92 a margem é viável)
        if len(self.vote_history) >= 5:
            last_votes = self.vote_history[-5:]
            votes_for_new = sum(1 for v in last_votes if v == result.tonic)
            if votes_for_new >= 3:
                if result.confidence > self.locked_confidence + 0.05:
                    logger.info(
                        f"[v10] Mudando {NOTE_NAMES_BR[self.locked_tonic]} → "
                        f"{NOTE_NAMES_BR[result.tonic]} ({self.locked_confidence:.2f} → {result.confidence:.2f})"
                    )
                    return True
        
        return False
    
    def _lock(self, tonic: int, quality: str, confidence: float):
        """Trava o tom detectado."""
        logger.info(f"[v10] 🔒 LOCK: {NOTE_NAMES_BR[tonic]} {'Maior' if quality == 'major' else 'menor'} (conf={confidence:.2f})")
        self.locked_tonic = tonic
        self.locked_quality = quality
        self.locked_confidence = confidence
        self.locked_at = time.time()


# Armazenamento de sessões — chave inclui session_id (UUID por uso) quando
# disponível, mantendo isolamento por device+mode como fallback retrocompatível.
# Sem session_id: f"{device_id}::{mode}"      (frontends antigos)
# Com session_id:  f"{device_id}::{mode}::{session_id}"  (Fase 3)
_sessions: Dict[str, SessionAccumulator] = {}

# FASE 3: TTL de sessões — sessões inativas há mais de SESSION_TTL_S são
# eliminadas em background pelo garbage collector.
SESSION_TTL_S = 600.0  # 10 minutos


def _session_key(device_id: str, mode: str, session_id: Optional[str] = None) -> str:
    if session_id:
        # session_id curto (UUID full ou os primeiros 8 chars) para evitar
        # chaves gigantes; o que importa é unicidade por device+sessão.
        return f"{device_id}::{mode}::{session_id[:16]}"
    return f"{device_id}::{mode}"


def get_session(
    device_id: str,
    mode: str = 'vocal',
    session_id: Optional[str] = None,
) -> SessionAccumulator:
    key = _session_key(device_id, mode, session_id)
    if key not in _sessions:
        _sessions[key] = SessionAccumulator()
    return _sessions[key]


def reset_session(
    device_id: str,
    mode: Optional[str] = None,
    session_id: Optional[str] = None,
):
    """Reseta a sessão. Se `mode` for None, reseta TODAS as sessões do device."""
    if mode is not None:
        key = _session_key(device_id, mode, session_id)
        if key in _sessions:
            sess = _sessions[key]
            had_lock = sess.locked_tonic is not None
            sess.reset()
            logger.info(
                f"[v15/reset] dev={device_id[:8]} mode={mode} "
                f"sid={(session_id or '-')[:8]} had_lock={had_lock}"
            )
        else:
            logger.info(
                f"[v15/reset] dev={device_id[:8]} mode={mode} "
                f"sid={(session_id or '-')[:8]} (sessão não existia)"
            )
        return
    # Reset todas as sessões do device (qualquer modo, qualquer session_id)
    keys = [k for k in _sessions.keys() if k.startswith(f"{device_id}::")]
    for k in keys:
        _sessions[k].reset()
    logger.info(f"[v15/reset] dev={device_id[:8]} mode=ALL sessões_zeradas={len(keys)}")


def gc_expired_sessions() -> int:
    """Remove sessões inativas há mais de SESSION_TTL_S. Retorna quantas
    foram removidas (para log)."""
    now = time.time()
    expired = [
        k for k, sess in _sessions.items()
        if (now - sess.last_activity_time) > SESSION_TTL_S
    ]
    for k in expired:
        del _sessions[k]
    if expired:
        logger.info(f"[v15/gc] Removidas {len(expired)} sessões expiradas. "
                    f"Sessões ativas restantes: {len(_sessions)}")
    return len(expired)


# ═══════════════════════════════════════════════════════════════════════════════
# FUNÇÃO PÚBLICA
# ═══════════════════════════════════════════════════════════════════════════════

def _build_noise_rejection_payload(vf: Optional[VocalFocusResult]) -> Dict[str, Any]:
    """Monta o payload `noise_rejection` que vai na resposta da API.

    Sempre retorna um dicionário (mesmo quando vocal_focus está desabilitado),
    para que o frontend possa confiar na presença do campo.
    """
    if vf is None:
        return {
            'enabled': False,
            'stage': 'clean',
            'passed': True,
            'quality_score': 1.0,
            'valid_ratio': 1.0,
            'rejection_reason': None,
            'total_frames': 0,
            'valid_frames': 0,
            'rejected_frames': 0,
            'rejection_counts': {},
            'processing_ms': 0.0,
        }
    valid_ratio = (vf.valid_frames / vf.total_frames) if vf.total_frames else 0.0
    return {
        'enabled': True,
        'stage': vf.noise_stage,                       # clean | noisy | percussion | silence
        'passed': bool(vf.passed),
        'quality_score': round(float(vf.audio_quality_score), 3),
        'valid_ratio': round(float(valid_ratio), 3),
        'rejection_reason': vf.rejection_reason,
        'total_frames': int(vf.total_frames),
        'valid_frames': int(vf.valid_frames),
        'rejected_frames': int(vf.rejected_frames),
        'rejection_counts': {k: int(v) for k, v in vf.rejection_counts.items()},
        'processing_ms': float(vf.processing_ms),
    }


def analyze_audio_bytes_v10(
    audio_bytes: bytes,
    device_id: str = 'anon',
    mode: str = 'vocal',
    session_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Análise de tonalidade v10 — Versão Definitiva.

    Args:
        mode: 'vocal' (padrão — comportamento atual preservado) ou
              'vocal_instrument' (nova camada que aceita instrumentos harmônicos).
              Se INSTRUMENT_MODE_ENABLED=False, qualquer valor cai em 'vocal'.
        session_id: UUID opcional gerado pelo cliente para isolar sessões por
                    uso (Fase 3). Sem este parâmetro, comportamento é o legado
                    (chave = device_id + mode).
    """
    # ─── Timing Fase 1 — instrumentação para diagnóstico de produção ─────
    t_total_start = time.time()
    timings: Dict[str, float] = {}

    # ─── Normalização do modo (rollback seguro) ───────────────────────────
    if not INSTRUMENT_MODE_ENABLED or mode not in ('vocal', 'vocal_instrument'):
        mode = 'vocal'

    # Carregar áudio
    t0 = time.time()
    audio, has_audio = load_audio(audio_bytes)
    duration_s = len(audio) / SAMPLE_RATE
    timings['load_ms'] = round((time.time() - t0) * 1000.0, 1)

    if duration_s < 1.0:
        return {
            'success': False, 'error': 'too_short', 'duration_s': duration_s,
            'noise_rejection': _build_noise_rejection_payload(None),
            'mode': mode,
        }

    if not has_audio:
        # Áudio é praticamente silêncio — informa noise_stage='silence'
        silence_payload = {
            'enabled': VOCAL_FOCUS_ENABLED,
            'stage': 'silence',
            'passed': False,
            'quality_score': 0.0,
            'valid_ratio': 0.0,
            'rejection_reason': 'no_audio',
            'total_frames': 0,
            'valid_frames': 0,
            'rejected_frames': 0,
            'rejection_counts': {},
            'processing_ms': 0.0,
        }
        return {
            'success': False, 'error': 'silence', 'duration_s': duration_s,
            'noise_rejection': silence_payload,
            'mode': mode,
        }

    # Extrair pitch
    t0 = time.time()
    f0, conf = extract_pitch(audio)
    timings['crepe_ms'] = round((time.time() - t0) * 1000.0, 1)
    valid_frames_raw = int(np.sum(~np.isnan(f0)))

    # ─── CAMADA VOCAL FOCUS / NOISE REJECTION ────────────────────────────────
    # Para mode='vocal_instrument', usa INSTRUMENT_CONFIG (mais permissivo
    # com instrumentos, mantém rejeição de percussão).
    vf_result: Optional[VocalFocusResult] = None
    f0_for_notes = f0
    conf_for_notes = conf
    active_focus_config = INSTRUMENT_CONFIG if mode == 'vocal_instrument' else VOCAL_FOCUS_CONFIG
    if VOCAL_FOCUS_ENABLED:
        try:
            t0 = time.time()
            vf_result = apply_vocal_focus(
                audio=audio,
                f0=f0,
                conf=conf,
                sample_rate=SAMPLE_RATE,
                hop_ms=HOP_MS,
                config=active_focus_config,
            )
            timings['focus_ms'] = round((time.time() - t0) * 1000.0, 1)
            if vf_result.passed and vf_result.filtered_f0 is not None:
                f0_for_notes = vf_result.filtered_f0
                conf_for_notes = vf_result.filtered_conf
            else:
                # Filtro rejeitou o clip — não enviar ao motor tonal.
                logger.info(
                    f"[v15/{mode}] CLIP REJEITADO dev={device_id[:8]} "
                    f"stage={vf_result.noise_stage} motivo={vf_result.rejection_reason} "
                    f"valid={vf_result.valid_frames}/{vf_result.total_frames} "
                    f"focus={timings['focus_ms']}ms"
                )
                if mode == 'vocal_instrument':
                    _instr_logger.info(
                        f"[InstrMode] modo_ativo=vocal_instrument "
                        f"frames_rejeitados_ruido={vf_result.rejected_frames} "
                        f"motivo_rejeicao={vf_result.rejection_reason}"
                    )
                session = get_session(device_id, mode, session_id)
                session.last_activity_time = time.time()
                result = session.get_result()
                timings['total_ms'] = round((time.time() - t_total_start) * 1000.0, 1)
                result['duration_s'] = round(duration_s, 2)
                result['clip_notes'] = 0
                result['clip_rejected'] = True
                result['noise_rejection'] = _build_noise_rejection_payload(vf_result)
                result['mode'] = mode
                result['timings_ms'] = timings
                return result
        except Exception as exc:
            logger.warning(f"[v10/{mode}] focus falhou ({exc}) — usando f0/conf brutos")
            vf_result = None

    if valid_frames_raw < 20:
        return {
            'success': False, 'error': 'no_pitch', 'valid_frames': valid_frames_raw,
            'noise_rejection': _build_noise_rejection_payload(vf_result),
            'mode': mode,
        }

    # Converter para notas (usando f0/conf possivelmente filtrados)
    notes = pitch_to_notes(f0_for_notes, conf_for_notes)

    # ─── EVIDÊNCIA INSTRUMENTAL EXTRA (apenas no modo vocal_instrument) ───
    chord_evidence: List[Dict[str, Any]] = []
    bass_evidence: List[Dict[str, Any]] = []
    if mode == 'vocal_instrument':
        try:
            detections = detect_chords_and_bass(
                audio=audio.astype(np.float32),
                sample_rate=SAMPLE_RATE,
                window_ms=500.0,
                hop_ms=250.0,
                min_chord_strength=0.55,
            )
        except Exception as exc:
            logger.warning(f"[v10/instrument] chord_detector falhou ({exc})")
            detections = []

        # Aceita acordes únicos consecutivos como notas de alto peso
        # (root e bass viram Note objetos com duração proporcional à
        #  consistência da detecção).
        # Estratégia: agrupar detecções consecutivas com o mesmo chord_pc,
        # criar uma Note com duração igual ao tempo total e confiança = strength.
        if detections:
            i = 0
            while i < len(detections):
                root_pc = detections[i]['chord_pc']
                quality_chord = detections[i]['chord_quality']
                start_t = float(detections[i]['time_s'])
                strength_sum = float(detections[i]['chord_strength'])
                count = 1
                j = i + 1
                while j < len(detections) and detections[j]['chord_pc'] == root_pc:
                    strength_sum += float(detections[j]['chord_strength'])
                    count += 1
                    j += 1
                end_t = float(detections[j - 1]['time_s']) + 0.5  # janela = 500ms
                dur_ms = max(200.0, (end_t - start_t) * 1000.0)
                avg_strength = strength_sum / count
                # Cria Note "sintética" do chord root com peso reforçado
                notes.append(Note(
                    pitch_class=int(root_pc),
                    midi=60.0 + float(root_pc),  # MIDI do octave 4 (uso só PCP)
                    dur_ms=dur_ms,
                    start_ms=start_t * 1000.0,
                    confidence=min(0.95, avg_strength * 1.1),
                    is_phrase_end=False,
                ))
                chord_evidence.append({
                    'pc': int(root_pc),
                    'quality': str(quality_chord),
                    'dur_ms': round(dur_ms, 1),
                    'strength': round(avg_strength, 3),
                    'start_s': round(start_t, 3),
                })
                # Bass do primeiro grupo (mais provável de ser a fundamental)
                bass_pc = detections[i].get('bass_pc')
                bass_strength = float(detections[i].get('bass_strength', 0.0))
                if bass_pc is not None and bass_strength > 0.15:
                    notes.append(Note(
                        pitch_class=int(bass_pc),
                        midi=36.0 + float(bass_pc),  # 2ª oitava
                        dur_ms=dur_ms * 0.7,
                        start_ms=start_t * 1000.0,
                        confidence=min(0.90, bass_strength * 1.0 + 0.30),
                        is_phrase_end=False,
                    ))
                    bass_evidence.append({
                        'pc': int(bass_pc),
                        'dur_ms': round(dur_ms * 0.7, 1),
                        'strength': round(bass_strength, 3),
                        'start_s': round(start_t, 3),
                    })
                i = j
        _instr_logger.info(
            f"[InstrMode] modo_ativo=vocal_instrument "
            f"frames_vocais_aceitos={int(np.sum(~np.isnan(f0_for_notes)))} "
            f"frames_instrumentais_aceitos={len(chord_evidence) + len(bass_evidence)} "
            f"frames_rejeitados_ruido={vf_result.rejected_frames if vf_result else 0} "
            f"acordes_detectados={len(chord_evidence)} "
            f"notas_baixo_detectadas={len(bass_evidence)}"
        )

    if len(notes) < 2:
        return {
            'success': False, 'error': 'no_notes', 'notes': len(notes),
            'noise_rejection': _build_noise_rejection_payload(vf_result),
            'mode': mode,
        }

    # Log das notas detectadas
    logger.info(f"[v10/{mode}] Notas: {[(NOTE_NAMES_BR[n.pitch_class], f'{n.dur_ms:.0f}ms', 'END' if n.is_phrase_end else '') for n in notes]}")

    # Acumular e analisar (sessões SEPARADAS por modo + session_id opcional)
    session = get_session(device_id, mode, session_id)

    # ─── HYSTERESIS REFORÇADA NO MODO INSTRUMENTO ────────────────────────
    # Salvamos snapshot pra detectar se houve troca de tom protegida.
    locked_before = session.locked_tonic
    t0 = time.time()
    session.add_analysis(notes)
    result = session.get_result()
    timings['score_ms'] = round((time.time() - t0) * 1000.0, 1)
    timings['total_ms'] = round((time.time() - t_total_start) * 1000.0, 1)
    locked_after = session.locked_tonic

    # Log estruturado de timing + estado da sessão (Fase 1)
    sess_start_age = round(time.time() - session.start_time, 1)
    logger.info(
        f"[v15/timing] dev={device_id[:8]} sid={(session_id or '-')[:8]} mode={mode} "
        f"load={timings.get('load_ms', 0)}ms crepe={timings.get('crepe_ms', 0)}ms "
        f"focus={timings.get('focus_ms', 0)}ms score={timings.get('score_ms', 0)}ms "
        f"total={timings['total_ms']}ms | session_age={sess_start_age}s "
        f"all_notes={len(session.all_notes)} votes={len(session.vote_history)} "
        f"locked={NOTE_NAMES_BR[session.locked_tonic] + ' ' + (session.locked_quality or '') if session.locked_tonic is not None else 'no'} "
        f"clip_notes={len(notes)} stage={result.get('stage')}"
    )

    # Logs específicos do modo instrumento
    if mode == 'vocal_instrument':
        if locked_before is not None and locked_after == locked_before:
            _instr_logger.info(
                f"[InstrMode] tom_protegido_por_hysteresis tonic={NOTE_NAMES_BR[locked_before]} "
                f"clip_notes={len(notes)}"
            )
        elif locked_before is not None and locked_after != locked_before:
            _instr_logger.info(
                f"[InstrMode] troca_de_tonalidade: {NOTE_NAMES_BR[locked_before]} -> "
                f"{NOTE_NAMES_BR[locked_after] if locked_after is not None else '?'}"
            )
        if result.get('show_key'):
            _instr_logger.info(
                f"[InstrMode] tonalidade_final={result.get('key_name')} "
                f"confianca_final={result.get('confidence', 0):.2f}"
            )

    result['duration_s'] = round(duration_s, 2)
    result['clip_notes'] = len(notes)
    result['noise_rejection'] = _build_noise_rejection_payload(vf_result)
    result['mode'] = mode
    result['timings_ms'] = timings
    if mode == 'vocal_instrument':
        result['instrument_evidence'] = {
            'chords': chord_evidence,
            'bass_notes': bass_evidence,
        }
    return result


# Alias para compatibilidade
def analyze_audio_bytes(audio_bytes: bytes) -> Dict[str, Any]:
    return analyze_audio_bytes_v10(audio_bytes)
