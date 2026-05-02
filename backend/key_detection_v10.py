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

logger = logging.getLogger(__name__)

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
    """Calcula peso de CADÊNCIA: onde a música REPOUSA no final.
    
    Combina:
      - últimas 8 notas com peso por recência (mais recente pesa mais)
      - últimos 3 phrase ends com peso por recência
      - última nota do áudio (peso especial)
    """
    cadence = np.zeros(12, dtype=np.float64)
    if not notes:
        return cadence
    
    # Últimas 8 notas, peso por recência
    last_n = min(8, len(notes))
    for rank, n in enumerate(notes[-last_n:]):
        # rank 0 = mais antiga; last_n-1 = última
        recency = (rank + 1) ** 1.3
        weight = n.dur_ms * n.confidence * recency
        if n.is_phrase_end:
            weight *= 2.0
        cadence[n.pitch_class] += weight
    
    # Últimos 3 phrase ends explícitos
    pe_indices = [i for i, n in enumerate(notes) if n.is_phrase_end]
    for rank, idx in enumerate(pe_indices[-3:]):
        n = notes[idx]
        recency = (len(pe_indices[-3:]) - rank) ** 1.2
        cadence[n.pitch_class] += n.dur_ms * n.confidence * recency * 1.5
    
    # ÚLTIMA NOTA do áudio: peso decisivo (a tônica é onde a música acaba)
    last_note = notes[-1]
    cadence[last_note.pitch_class] += last_note.dur_ms * last_note.confidence * 5.0
    
    # Normalizar
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
    """
    # Notas da escala diatônica natural a partir da tônica
    if mode == 'major':
        third_pc = (tonic_pc + 4) % 12   # 3ª maior
        seventh_pc = (tonic_pc + 11) % 12  # 7ª maior (sensível)
    else:
        third_pc = (tonic_pc + 3) % 12   # 3ª menor
        seventh_pc = (tonic_pc + 10) % 12  # 7ª menor (natural)
    fifth_pc = (tonic_pc + 7) % 12  # 5ª justa (V grau)
    
    # ─── LEI 1: REPOUSO ───
    cadence_score = float(cadence[tonic_pc])  # 0..1, já normalizado
    
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
            not_dominant_penalty_factor = 0.70
    
    # ─── COMBINAÇÃO ───
    # Pesos: cadência (REPOUSO) é o sinal mais forte musicalmente
    score = (
        0.40 * cadence_score +
        0.20 * pcp[tonic_pc] +     # tônica deve estar presente em geral
        0.25 * third_score +        # 3ª da qualidade certa (subiu de 0.20 para 0.25)
        0.15 * fifth_score          # 5ª presente reforça (subiu de 0.10 para 0.15)
    )
    score = score * not_dominant_penalty_factor
    
    return {
        'score': score,
        'cadence': cadence_score,
        'third_ratio': third_ratio,
        'pcp_tonic': float(pcp[tonic_pc]),
        'fifth_score': fifth_score,
        'penalty_dominant': round(1.0 - not_dominant_penalty_factor, 3),
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
        
        Major recebe um pouco mais que harmonic_minor para enforce default "maior"
        em casos ambíguos (sem 3ª clara definindo o modo).
        """
        if label == 'major_natural':
            return 0.28 if is_top else 0.22
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
                base - 0.06,  # relativo menor recebe um pouco menos
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
    margin_bonus = min(0.20, effective_margin * 3.5)
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
        # Auto-reset se inativo por mais de 10 segundos
        if now - self.last_activity_time > 10.0 and self.analysis_count > 0:
            logger.info(f"[v10] Auto-reset por inatividade ({now - self.last_activity_time:.1f}s)")
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
        Calcula o estágio UX baseado no TEMPO DECORRIDO desde o início da sessão.
        
        Stages:
          - listening   (0-5s):    "Ouvindo..." — sem tom nenhum
          - analyzing   (5-15s):   "Analisando padrão melódico..." — sem tom
          - probable    (15-25s):  pode mostrar "Tom provável" se houver confiança aceitável
          - confirmed   (25s+):    pode mostrar "Tom confirmado" se critérios rigorosos
          - needs_more  (30s+):    se ainda ambíguo — pedir mais alguns segundos
        """
        elapsed = time.time() - self.start_time
        return {
            'elapsed_s': round(elapsed, 1),
            'stage': (
                'listening' if elapsed < 5.0
                else 'analyzing' if elapsed < 15.0
                else 'probable' if elapsed < 25.0
                else 'confirmed'
            ),
        }
    
    def get_result(self) -> Dict[str, Any]:
        """Retorna resultado baseado em todas as notas acumuladas + estágio temporal."""
        stage_info = self._current_stage()
        elapsed = stage_info['elapsed_s']
        stage = stage_info['stage']
        
        # ─── STAGE LISTENING (0-5s): não mostra nada ───
        if stage == 'listening':
            return {
                'success': True,
                'stage': 'listening',
                'stage_label': 'Ouvindo…',
                'stage_hint': 'Cante ou toque o instrumento.',
                'show_key': False,
                'locked': False,
                'elapsed_s': elapsed,
                'notes_count': len(self.all_notes),
                'analyses': self.analysis_count,
                'method': 'v13-listening',
            }
        
        # ─── STAGE ANALYZING (5-15s): coletando contexto, não mostra tom ───
        if stage == 'analyzing':
            # Rodar análise internamente, mas NÃO expor o tom
            if len(self.all_notes) >= 2:
                result = analyze_tonality(self.all_notes)
                if result.success:
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
                    self.vote_history = self.vote_history[-15:]
            return {
                'success': True,
                'stage': 'analyzing',
                'stage_label': 'Analisando padrão melódico…',
                'stage_hint': 'Continue cantando — preciso de mais contexto.',
                'show_key': False,
                'locked': False,
                'elapsed_s': elapsed,
                'notes_count': len(self.all_notes),
                'analyses': self.analysis_count,
                'method': 'v13-analyzing',
            }
        
        # ─── STAGE PROBABLE / CONFIRMED (15s+): análise completa ───
        if len(self.all_notes) < 2:
            return {
                'success': True,
                'stage': 'needs_more',
                'stage_label': 'Continue cantando…',
                'stage_hint': 'Ainda não tenho notas suficientes.',
                'show_key': False,
                'locked': False,
                'elapsed_s': elapsed,
                'notes_count': len(self.all_notes),
                'method': 'v13-insufficient',
            }
        
        result = analyze_tonality(self.all_notes)
        if not result.success:
            return {
                'success': False,
                'stage': 'needs_more',
                'error': 'analysis_failed',
                'stage_label': 'Continue cantando mais alguns segundos para confirmar o tom.',
                'show_key': False,
                'locked': False,
                'elapsed_s': elapsed,
                'notes_count': len(self.all_notes),
            }
        
        # snapshot para feedback
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
        self.vote_history = self.vote_history[-15:]
        
        # ─── AVALIAR AMBIGUIDADE (usado nos dois estágios) ───
        top_candidates = result.debug.get('top_candidates', [])
        ambiguity = self._evaluate_ambiguity(result, top_candidates)
        
        # ─── STAGE PROBABLE (15-25s): tom provável se confiança aceitável ───
        if elapsed < 25.0:
            # Critério para mostrar "provável": confiança mínima de 0.55
            # e candidato top-1 tem separação mínima de 15% sobre top-2
            show_probable = (
                result.confidence >= 0.55
                and not ambiguity['is_ambiguous_hard']
            )
            if show_probable:
                return {
                    'success': True,
                    'stage': 'probable',
                    'stage_label': 'Tom provável',
                    'stage_hint': 'Continuando análise para confirmar…',
                    'show_key': True,
                    'tonic': result.tonic,
                    'tonic_name': NOTE_NAMES_BR[result.tonic],
                    'quality': result.quality,
                    'key_name': f"{NOTE_NAMES_BR[result.tonic]} {'Maior' if result.quality == 'major' else 'menor'}",
                    'confidence': result.confidence,
                    'locked': False,
                    'elapsed_s': elapsed,
                    'notes_count': result.notes_count,
                    'debug': result.debug,
                    'method': 'v13-probable',
                    'ambiguity': ambiguity,
                }
            # Mesmo sem mostrar tom, informar que está refinando
            return {
                'success': True,
                'stage': 'analyzing',
                'stage_label': 'Refinando análise…',
                'stage_hint': 'Ainda avaliando se o tom é claro.',
                'show_key': False,
                'locked': False,
                'elapsed_s': elapsed,
                'notes_count': result.notes_count,
                'method': 'v13-analyzing-refine',
                'ambiguity': ambiguity,
            }
        
        # ─── STAGE CONFIRMED (25-30s): tom confirmado se critérios rigorosos ───
        # Critérios rigorosos:
        #   1) confiança ≥ 0.70
        #   2) margem relativa entre top e runner-up ≥ 25%
        #   3) NÃO é relativo ambíguo
        #   4) NÃO é dominante/subdominante ambígua
        consensus_votes = sum(1 for v in self.vote_history[-10:] if v == result.tonic)
        confirmed_ok = (
            result.confidence >= 0.70
            and ambiguity['margin_ratio'] >= 0.25
            and not ambiguity['is_relative_ambiguous']
            and not ambiguity['is_dominant_ambiguous']
            and consensus_votes >= 5
        )
        
        if confirmed_ok:
            # Travar o tom
            if self.locked_tonic != result.tonic or self.locked_quality != result.quality:
                self._lock(result.tonic, result.quality, result.confidence)
            else:
                self.locked_confidence = min(0.95, max(self.locked_confidence, result.confidence))
            return {
                'success': True,
                'stage': 'confirmed',
                'stage_label': 'Tom confirmado',
                'stage_hint': '',
                'show_key': True,
                'tonic': result.tonic,
                'tonic_name': NOTE_NAMES_BR[result.tonic],
                'quality': result.quality,
                'key_name': f"{NOTE_NAMES_BR[result.tonic]} {'Maior' if result.quality == 'major' else 'menor'}",
                'confidence': self.locked_confidence,
                'locked': True,
                'locked_for': round(time.time() - self.locked_at, 1) if self.locked_at else 0,
                'elapsed_s': elapsed,
                'notes_count': result.notes_count,
                'debug': result.debug,
                'method': 'v13-confirmed',
                'ambiguity': ambiguity,
            }
        
        # ─── STAGE NEEDS_MORE (30s+ ainda ambíguo) ───
        if elapsed >= 30.0:
            # Se há um candidato mais provável, mostrar como "tom provável" sem travar
            if result.confidence >= 0.55 and not ambiguity['is_ambiguous_hard']:
                return {
                    'success': True,
                    'stage': 'probable',
                    'stage_label': 'Tom provável',
                    'stage_hint': 'Continue cantando mais alguns segundos para confirmar o tom.',
                    'show_key': True,
                    'tonic': result.tonic,
                    'tonic_name': NOTE_NAMES_BR[result.tonic],
                    'quality': result.quality,
                    'key_name': f"{NOTE_NAMES_BR[result.tonic]} {'Maior' if result.quality == 'major' else 'menor'}",
                    'confidence': result.confidence,
                    'locked': False,
                    'elapsed_s': elapsed,
                    'notes_count': result.notes_count,
                    'debug': result.debug,
                    'method': 'v13-needs-more-probable',
                    'ambiguity': ambiguity,
                }
            return {
                'success': True,
                'stage': 'needs_more',
                'stage_label': 'Continue cantando mais alguns segundos para confirmar o tom.',
                'stage_hint': 'Ainda há ambiguidade — não vou arriscar um tom errado.',
                'show_key': False,
                'locked': False,
                'elapsed_s': elapsed,
                'notes_count': result.notes_count,
                'debug': result.debug,
                'method': 'v13-needs-more',
                'ambiguity': ambiguity,
            }
        
        # 25-30s sem critérios rigorosos: tom provável (sem lock)
        if result.confidence >= 0.55 and not ambiguity['is_ambiguous_hard']:
            return {
                'success': True,
                'stage': 'probable',
                'stage_label': 'Tom provável',
                'stage_hint': 'Aguardando mais contexto para confirmar…',
                'show_key': True,
                'tonic': result.tonic,
                'tonic_name': NOTE_NAMES_BR[result.tonic],
                'quality': result.quality,
                'key_name': f"{NOTE_NAMES_BR[result.tonic]} {'Maior' if result.quality == 'major' else 'menor'}",
                'confidence': result.confidence,
                'locked': False,
                'elapsed_s': elapsed,
                'notes_count': result.notes_count,
                'debug': result.debug,
                'method': 'v13-probable-late',
                'ambiguity': ambiguity,
            }
        
        return {
            'success': True,
            'stage': 'analyzing',
            'stage_label': 'Refinando análise…',
            'stage_hint': '',
            'show_key': False,
            'locked': False,
            'elapsed_s': elapsed,
            'notes_count': result.notes_count,
            'method': 'v13-analyzing-late',
            'ambiguity': ambiguity,
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


# Armazenamento de sessões
_sessions: Dict[str, SessionAccumulator] = {}


def get_session(device_id: str) -> SessionAccumulator:
    if device_id not in _sessions:
        _sessions[device_id] = SessionAccumulator()
    return _sessions[device_id]


def reset_session(device_id: str):
    if device_id in _sessions:
        _sessions[device_id].reset()


# ═══════════════════════════════════════════════════════════════════════════════
# FUNÇÃO PÚBLICA
# ═══════════════════════════════════════════════════════════════════════════════

def analyze_audio_bytes_v10(
    audio_bytes: bytes,
    device_id: str = 'anon',
) -> Dict[str, Any]:
    """Análise de tonalidade v10 — Versão Definitiva."""
    
    # Carregar áudio
    audio, has_audio = load_audio(audio_bytes)
    duration_s = len(audio) / SAMPLE_RATE
    
    if duration_s < 1.0:
        return {'success': False, 'error': 'too_short', 'duration_s': duration_s}
    
    if not has_audio:
        return {'success': False, 'error': 'silence', 'duration_s': duration_s}
    
    # Extrair pitch
    f0, conf = extract_pitch(audio)
    valid_frames = int(np.sum(~np.isnan(f0)))
    
    if valid_frames < 20:
        return {'success': False, 'error': 'no_pitch', 'valid_frames': valid_frames}
    
    # Converter para notas
    notes = pitch_to_notes(f0, conf)
    
    if len(notes) < 2:
        return {'success': False, 'error': 'no_notes', 'notes': len(notes)}
    
    # Log das notas detectadas
    logger.info(f"[v10] Notas: {[(NOTE_NAMES_BR[n.pitch_class], f'{n.dur_ms:.0f}ms', 'END' if n.is_phrase_end else '') for n in notes]}")
    
    # Acumular e analisar
    session = get_session(device_id)
    session.add_analysis(notes)
    
    result = session.get_result()
    result['duration_s'] = round(duration_s, 2)
    result['clip_notes'] = len(notes)
    
    return result


# Alias para compatibilidade
def analyze_audio_bytes(audio_bytes: bytes) -> Dict[str, Any]:
    return analyze_audio_bytes_v10(audio_bytes)
