"""
key_detection_v9.py — CORREÇÃO CRÍTICA: Detecção Rápida e Precisa
═══════════════════════════════════════════════════════════════════════════════

PROBLEMAS RESOLVIDOS:
1. Demora excessiva (>1 minuto) → Agora: 10-30 segundos
2. Confusão V↔I (G# detectado ao invés de C#) → Correção na análise de cadências
3. Peso excessivo para notas dominantes → Penalização de quintas falsas

MUDANÇAS PRINCIPAIS:
- Cadências: Verificação de CONTEXTO (não apenas intervalo isolado)
- Gravidade: Peso MUITO maior para notas de repouso (fins de frase)
- Anti-dominante: Penaliza candidatos que são a 5ª de outro candidato forte
- Thresholds mais agressivos para lock rápido
- Decay mais rápido no acumulador
"""

from __future__ import annotations

import tempfile
from pathlib import Path
from typing import List, Dict, Any, Optional, Tuple
from dataclasses import dataclass, field
from enum import Enum
import time
import logging

import numpy as np
import librosa
import torch
import torchcrepe

logger = logging.getLogger(__name__)

# ═══════════════════════════════════════════════════════════════════════════════
# CONSTANTES MUSICAIS
# ═══════════════════════════════════════════════════════════════════════════════

NOTE_NAMES_BR = ['Dó', 'Dó#', 'Ré', 'Ré#', 'Mi', 'Fá', 'Fá#', 'Sol', 'Sol#', 'Lá', 'Lá#', 'Si']

# Perfis Aarden-Essen (otimizados para música vocal monofônica)
AARDEN_MAJOR = np.array([
    17.7661, 0.145624, 14.9265, 0.160186, 19.8049,
    11.3587, 0.291248, 22.062,  0.145624, 8.15494,
    0.232998, 4.95122,
])
AARDEN_MINOR = np.array([
    18.2648, 0.737619, 14.0499, 16.8599, 0.702494,
    14.4362, 0.702494, 18.6161, 4.56621, 1.93186,
    7.37619, 1.75623,
])

# ═══════════════════════════════════════════════════════════════════════════════
# PARÂMETROS DE ÁUDIO
# ═══════════════════════════════════════════════════════════════════════════════

SAMPLE_RATE = 16000
HOP_MS = 10
HOP_LENGTH = int(SAMPLE_RATE * HOP_MS / 1000)
MODEL_CAPACITY = 'tiny'
F0_MIN = 65.0
F0_MAX = 1000.0
CONFIDENCE_THRESHOLD = 0.35  # REDUZIDO de 0.50 para captar mais frames
MIN_NOTE_DUR_MS = 50  # REDUZIDO de 80 para captar notas mais curtas

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
    rms_conf: float

@dataclass
class Phrase:
    notes: List[Note]
    start_ms: float
    end_ms: float
    
    @property
    def duration_ms(self) -> float:
        return self.end_ms - self.start_ms
    
    @property
    def last_note(self) -> Optional[Note]:
        return self.notes[-1] if self.notes else None

class CadenceType(Enum):
    AUTHENTIC = "V→I"
    PLAGAL = "IV→I"
    CYCLE = "II→V→I"

@dataclass
class CadenceEvidence:
    cadence_type: CadenceType
    resolved_to_pc: int
    strength: float
    phrase_index: int

# ═══════════════════════════════════════════════════════════════════════════════
# FUNÇÕES DE ÁUDIO
# ═══════════════════════════════════════════════════════════════════════════════

def load_audio_from_bytes(audio_bytes: bytes, target_sr: int = SAMPLE_RATE) -> np.ndarray:
    with tempfile.NamedTemporaryFile(suffix='.audio', delete=True) as tmp:
        tmp.write(audio_bytes)
        tmp.flush()
        y, sr = librosa.load(tmp.name, sr=target_sr, mono=True)
    max_abs = float(np.max(np.abs(y)) or 1.0)
    if max_abs > 0:
        y = y / max_abs * 0.95
    return y.astype(np.float32)


def extract_f0_with_crepe(audio: np.ndarray, sr: int = SAMPLE_RATE) -> Tuple[np.ndarray, np.ndarray]:
    audio_t = torch.from_numpy(audio).unsqueeze(0).to(DEVICE)
    pitch, confidence = torchcrepe.predict(
        audio_t, sr, HOP_LENGTH, F0_MIN, F0_MAX, MODEL_CAPACITY,
        batch_size=512, device=DEVICE, return_periodicity=True,
    )
    # Filtros de suavização mais fortes
    confidence = torchcrepe.filter.median(confidence, 5)  # Aumentado de 3 para 5
    pitch = torchcrepe.filter.mean(pitch, 5)  # Aumentado de 3 para 5
    pitch_np = pitch[0].cpu().numpy()
    conf_np = confidence[0].cpu().numpy()
    pitch_np = np.where(conf_np >= CONFIDENCE_THRESHOLD, pitch_np, np.nan)
    return pitch_np, conf_np


def f0_to_midi(f0: np.ndarray) -> np.ndarray:
    with np.errstate(divide='ignore', invalid='ignore'):
        midi = 69.0 + 12.0 * np.log2(f0 / 440.0)
    return midi


def segment_notes(midi: np.ndarray, conf: np.ndarray, hop_ms: float = HOP_MS) -> List[Note]:
    """Segmenta MIDI em notas, com tolerância para gaps curtos."""
    notes: List[Note] = []
    current_pc: Optional[int] = None
    current_midi_sum = 0.0
    current_conf_sum = 0.0
    current_frames = 0
    start_frame = 0
    gap_frames = 0  # Contador de gaps
    MAX_GAP_FRAMES = 3  # Tolerância de 30ms de gap

    def flush(end_frame: int):
        nonlocal current_pc, current_midi_sum, current_conf_sum, current_frames, gap_frames
        if current_pc is None or current_frames == 0:
            return
        dur_ms = current_frames * hop_ms
        if dur_ms >= MIN_NOTE_DUR_MS:
            notes.append(Note(
                pitch_class=current_pc,
                midi=round(current_midi_sum / current_frames, 2),
                dur_ms=round(dur_ms, 1),
                start_ms=round(start_frame * hop_ms, 1),
                rms_conf=round(current_conf_sum / current_frames, 3),
            ))
        current_pc = None
        current_midi_sum = 0.0
        current_conf_sum = 0.0
        current_frames = 0
        gap_frames = 0

    for i, m in enumerate(midi):
        if np.isnan(m):
            gap_frames += 1
            # Se gap for muito longo, flush a nota atual
            if gap_frames > MAX_GAP_FRAMES:
                flush(i)
            continue
        
        pc = int(round(m)) % 12
        
        if current_pc is None:
            # Início de nova nota
            current_pc = pc
            start_frame = i
            current_midi_sum = float(m)
            current_conf_sum = float(conf[i])
            current_frames = 1
            gap_frames = 0
        elif pc == current_pc:
            # Mesma nota - incluir os frames de gap se houver
            current_midi_sum += float(m)
            current_conf_sum += float(conf[i])
            current_frames += 1 + gap_frames  # Incluir gap como parte da nota
            gap_frames = 0
        else:
            # Nova nota diferente
            flush(i)
            current_pc = pc
            start_frame = i
            current_midi_sum = float(m)
            current_conf_sum = float(conf[i])
            current_frames = 1
            gap_frames = 0
    
    flush(len(midi))
    return notes


def detect_phrases(notes: List[Note], silence_gap_ms: float = 350.0) -> List[Phrase]:
    """Agrupa notas em frases. Gap reduzido para captar mais frases."""
    phrases: List[Phrase] = []
    current_notes: List[Note] = []
    phrase_start = 0.0
    last_end = -1.0
    
    for n in notes:
        start = n.start_ms
        if current_notes and (start - last_end) >= silence_gap_ms:
            phrases.append(Phrase(notes=current_notes, start_ms=phrase_start, end_ms=last_end))
            current_notes = []
            phrase_start = start
        if not current_notes:
            phrase_start = start
        current_notes.append(n)
        last_end = start + n.dur_ms
    
    if current_notes:
        phrases.append(Phrase(notes=current_notes, start_ms=phrase_start, end_ms=last_end))
    return phrases


def compute_pcp(notes: List[Note]) -> np.ndarray:
    pcp = np.zeros(12, dtype=np.float64)
    for n in notes:
        pcp[n.pitch_class] += n.dur_ms * n.rms_conf
    return pcp


# ═══════════════════════════════════════════════════════════════════════════════
# JURADO 1: KRUMHANSL (25%) — REDUZIDO
# ═══════════════════════════════════════════════════════════════════════════════

def _pearson(x: np.ndarray, y: np.ndarray) -> float:
    if len(x) != len(y) or len(x) == 0:
        return 0.0
    mx, my = np.mean(x), np.mean(y)
    dx, dy = x - mx, y - my
    num = float(np.sum(dx * dy))
    den = float(np.sqrt(np.sum(dx ** 2) * np.sum(dy ** 2)))
    return num / den if den > 1e-10 else 0.0


def juror_krumhansl(pcp: np.ndarray) -> Dict[int, float]:
    """Correlação Krumhansl com bias para maior."""
    if pcp.sum() < 50:
        return {i: 0.0 for i in range(12)}
    
    scores = {}
    MAJOR_BIAS = 1.15  # Bias para tom maior
    
    for root in range(12):
        rotated_maj = np.roll(AARDEN_MAJOR, root)
        rotated_min = np.roll(AARDEN_MINOR, root)
        
        corr_maj = _pearson(pcp, rotated_maj)
        corr_min = _pearson(pcp, rotated_min)
        
        score_maj = max(0.0, (corr_maj + 1.0) / 2.0) * MAJOR_BIAS
        score_min = max(0.0, (corr_min + 1.0) / 2.0)
        
        scores[root] = max(score_maj, score_min)
    
    max_score = max(scores.values()) or 1.0
    return {k: v / max_score for k, v in scores.items()}


# ═══════════════════════════════════════════════════════════════════════════════
# JURADO 2: CADÊNCIAS (30%) — COM CORREÇÃO V↔I
# ═══════════════════════════════════════════════════════════════════════════════

def _interval(from_pc: int, to_pc: int) -> int:
    return (to_pc - from_pc + 12) % 12


def detect_cadences_v9(phrases: List[Phrase], pcp: np.ndarray) -> List[CadenceEvidence]:
    """
    CORREÇÃO CRÍTICA: Detecta cadências com CONTEXTO.
    
    Problema original: Se canto C# → G#, o sistema via como "V→I para G#"
    mas na verdade é "I→V para C#".
    
    Solução: Verificar se a nota de resolução tem MAIS peso no PCP
    do que a nota de partida. A tônica real tem mais presença.
    """
    cadences: List[CadenceEvidence] = []
    
    for idx, phrase in enumerate(phrases):
        if len(phrase.notes) < 2:
            continue
        
        notes = phrase.notes
        last = notes[-1]
        second_last = notes[-2]
        
        interval = _interval(second_last.pitch_class, last.pitch_class)
        
        # Pesos das notas no PCP (presença geral)
        last_weight = pcp[last.pitch_class]
        second_last_weight = pcp[second_last.pitch_class]
        
        # ═══ CADÊNCIA AUTÊNTICA (V→I) ═══
        # Intervalo de 5 semitons para cima = queda de 5ª
        if interval == 5:
            # VERIFICAÇÃO CRUCIAL: A nota final deve ter MAIS peso que a inicial
            # Se a inicial tem mais peso, provavelmente é I→V (não V→I)
            if last_weight >= second_last_weight * 0.7:
                # Provavelmente é V→I real
                strength = min(1.0, last.dur_ms / 250.0) * last.rms_conf
                # Bonus se nota final é longa (indica repouso)
                if last.dur_ms >= 300:
                    strength *= 1.3
                cadences.append(CadenceEvidence(
                    cadence_type=CadenceType.AUTHENTIC,
                    resolved_to_pc=last.pitch_class,
                    strength=strength,
                    phrase_index=idx,
                ))
            # Se a inicial tem MUITO mais peso, é I→V
            # Nesse caso, a INICIAL é provavelmente a tônica
            elif second_last_weight > last_weight * 1.5:
                strength = min(1.0, second_last.dur_ms / 300.0) * 0.5
                cadences.append(CadenceEvidence(
                    cadence_type=CadenceType.AUTHENTIC,
                    resolved_to_pc=second_last.pitch_class,  # A INICIAL!
                    strength=strength,
                    phrase_index=idx,
                ))
        
        # ═══ CADÊNCIA PLAGAL (IV→I) ═══
        elif interval == 7:
            if last_weight >= second_last_weight * 0.6:
                strength = min(1.0, last.dur_ms / 300.0) * last.rms_conf * 0.7
                cadences.append(CadenceEvidence(
                    cadence_type=CadenceType.PLAGAL,
                    resolved_to_pc=last.pitch_class,
                    strength=strength,
                    phrase_index=idx,
                ))
        
        # ═══ CICLO II→V→I ═══
        if len(notes) >= 3:
            third_last = notes[-3]
            int1 = _interval(third_last.pitch_class, second_last.pitch_class)
            int2 = _interval(second_last.pitch_class, last.pitch_class)
            
            if int1 == 5 and int2 == 5:
                if last_weight >= second_last_weight * 0.5:
                    strength = min(1.0, last.dur_ms / 250.0) * last.rms_conf * 1.2
                    cadences.append(CadenceEvidence(
                        cadence_type=CadenceType.CYCLE,
                        resolved_to_pc=last.pitch_class,
                        strength=strength,
                        phrase_index=idx,
                    ))
    
    return cadences


def juror_cadences_v9(phrases: List[Phrase], notes: List[Note], pcp: np.ndarray) -> Dict[int, float]:
    """Análise de cadências com correção V↔I."""
    scores = {i: 0.0 for i in range(12)}
    
    cadences = detect_cadences_v9(phrases, pcp)
    
    if not cadences:
        # Sem cadências: usar fins de frase como proxy
        for phrase in phrases:
            if phrase.last_note:
                pc = phrase.last_note.pitch_class
                dur_factor = min(1.0, phrase.last_note.dur_ms / 350.0)
                scores[pc] += 0.4 * dur_factor * phrase.last_note.rms_conf
    else:
        for cad in cadences:
            pc = cad.resolved_to_pc
            scores[pc] += cad.strength
    
    max_s = max(scores.values()) or 1.0
    return {k: v / max_s for k, v in scores.items()}


# ═══════════════════════════════════════════════════════════════════════════════
# JURADO 3: GRAVIDADE (45%) — MUITO MAIS PESO
# ═══════════════════════════════════════════════════════════════════════════════

def juror_gravity_v9(notes: List[Note], phrases: List[Phrase], pcp: np.ndarray) -> Dict[int, float]:
    """
    Centro gravitacional com MUITO mais peso para:
    1. Fins de frase (a tônica é onde as frases terminam)
    2. Notas longas (repouso)
    3. Primeira nota de frases (entrada no tom)
    
    CORREÇÃO: Penaliza notas que são a 5ª de outra nota forte
    """
    scores = np.zeros(12, dtype=np.float64)
    
    # ═══ 1. FINS DE FRASE (40%) — O MAIS IMPORTANTE ═══
    phrase_end_weight = np.zeros(12, dtype=np.float64)
    for phrase in phrases:
        if phrase.last_note:
            pc = phrase.last_note.pitch_class
            # Peso exponencial para notas finais longas
            dur_factor = (phrase.last_note.dur_ms / 200.0) ** 1.2
            dur_factor = min(3.0, dur_factor)  # Cap
            phrase_end_weight[pc] += dur_factor * phrase.last_note.rms_conf * 2.0
    
    if phrase_end_weight.max() > 0:
        end_norm = phrase_end_weight / phrase_end_weight.max()
        scores += end_norm * 0.40
    
    # ═══ 2. NOTAS DE REPOUSO (30%) ═══
    rest_weight = np.zeros(12, dtype=np.float64)
    for n in notes:
        if n.dur_ms >= 250:  # Nota longa = repouso
            dur_factor = (n.dur_ms / 250.0) ** 1.3
            rest_weight[n.pitch_class] += dur_factor * n.rms_conf
    
    if rest_weight.max() > 0:
        rest_norm = rest_weight / rest_weight.max()
        scores += rest_norm * 0.30
    
    # ═══ 3. INÍCIO DE FRASES (15%) ═══
    phrase_start_weight = np.zeros(12, dtype=np.float64)
    for phrase in phrases:
        if phrase.notes:
            first = phrase.notes[0]
            dur_factor = min(1.5, first.dur_ms / 200.0)
            phrase_start_weight[first.pitch_class] += dur_factor * first.rms_conf
    
    if phrase_start_weight.max() > 0:
        start_norm = phrase_start_weight / phrase_start_weight.max()
        scores += start_norm * 0.15
    
    # ═══ 4. DURAÇÃO TOTAL (15%) — Reduzido ═══
    pcp_norm = pcp / (pcp.max() or 1.0)
    scores += pcp_norm * 0.15
    
    # ═══ PENALIZAÇÃO ANTI-DOMINANTE ═══
    # Se uma nota X tem score alto, penalizar a nota que está 7 semitons acima (a 5ª de X)
    # Porque a 5ª (dominante) é frequente mas NÃO é a tônica
    penalty = np.zeros(12, dtype=np.float64)
    for pc in range(12):
        if scores[pc] > 0.5:  # Só para candidatos fortes
            fifth_pc = (pc + 7) % 12  # A 5ª deste PC
            penalty[fifth_pc] += scores[pc] * 0.25  # Penaliza a 5ª
    
    scores = scores - penalty
    scores = np.maximum(0, scores)  # Não deixa negativo
    
    max_s = scores.max() or 1.0
    return {i: float(scores[i] / max_s) for i in range(12)}


# ═══════════════════════════════════════════════════════════════════════════════
# DECISÃO DE MODO (MAIOR vs MENOR)
# ═══════════════════════════════════════════════════════════════════════════════

def decide_mode_v9(tonic_pc: int, pcp: np.ndarray) -> Tuple[str, float, Dict[str, Any]]:
    """Decide modo com bias forte para maior."""
    maj_3rd_pc = (tonic_pc + 4) % 12
    min_3rd_pc = (tonic_pc + 3) % 12
    
    maj_3rd_weight = float(pcp[maj_3rd_pc])
    min_3rd_weight = float(pcp[min_3rd_pc])
    
    evidence = {
        'major_3rd_weight': round(maj_3rd_weight, 2),
        'minor_3rd_weight': round(min_3rd_weight, 2),
    }
    
    MIN_WEIGHT = 20.0
    maj_present = maj_3rd_weight > MIN_WEIGHT
    min_present = min_3rd_weight > MIN_WEIGHT
    
    if maj_present and not min_present:
        return 'major', 0.95, evidence
    
    if min_present and not maj_present:
        return 'minor', 0.85, evidence
    
    if maj_present and min_present:
        total = maj_3rd_weight + min_3rd_weight
        ratio = maj_3rd_weight / total
        if ratio >= 0.45:  # Bias para maior
            return 'major', 0.70, evidence
        else:
            return 'minor', 0.65, evidence
    
    return 'major', 0.50, evidence


# ═══════════════════════════════════════════════════════════════════════════════
# TRIBUNAL v9 — MAIS RÁPIDO E PRECISO
# ═══════════════════════════════════════════════════════════════════════════════

WEIGHT_KRUMHANSL = 0.25  # REDUZIDO de 0.30
WEIGHT_CADENCES = 0.30   # REDUZIDO de 0.35
WEIGHT_GRAVITY = 0.45    # AUMENTADO de 0.35


def tribunal_decide_v9(notes: List[Note], phrases: List[Phrase], pcp: np.ndarray) -> Dict[str, Any]:
    """Tribunal v9 com correções para detecção rápida e precisa."""
    if not notes:
        return {'success': False, 'error': 'no_notes'}
    
    if pcp.sum() < 50:
        return {'success': False, 'error': 'insufficient_audio'}
    
    # Votos dos jurados
    ks_votes = juror_krumhansl(pcp)
    cad_votes = juror_cadences_v9(phrases, notes, pcp)
    grav_votes = juror_gravity_v9(notes, phrases, pcp)
    
    # Combinação
    combined = {}
    for pc in range(12):
        combined[pc] = (
            WEIGHT_KRUMHANSL * ks_votes[pc] +
            WEIGHT_CADENCES * cad_votes[pc] +
            WEIGHT_GRAVITY * grav_votes[pc]
        )
    
    # ═══ PENALIZAÇÃO FINAL ANTI-DOMINANTE ═══
    # Se dois candidatos estão separados por 5ª, o que tem mais fins de frase vence
    ranked = sorted(combined.items(), key=lambda x: x[1], reverse=True)
    
    if len(ranked) >= 2:
        first_pc, first_score = ranked[0]
        second_pc, second_score = ranked[1]
        
        # Verificar se são separados por 5ª justa (7 semitons)
        interval = abs(first_pc - second_pc)
        if interval == 7 or interval == 5:  # 5ª ou 4ª
            # Qual tem mais fins de frase?
            first_ends = sum(1 for p in phrases if p.last_note and p.last_note.pitch_class == first_pc)
            second_ends = sum(1 for p in phrases if p.last_note and p.last_note.pitch_class == second_pc)
            
            # Se o segundo tem MAIS fins de frase, ele é provavelmente a tônica real
            if second_ends > first_ends and second_score > first_score * 0.7:
                # Trocar!
                combined[first_pc] *= 0.8
                combined[second_pc] *= 1.2
                logger.info(f"[v9] Anti-dominante: trocando {NOTE_NAMES_BR[first_pc]} por {NOTE_NAMES_BR[second_pc]} (fins de frase: {first_ends} vs {second_ends})")
    
    # Re-ordenar após penalização
    ranked = sorted(combined.items(), key=lambda x: x[1], reverse=True)
    winner_pc = ranked[0][0]
    winner_score = ranked[0][1]
    runner_up_score = ranked[1][1] if len(ranked) > 1 else 0.0
    
    # Decidir modo
    quality, mode_conf, third_evidence = decide_mode_v9(winner_pc, pcp)
    
    # Confidence
    margin = winner_score - runner_up_score
    confidence = 0.50 * winner_score + 0.30 * min(1.0, margin / 0.12) + 0.20 * mode_conf
    confidence = max(0.0, min(1.0, confidence))
    
    cadences = detect_cadences_v9(phrases, pcp)
    
    return {
        'success': True,
        'tonic': winner_pc,
        'tonic_name': NOTE_NAMES_BR[winner_pc],
        'quality': quality,
        'key_name': f"{NOTE_NAMES_BR[winner_pc]} {'Maior' if quality == 'major' else 'menor'}",
        'confidence': round(confidence, 3),
        'votes': {
            'krumhansl': {NOTE_NAMES_BR[i]: round(ks_votes[i], 3) for i in range(12)},
            'cadences': {NOTE_NAMES_BR[i]: round(cad_votes[i], 3) for i in range(12)},
            'gravity': {NOTE_NAMES_BR[i]: round(grav_votes[i], 3) for i in range(12)},
        },
        'top_candidates': [
            {'pc': pc, 'name': NOTE_NAMES_BR[pc], 'score': round(combined[pc], 4)}
            for pc, _ in ranked[:5]
        ],
        'cadences_found': [
            {'type': c.cadence_type.value, 'to': NOTE_NAMES_BR[c.resolved_to_pc], 'str': round(c.strength, 2)}
            for c in cadences
        ],
        'stats': {'notes': len(notes), 'phrases': len(phrases)},
        'method': 'tribunal-v9',
    }


# ═══════════════════════════════════════════════════════════════════════════════
# ACUMULADOR v9 — MAIS RÁPIDO
# ═══════════════════════════════════════════════════════════════════════════════

class SessionAccumulatorV9:
    """Acumulador com decay mais rápido e lock mais agressivo."""
    
    def __init__(self, decay: float = 0.92):  # Decay MUITO mais rápido (era 0.995)
        self.pcp = np.zeros(12, dtype=np.float64)
        self.notes: List[Note] = []
        self.phrases: List[Phrase] = []
        self.decay = decay
        self.last_update = time.time()
        self.analysis_count = 0
        
        self.decision_history: List[Dict[str, Any]] = []
        self.locked_tonic: Optional[int] = None
        self.locked_quality: Optional[str] = None
        self.locked_at: Optional[float] = None
        self.locked_confidence: float = 0.0
    
    def apply_decay(self):
        now = time.time()
        elapsed = now - self.last_update
        decay_factor = self.decay ** elapsed
        self.pcp *= decay_factor
        self.last_update = now
    
    def add_analysis(self, notes: List[Note], phrases: List[Phrase], pcp: np.ndarray):
        self.apply_decay()
        self.pcp += pcp * 0.6  # Peso maior para análises novas
        self.notes = (self.notes + notes)[-40:]  # Menos histórico
        self.phrases = (self.phrases + phrases)[-8:]
        self.analysis_count += 1
    
    def get_accumulated_result(self) -> Dict[str, Any]:
        if self.pcp.sum() < 30:  # Threshold mais baixo
            return {'success': False, 'error': 'insufficient'}
        return tribunal_decide_v9(self.notes, self.phrases, self.pcp)
    
    def should_update_lock(self, new_result: Dict[str, Any]) -> bool:
        if not new_result.get('success'):
            return False
        
        new_tonic = new_result['tonic']
        new_quality = new_result['quality']
        new_conf = new_result['confidence']
        
        # LOCK INICIAL MAIS RÁPIDO
        if self.locked_tonic is None:
            if new_conf >= 0.25:  # ERA 0.35
                self._lock(new_tonic, new_quality, new_conf)
                return True
            return False
        
        # Mesmo tom: reforçar
        if new_tonic == self.locked_tonic and new_quality == self.locked_quality:
            self.locked_confidence = max(self.locked_confidence, new_conf)
            return False
        
        # Tom diferente: histerese
        self.decision_history.append({
            'tonic': new_tonic, 'quality': new_quality, 
            'conf': new_conf, 'time': time.time()
        })
        self.decision_history = self.decision_history[-8:]
        
        consecutive = 0
        for d in reversed(self.decision_history):
            if d['tonic'] == new_tonic and d['quality'] == new_quality:
                consecutive += 1
            else:
                break
        
        time_since_lock = time.time() - (self.locked_at or time.time())
        margin = new_conf - self.locked_confidence
        
        # Condições para troca (mais fáceis)
        if consecutive >= 3 and margin >= 0.05 and time_since_lock >= 2.5:
            self._lock(new_tonic, new_quality, new_conf)
            return True
        
        if consecutive >= 5 and new_conf >= 0.40:
            self._lock(new_tonic, new_quality, new_conf)
            return True
        
        return False
    
    def _lock(self, tonic: int, quality: str, confidence: float):
        logger.info(f"[v9] 🔒 LOCK: {NOTE_NAMES_BR[tonic]} {'Maior' if quality == 'major' else 'menor'} (conf={confidence:.2f})")
        self.locked_tonic = tonic
        self.locked_quality = quality
        self.locked_confidence = confidence
        self.locked_at = time.time()
        self.decision_history.clear()
    
    def get_locked_result(self) -> Optional[Dict[str, Any]]:
        if self.locked_tonic is None:
            return None
        return {
            'tonic': self.locked_tonic,
            'tonic_name': NOTE_NAMES_BR[self.locked_tonic],
            'quality': self.locked_quality,
            'key_name': f"{NOTE_NAMES_BR[self.locked_tonic]} {'Maior' if self.locked_quality == 'major' else 'menor'}",
            'confidence': self.locked_confidence,
            'locked_for': round(time.time() - (self.locked_at or time.time()), 1),
        }
    
    def reset(self):
        self.pcp = np.zeros(12, dtype=np.float64)
        self.notes = []
        self.phrases = []
        self.last_update = time.time()
        self.analysis_count = 0
        self.decision_history = []
        self.locked_tonic = None
        self.locked_quality = None
        self.locked_at = None
        self.locked_confidence = 0.0


_session_accumulators_v9: Dict[str, SessionAccumulatorV9] = {}


def get_session_accumulator_v9(device_id: str) -> SessionAccumulatorV9:
    if device_id not in _session_accumulators_v9:
        _session_accumulators_v9[device_id] = SessionAccumulatorV9()
    return _session_accumulators_v9[device_id]


def reset_session_v9(device_id: str):
    if device_id in _session_accumulators_v9:
        _session_accumulators_v9[device_id].reset()


# ═══════════════════════════════════════════════════════════════════════════════
# FUNÇÃO PÚBLICA PRINCIPAL
# ═══════════════════════════════════════════════════════════════════════════════

def analyze_audio_bytes_v9(
    audio_bytes: bytes,
    device_id: str = 'anon',
    use_accumulator: bool = True,
) -> Dict[str, Any]:
    """Análise v9 — Rápida e Precisa."""
    audio = load_audio_from_bytes(audio_bytes)
    duration_s = len(audio) / SAMPLE_RATE
    
    if duration_s < 0.8:
        return {'success': False, 'error': 'too_short', 'duration_s': duration_s}
    
    f0, conf = extract_f0_with_crepe(audio)
    valid_f0 = int(np.sum(~np.isnan(f0)))
    
    if valid_f0 < 10:
        return {'success': False, 'error': 'no_pitch', 'valid_f0': valid_f0}
    
    midi = f0_to_midi(f0)
    notes = segment_notes(midi, conf)
    phrases = detect_phrases(notes)
    pcp = compute_pcp(notes)
    
    clip_result = tribunal_decide_v9(notes, phrases, pcp)
    
    if use_accumulator:
        acc = get_session_accumulator_v9(device_id)
        acc.add_analysis(notes, phrases, pcp)
        acc_result = acc.get_accumulated_result()
        
        if acc_result.get('success'):
            acc.should_update_lock(acc_result)
            locked = acc.get_locked_result()
            
            if locked:
                return {
                    'success': True,
                    'tonic': locked['tonic'],
                    'tonic_name': locked['tonic_name'],
                    'quality': locked['quality'],
                    'key_name': locked['key_name'],
                    'confidence': locked['confidence'],
                    'locked': True,
                    'locked_for': locked['locked_for'],
                    'clip_result': clip_result,
                    'analyses': acc.analysis_count,
                    'method': 'tribunal-v9-acc',
                    'duration_s': round(duration_s, 2),
                }
    
    clip_result['duration_s'] = round(duration_s, 2)
    clip_result['locked'] = False
    return clip_result


# Compatibilidade
def analyze_audio_bytes(audio_bytes: bytes) -> Dict[str, Any]:
    return analyze_audio_bytes_v9(audio_bytes)
