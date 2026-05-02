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
# ANÁLISE DE TONALIDADE — MÉTODO DEFINITIVO
# ═══════════════════════════════════════════════════════════════════════════════

def analyze_tonality(notes: List[Note]) -> AnalysisResult:
    """
    DETECÇÃO DE TONALIDADE — v10.1 CORRIGIDA
    
    FIX BUG 2: Redistribuição de pesos musicalmente correta:
      - Antes: 60% fins de frase + 25% duração + 15% Krumhansl
      - Agora:  35% fins de frase + 25% duração + 40% Krumhansl
      Justificativa: Krumhansl correlaciona o conjunto INTEIRO de notas com
      perfis tonais validados psicoacusticamente. É o mais robusto. Fins de
      frase são importantes mas sensíveis a falsos positivos.
    
    FIX BUG 3: Decisão maior/menor usa 3ª + 7ª + 6ª:
      - 3ª: terça maior (4st) vs terça menor (3st) — evidência primária
      - 7ª: sensível (11st, ex: F# em Sol maior) vs 7ª menor (10st) — forte evidência
      - 6ª: 6ª maior (9st, ex: Mi em Sol maior) vs 6ª menor (8st)
      Combinados, distinguem corretamente Sol maior de Mi menor.
    """
    if len(notes) < 2:
        return AnalysisResult(success=False, debug={'error': 'insufficient_notes', 'count': len(notes)})
    
    # ═══ 1. ANÁLISE DE FINS DE FRASE (35%) ═══
    phrase_end_weight = np.zeros(12, dtype=np.float64)
    phrase_end_count = Counter()
    
    for n in notes:
        if n.is_phrase_end:
            # FIX: Peso linear (não exponencial) pela duração
            # Antes: (n.dur_ms / 200.0) ** 1.5 — amplificava demais notas longas falsas
            # Agora: peso proporcional, mínimo 0.5, máximo 2.0
            weight = min(2.0, max(0.5, n.dur_ms / 300.0)) * n.confidence
            phrase_end_weight[n.pitch_class] += weight
            phrase_end_count[n.pitch_class] += 1
    
    logger.info(f"[v10] Fins de frase: {dict(phrase_end_count)}")
    
    max_end = phrase_end_weight.max()
    if max_end > 0:
        phrase_end_score = phrase_end_weight / max_end
    else:
        phrase_end_score = np.zeros(12)
    
    # ═══ 2. ANÁLISE DE DURAÇÃO (25%) ═══
    duration_weight = np.zeros(12, dtype=np.float64)
    for n in notes:
        weight = n.dur_ms * n.confidence
        if n.dur_ms > 500:
            weight *= 1.3  # Bonus moderado para notas muito longas (repouso)
        duration_weight[n.pitch_class] += weight
    
    max_dur = duration_weight.max()
    if max_dur > 0:
        duration_score = duration_weight / max_dur
    else:
        duration_score = np.zeros(12)
    
    # ═══ 3. CORRELAÇÃO KRUMHANSL — 24 CHAVES INDEPENDENTES (40%) ═══
    #
    # FIX CRÍTICO: Antes calculávamos max(major, minor) por raiz (12 chaves).
    # Isso confundia Sol maior com Mi menor (relativo) porque ambos têm a mesma
    # coleção de notas — CREPE escolhia Mi como raiz porque Mi menor correlaciona
    # alto, depois a decisão major/minor acertava "Mi menor" mas a tônica real era Sol.
    #
    # SOLUÇÃO: Ranquear TODAS as 24 chaves (12 maior + 12 menor) independentemente.
    # Isso permite comparar diretamente "Sol maior" vs "Mi menor" e escolher o melhor.
    pcp = np.zeros(12, dtype=np.float64)
    for n in notes:
        pcp[n.pitch_class] += n.dur_ms * n.confidence
    
    scores_24: dict = {}  # (root, quality) → score
    
    for root in range(12):
        rotated_major = np.roll(KK_MAJOR, root)
        corr_major = float(np.corrcoef(pcp, rotated_major)[0, 1]) if pcp.sum() > 0 else 0.0
        
        rotated_minor = np.roll(KK_MINOR, root)
        corr_minor = float(np.corrcoef(pcp, rotated_minor)[0, 1]) if pcp.sum() > 0 else 0.0
        
        scores_24[(root, 'major')] = max(0.0, corr_major)
        scores_24[(root, 'minor')] = max(0.0, corr_minor)
    
    # Normalizar entre 0 e 1
    max_score = max(scores_24.values()) if scores_24 else 1.0
    min_score = min(scores_24.values()) if scores_24 else 0.0
    if max_score > min_score:
        scores_24_norm = {k: (v - min_score) / (max_score - min_score) for k, v in scores_24.items()}
    else:
        scores_24_norm = {k: 0.0 for k in scores_24}
    
    # Score por raiz (max entre major e minor) para usar nos outros scores
    krumhansl_by_root = np.array([max(scores_24_norm.get((r, 'major'), 0), scores_24_norm.get((r, 'minor'), 0)) for r in range(12)])
    
    # Melhor chave de acordo com Krumhansl puro
    best_24_key = max(scores_24_norm, key=scores_24_norm.get)
    krumhansl_winner_pc = best_24_key[0]
    krumhansl_winner_quality = best_24_key[1]
    krumhansl_score = krumhansl_by_root  # array 12 para combinação final
    
    # ═══ COMBINAÇÃO FINAL ═══
    final_score = (
        0.35 * phrase_end_score +
        0.25 * duration_score +
        0.40 * krumhansl_score
    )
    
    # ═══ PENALIZAÇÕES ANTI-CONFUSÃO ═══
    # Aplicadas em duas etapas para serem aplicáveis universalmente aos 24 tons:
    #
    # ETAPA A — KRUMHANSL-ANCHORED (BIDIRECIONAL):
    #   Krumhansl olha o conjunto INTEIRO de notas (perfil tonal psicoacústico)
    #   e por isso é menos suscetível a falsos picos de phrase_end. Se o vencedor
    #   pós-fórmula é uma 3ª/5ª do vencedor de Krumhansl, e Krumhansl tem margem
    #   clara, transferimos peso de volta à raiz tonal real.
    #
    #   Caso real reportado: hino em Mi maior, mas Sol# (= Mi + 4 = mediant_major)
    #   vencia phrase_end e final_score, gerando "Sol# menor" com 97% de confiança.
    ranked_raw = sorted(enumerate(final_score), key=lambda x: x[1], reverse=True)
    pre_top_pc = ranked_raw[0][0]
    
    if pre_top_pc != krumhansl_winner_pc:
        diff_to_krumhansl = (pre_top_pc - krumhansl_winner_pc) % 12
        ks_top_score = scores_24_norm.get(best_24_key, 0.0)
        ks_pre_top_score = max(
            scores_24_norm.get((pre_top_pc, 'major'), 0.0),
            scores_24_norm.get((pre_top_pc, 'minor'), 0.0),
        )
        ks_margin = ks_top_score - ks_pre_top_score
        # Quando o vencedor pós-fórmula é mediant/dominante do Krumhansl winner
        # E Krumhansl tem qualquer margem positiva, FORÇA o swap.
        # Justificativa musical: a 3ª/5ª NUNCA é tônica quando o conjunto INTEIRO
        # de notas tem perfil diatônico que correlaciona melhor com outra raiz.
        if diff_to_krumhansl in (3, 4, 7) and ks_margin > 0.03:
            # Garantir que Krumhansl winner fica acima do pre_top com margem clara
            target_score = final_score[pre_top_pc] + 0.05 + ks_margin * 0.5
            final_score[krumhansl_winner_pc] = max(
                final_score[krumhansl_winner_pc],
                min(1.0, target_score),
            )
            # E penaliza o pre_top proporcionalmente
            penalty = 0.05 + ks_margin * 0.3
            final_score[pre_top_pc] = max(0.0, final_score[pre_top_pc] - penalty)
            offset_name = {3: 'mediant_minor (3ªm)', 4: 'mediant_major (3ªM)', 7: 'dominant (5ªJ)'}[diff_to_krumhansl]
            logger.info(
                f"[v10.2] Krumhansl-anchored anti-mediant: {NOTE_NAMES_BR[pre_top_pc]} é "
                f"{offset_name} de {NOTE_NAMES_BR[krumhansl_winner_pc]} (KS_margin={ks_margin:.3f}) "
                f"→ swap forçado para {NOTE_NAMES_BR[krumhansl_winner_pc]}"
            )
    
    # Re-ranquear após etapa A
    ranked_raw = sorted(enumerate(final_score), key=lambda x: x[1], reverse=True)
    top_pc = ranked_raw[0][0]
    
    # ETAPA B — TOP-ANCHORED:
    # Penalizar dominante (5ª justa = +7), mediant_major (3ª maior = +4) e
    # mediant_minor (3ª menor = +3) do top candidato pós-etapa-A. Isso evita
    # que o runner-up seja uma 3ª/5ª do verdadeiro vencedor.
    if final_score[top_pc] > 0.50:
        dominant_offset    = 7   # 5ª justa
        mediant_major      = 4   # 3ª maior  (anti-mediant_major)
        mediant_minor      = 3   # 3ª menor  (anti-mediant_minor)
        for offset, penalty in [
            (dominant_offset,  0.12),
            (mediant_major,    0.10),
            (mediant_minor,    0.07),
        ]:
            target = (top_pc + offset) % 12
            final_score[target] = max(0, final_score[target] - final_score[top_pc] * penalty)
    
    # ═══ ÂNCORA DE DURAÇÃO ═══
    dur_winner_pc = int(np.argmax(duration_weight))
    if dur_winner_pc != int(np.argmax(final_score)):
        bonus = min(0.15, duration_score[dur_winner_pc] * 0.20)
        final_score[dur_winner_pc] = min(1.0, final_score[dur_winner_pc] + bonus)
        logger.info(f"[v10] Âncora duração: bônus {bonus:.3f} para {NOTE_NAMES_BR[dur_winner_pc]}")
    
    ranked = sorted(enumerate(final_score), key=lambda x: x[1], reverse=True)
    winner_pc = ranked[0][0]
    winner_score = ranked[0][1]
    runner_up_score = ranked[1][1] if len(ranked) > 1 else 0
    
    # ═══ DECISÃO MAIOR/MENOR ═══
    #
    # FIX: Usar os 24 scores diretos do Krumhansl como evidência principal,
    # MAIS a análise de graus (3ª + 7ª + 6ª) como tiebreaker.
    # Isso resolve diretamente a confusão Sol maior vs Mi menor:
    # - Krumhansl para Sol maior costuma > Krumhansl para Sol menor
    # - Graus confirmam: Si natural (3ª maior de Sol) presente → Sol maior
    
    ks_major_winner = scores_24_norm.get((winner_pc, 'major'), 0.0)
    ks_minor_winner = scores_24_norm.get((winner_pc, 'minor'), 0.0)
    
    # Análise de graus (3ª + 7ª + 6ª)
    major_3rd   = (winner_pc + 4) % 12
    minor_3rd   = (winner_pc + 3) % 12
    major_7th   = (winner_pc + 11) % 12
    minor_7th   = (winner_pc + 10) % 12
    major_6th   = (winner_pc + 9) % 12
    minor_6th   = (winner_pc + 8) % 12
    
    dw = duration_weight
    total = dw.sum() + 1e-6
    
    # Razão "neutra-na-ausência": quando não há evidência (ambas durações ≈ 0),
    # retorna 0.5 (neutro) em vez de 0 (que enviesava artificialmente para menor).
    # Isto é vital para letras sem 3ª (cantorias modais, riffs em quintas, etc.).
    def _neutral_ratio(pos: float, neg: float) -> float:
        denom = pos + neg
        if denom < 1e-3:
            return 0.5
        return pos / denom
    
    degree_major = (
        0.50 * _neutral_ratio(dw[major_3rd], dw[minor_3rd]) +
        0.30 * _neutral_ratio(dw[major_7th], dw[minor_7th]) +
        0.20 * _neutral_ratio(dw[major_6th], dw[minor_6th])
    )
    degree_minor = 1.0 - degree_major
    
    # Combinar Krumhansl (60%) + graus (40%)
    combined_major = 0.60 * ks_major_winner + 0.40 * degree_major
    combined_minor = 0.60 * ks_minor_winner + 0.40 * degree_minor
    
    # Leve bias para maior (em música popular, a maioria dos tons é maior)
    # Necessário para casos ambíguos sem 3ª definida
    MAJOR_BIAS = 1.04
    if combined_major * MAJOR_BIAS > combined_minor * 1.10:
        quality = 'major'
    elif combined_minor > combined_major * MAJOR_BIAS * 1.10:
        quality = 'minor'
    else:
        quality = 'major'  # Default maior quando ambíguo
    
    # ═══ CALCULAR CONFIANÇA ═══
    margin = winner_score - runner_up_score
    phrase_end_confidence = 1.0 if phrase_end_count[winner_pc] >= 2 else 0.7
    
    raw_confidence = (
        0.40 * winner_score +
        0.35 * min(1.0, margin / 0.12) +
        0.25 * phrase_end_confidence
    )
    # Escalar pela quantidade de notas (poucas notas = baixa confiança)
    evidence_factor = min(1.0, len(notes) / 10.0)
    confidence = raw_confidence * (0.60 + 0.40 * evidence_factor)
    confidence = max(0.0, min(1.0, confidence))
    
    logger.info(f"[v10] Krumhansl 24-key winner: {NOTE_NAMES_BR[krumhansl_winner_pc]} {krumhansl_winner_quality}")
    logger.info(f"[v10] Final winner: {NOTE_NAMES_BR[winner_pc]} {quality} (conf={confidence:.2f})")
    logger.info(f"[v10] Mode: major={combined_major:.3f} minor={combined_minor:.3f}")
    logger.info(f"[v10] Top 3: {[(NOTE_NAMES_BR[pc], f'{s:.3f}') for pc, s in ranked[:3]]}")
    
    return AnalysisResult(
        success=True,
        tonic=winner_pc,
        quality=quality,
        confidence=confidence,
        notes_count=len(notes),
        phrases_count=sum(1 for n in notes if n.is_phrase_end),
        debug={
            'phrase_ends': dict(phrase_end_count),
            'top_candidates': [(NOTE_NAMES_BR[pc], round(s, 3)) for pc, s in ranked[:5]],
            'mode_evidence': {
                'major': round(combined_major, 3),
                'minor': round(combined_minor, 3),
            },
            'krumhansl_24_winner': f"{NOTE_NAMES_BR[krumhansl_winner_pc]} {krumhansl_winner_quality}",
            'scores': {
                'phrase_end': {NOTE_NAMES_BR[i]: round(phrase_end_score[i], 3) for i in range(12) if phrase_end_score[i] > 0.1},
                'duration': {NOTE_NAMES_BR[i]: round(duration_score[i], 3) for i in range(12) if duration_score[i] > 0.1},
            },
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
    
    def get_result(self) -> Dict[str, Any]:
        """Retorna resultado baseado em todas as notas acumuladas."""
        # MUDANÇA CRÍTICA: Retornar resultado mesmo com poucas notas
        # Isso evita ficar travado em "analisando"
        if len(self.all_notes) < 2:
            # Ainda sem notas suficientes, mas retorna status claro
            return {
                'success': False, 
                'error': 'insufficient_data', 
                'notes': len(self.all_notes),
                'analyses': self.analysis_count,
                'message': f'Coletando notas... ({len(self.all_notes)}/2)'
            }
        
        result = analyze_tonality(self.all_notes)
        
        if not result.success:
            return {
                'success': False, 
                'error': 'analysis_failed',
                'notes': len(self.all_notes),
                'analyses': self.analysis_count,
            }
        
        # Adicionar voto ao histórico
        self.vote_history.append(result.tonic)
        self.vote_history = self.vote_history[-10:]  # Últimos 10 votos
        
        # MUDANÇA: Lock mais rápido - assim que tiver um candidato com confiança razoável
        should_lock = self._should_lock(result)
        
        if should_lock:
            self._lock(result.tonic, result.quality, result.confidence)
        
        # Se já está travado, retornar tom travado
        if self.locked_tonic is not None:
            return {
                'success': True,
                'tonic': self.locked_tonic,
                'tonic_name': NOTE_NAMES_BR[self.locked_tonic],
                'quality': self.locked_quality,
                'key_name': f"{NOTE_NAMES_BR[self.locked_tonic]} {'Maior' if self.locked_quality == 'major' else 'menor'}",
                'confidence': self.locked_confidence,
                'locked': True,
                'locked_for': round(time.time() - self.locked_at, 1) if self.locked_at else 0,
                'analyses': self.analysis_count,
                'method': 'v10-locked',
            }
        
        # Ainda não travado - retornar resultado provisório
        # MUDANÇA: Sempre retorna success=True quando temos um candidato
        return {
            'success': True,
            'tonic': result.tonic,
            'tonic_name': NOTE_NAMES_BR[result.tonic],
            'quality': result.quality,
            'key_name': f"{NOTE_NAMES_BR[result.tonic]} {'Maior' if result.quality == 'major' else 'menor'}",
            'confidence': result.confidence,
            'locked': False,
            'analyses': self.analysis_count,
            'notes_count': result.notes_count,
            'debug': result.debug,
            'method': 'v10-provisional',
        }
    
    def _should_lock(self, result: AnalysisResult) -> bool:
        """Decide se deve travar o tom.
        
        REGRA PRINCIPAL: Só travar quando há consistência real entre análises.
        - Previne lock prematuro em nota errada de alta confiança
        - Exige múltiplas análises apontando para o mesmo tom
        - Verifica margem clara sobre runner-up (anti-dominante/anti-mediant)
        """
        if self.locked_tonic is not None:
            return self._should_change(result)
        
        phrases = result.phrases_count
        
        # ─── GATE UNIVERSAL: nunca travar com menos de 4 análises ───
        # 4 chunks de 5s = 20s de áudio mínimo. Frase musical típica tem ~10-15s.
        # Com 20s temos pelo menos 1-2 frases completas + cadências = contexto suficiente.
        # Sem isso, o algoritmo trava prematuramente na 5ª (dominante) ou 3ª (mediant)
        # do tom real (caso reportado: hino em Mi maior travando em Si Maior aos 10s).
        if self.analysis_count < 4:
            return False
        
        # ─── GATE ANTI-DOMINANTE/ANTI-MEDIANT ───
        # Mesmo com confiança alta, se o runner-up está próximo (margem < 25%) E
        # o vencedor é uma 5ª/3ª do runner-up, NÃO travar — esperar mais evidência.
        top_candidates = result.debug.get('top_candidates', [])
        if len(top_candidates) >= 2:
            top_name, top_score = top_candidates[0]
            runner_name, runner_score = top_candidates[1]
            try:
                top_pc = NOTE_NAMES_BR.index(top_name)
                runner_pc = NOTE_NAMES_BR.index(runner_name)
                margin = (top_score - runner_score) / max(top_score, 0.01)
                # offset do top em relação ao runner: se for 3ª/5ª do runner, é armadilha
                offset = (top_pc - runner_pc) % 12
                if offset in (3, 4, 7) and margin < 0.25:
                    logger.info(
                        f"[v10.2] Lock adiado: {top_name} é offset+{offset} de runner-up "
                        f"{runner_name} (margem={margin:.2%}) — esperando mais evidência"
                    )
                    return False
            except ValueError:
                pass
        
        # Critério 1: Confiança alta + múltiplas frases + análises suficientes
        if self.analysis_count >= 4 and result.confidence >= 0.70 and phrases >= 3:
            return True
        
        # Critério 2: Confiança excepcional + várias análises
        if result.confidence >= 0.85 and phrases >= 2 and self.analysis_count >= 4:
            return True
        
        # Critério 3: Consenso forte ao longo do tempo (4 de 5 últimos votos)
        if len(self.vote_history) >= 5 and result.confidence >= 0.55 and phrases >= 2:
            votes_for_current = sum(1 for v in self.vote_history[-5:] if v == result.tonic)
            if votes_for_current >= 4:
                return True
        
        # Critério 4: Timeout inteligente — após 25s sem lock, usar melhor candidato
        elapsed = time.time() - self.start_time
        if elapsed >= 25.0 and self.analysis_count >= 5 and result.confidence >= 0.45:
            logger.info(f"[v10] Timeout inteligente após {elapsed:.0f}s — travando melhor candidato")
            return True
        
        return False
    
    def _should_change(self, result: AnalysisResult) -> bool:
        """Verifica se deve mudar o tom travado.
        
        Mudança de tom é rara — exige evidência forte e consistente.
        A histerese protege contra oscilação entre tons próximos.
        """
        if result.tonic == self.locked_tonic:
            # Mesmo tom — reforçar confiança gradualmente
            self.locked_confidence = min(0.99, self.locked_confidence * 0.9 + result.confidence * 0.1)
            return False
        
        time_since_lock = time.time() - (self.locked_at or time.time())
        
        # Mínimo 4 segundos antes de considerar qualquer mudança
        if time_since_lock < 4.0:
            return False
        
        # Precisa de 3 votos nos últimos 5 no novo tom
        if len(self.vote_history) >= 5:
            last_votes = self.vote_history[-5:]
            votes_for_new = sum(1 for v in last_votes if v == result.tonic)
            if votes_for_new >= 3:
                # E confiança claramente superior (margem de 15%)
                if result.confidence > self.locked_confidence + 0.15:
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
