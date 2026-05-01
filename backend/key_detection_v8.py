"""
key_detection_v8.py — TRIBUNAL DE EVIDÊNCIAS TONAL
═══════════════════════════════════════════════════════════════════════════════

ARQUITETURA NOVA: Sistema de votação com múltiplos avaliadores independentes.

PROBLEMA RESOLVIDO:
- Confusão V↔I (dominante vs tônica)
- Confusão maior↔menor relativo
- Instabilidade entre análises
- Falta de detecção de cadências
- Decisão baseada em pitch isolado

SOLUÇÃO:
┌─────────────────────────────────────────┐
│        TRIBUNAL DE EVIDÊNCIAS           │
│   3 jurados votam independentemente     │
└─────────────────────────────────────────┘
              ▲
   ┌──────────┼──────────┐
   │          │          │
┌──┴──┐   ┌───┴───┐   ┌──┴──┐
│ KS  │   │CADÊNC.│   │GRAV.│
│ 30% │   │  35%  │   │ 35% │
└─────┘   └───────┘   └─────┘

Krumhansl-Aarden: Correlação estatística (identifica "família" tonal)
Cadências: Padrões V→I, IV→I, II→V→I (confirma centro tonal)
Gravidade: Notas longas + fins de frase + repetição (ancora a tônica)

A decisão de MAIOR vs MENOR é feita SOMENTE APÓS definir a tônica,
usando a presença/ausência da 3ª.
"""

from __future__ import annotations

import io
import tempfile
from pathlib import Path
from typing import List, Dict, Any, Optional, Tuple, Set
from dataclasses import dataclass, field
from enum import Enum
import time

import numpy as np
import librosa
import torch
import torchcrepe

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

# Intervalos da escala
SCALE_MAJOR = frozenset([0, 2, 4, 5, 7, 9, 11])
SCALE_MINOR_NAT = frozenset([0, 2, 3, 5, 7, 8, 10])
SCALE_MINOR_HARM = frozenset([0, 2, 3, 5, 7, 8, 11])  # 7ª maior

# ═══════════════════════════════════════════════════════════════════════════════
# PARÂMETROS DE ÁUDIO
# ═══════════════════════════════════════════════════════════════════════════════

SAMPLE_RATE = 16000
HOP_MS = 10
HOP_LENGTH = int(SAMPLE_RATE * HOP_MS / 1000)
MODEL_CAPACITY = 'tiny'
F0_MIN = 65.0
F0_MAX = 1000.0
CONFIDENCE_THRESHOLD = 0.50
MIN_NOTE_DUR_MS = 100

DEVICE = torch.device('cuda' if torch.cuda.is_available() else 'cpu')

# ═══════════════════════════════════════════════════════════════════════════════
# ESTRUTURAS DE DADOS
# ═══════════════════════════════════════════════════════════════════════════════

@dataclass
class Note:
    """Uma nota detectada."""
    pitch_class: int
    midi: float
    dur_ms: float
    start_ms: float
    rms_conf: float

@dataclass
class Phrase:
    """Uma frase musical (sequência de notas entre pausas)."""
    notes: List[Note]
    start_ms: float
    end_ms: float
    
    @property
    def duration_ms(self) -> float:
        return self.end_ms - self.start_ms
    
    @property
    def last_note(self) -> Optional[Note]:
        return self.notes[-1] if self.notes else None
    
    @property
    def last_two_notes(self) -> Tuple[Optional[Note], Optional[Note]]:
        if len(self.notes) >= 2:
            return self.notes[-2], self.notes[-1]
        elif len(self.notes) == 1:
            return None, self.notes[-1]
        return None, None

class CadenceType(Enum):
    """Tipos de cadência detectados."""
    AUTHENTIC = "V→I"       # Dominante → Tônica (confirmação forte)
    PLAGAL = "IV→I"         # Subdominante → Tônica
    HALF = "→V"             # Suspensão na dominante
    DECEPTIVE = "V→vi"      # Dominante → Submediante
    CYCLE = "II→V→I"        # Ciclo de quintas completo

@dataclass
class CadenceEvidence:
    """Evidência de cadência detectada."""
    cadence_type: CadenceType
    resolved_to_pc: int  # Pitch class para onde resolve
    strength: float      # 0.0 a 1.0
    phrase_index: int

@dataclass
class JurorVote:
    """Voto de um jurado para um candidato tonal."""
    tonic_pc: int
    score: float  # Normalizado 0.0 a 1.0
    confidence: float
    reasoning: str

@dataclass
class TonalCandidate:
    """Candidato a tom final."""
    tonic_pc: int
    quality: str  # 'major' ou 'minor' ou 'undecided'
    
    # Votos dos jurados
    krumhansl_vote: float = 0.0
    cadence_vote: float = 0.0
    gravity_vote: float = 0.0
    
    # Score combinado (weighted)
    combined_score: float = 0.0
    
    # Evidências
    cadences_found: List[CadenceEvidence] = field(default_factory=list)
    third_evidence: Dict[str, Any] = field(default_factory=dict)
    
    @property
    def key_name(self) -> str:
        q = 'Maior' if self.quality == 'major' else 'menor' if self.quality == 'minor' else '?'
        return f"{NOTE_NAMES_BR[self.tonic_pc]} {q}"

# ═══════════════════════════════════════════════════════════════════════════════
# FUNÇÕES DE ÁUDIO E EXTRAÇÃO
# ═══════════════════════════════════════════════════════════════════════════════

def load_audio_from_bytes(audio_bytes: bytes, target_sr: int = SAMPLE_RATE) -> np.ndarray:
    """Carrega áudio de bytes, converte para mono 16kHz float32."""
    with tempfile.NamedTemporaryFile(suffix='.audio', delete=True) as tmp:
        tmp.write(audio_bytes)
        tmp.flush()
        y, sr = librosa.load(tmp.name, sr=target_sr, mono=True)
    max_abs = float(np.max(np.abs(y)) or 1.0)
    if max_abs > 0:
        y = y / max_abs * 0.95
    return y.astype(np.float32)


def extract_f0_with_crepe(
    audio: np.ndarray,
    sr: int = SAMPLE_RATE,
    model: str = MODEL_CAPACITY,
) -> Tuple[np.ndarray, np.ndarray]:
    """Extrai F0 com torchcrepe. Retorna (f0 Hz, confidence)."""
    audio_t = torch.from_numpy(audio).unsqueeze(0).to(DEVICE)
    pitch, confidence = torchcrepe.predict(
        audio_t, sr, HOP_LENGTH, F0_MIN, F0_MAX, model,
        batch_size=512, device=DEVICE, return_periodicity=True,
    )
    win_length = 3
    confidence = torchcrepe.filter.median(confidence, win_length)
    pitch = torchcrepe.filter.mean(pitch, win_length)
    pitch_np = pitch[0].cpu().numpy()
    conf_np = confidence[0].cpu().numpy()
    pitch_np = np.where(conf_np >= CONFIDENCE_THRESHOLD, pitch_np, np.nan)
    return pitch_np, conf_np


def f0_to_midi(f0: np.ndarray) -> np.ndarray:
    """Converte Hz para MIDI note number."""
    with np.errstate(divide='ignore', invalid='ignore'):
        midi = 69.0 + 12.0 * np.log2(f0 / 440.0)
    return midi


def segment_notes(midi: np.ndarray, conf: np.ndarray, hop_ms: float = HOP_MS) -> List[Note]:
    """Segmenta a sequência MIDI em notas."""
    notes: List[Note] = []
    if len(midi) == 0:
        return notes
    
    current_pc: Optional[int] = None
    current_midi_sum = 0.0
    current_conf_sum = 0.0
    current_frames = 0
    start_frame = 0

    def flush(end_frame: int):
        nonlocal current_pc, current_midi_sum, current_conf_sum, current_frames, start_frame
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

    for i, m in enumerate(midi):
        if np.isnan(m):
            flush(i)
            continue
        pc = int(round(m)) % 12
        if current_pc is None:
            current_pc = pc
            start_frame = i
            current_midi_sum = float(m)
            current_conf_sum = float(conf[i])
            current_frames = 1
        elif pc == current_pc:
            current_midi_sum += float(m)
            current_conf_sum += float(conf[i])
            current_frames += 1
        else:
            flush(i)
            current_pc = pc
            start_frame = i
            current_midi_sum = float(m)
            current_conf_sum = float(conf[i])
            current_frames = 1
    flush(len(midi))
    return notes


def detect_phrases(notes: List[Note], silence_gap_ms: float = 400.0) -> List[Phrase]:
    """Agrupa notas em frases usando gap de silêncio."""
    phrases: List[Phrase] = []
    current_notes: List[Note] = []
    phrase_start = 0.0
    last_end = -1.0
    
    for n in notes:
        start = n.start_ms
        if current_notes and (start - last_end) >= silence_gap_ms:
            phrases.append(Phrase(
                notes=current_notes,
                start_ms=phrase_start,
                end_ms=last_end,
            ))
            current_notes = []
            phrase_start = start
        if not current_notes:
            phrase_start = start
        current_notes.append(n)
        last_end = start + n.dur_ms
    
    if current_notes:
        phrases.append(Phrase(
            notes=current_notes,
            start_ms=phrase_start,
            end_ms=last_end,
        ))
    return phrases


def compute_pcp(notes: List[Note]) -> np.ndarray:
    """Pitch Class Profile: soma de (duração × confidence) por pitch class."""
    pcp = np.zeros(12, dtype=np.float64)
    for n in notes:
        pcp[n.pitch_class] += n.dur_ms * n.rms_conf
    return pcp


# ═══════════════════════════════════════════════════════════════════════════════
# JURADO 1: KRUMHANSL-AARDEN (30%)
# ═══════════════════════════════════════════════════════════════════════════════

def _pearson(x: np.ndarray, y: np.ndarray) -> float:
    """Correlação de Pearson."""
    if len(x) != len(y) or len(x) == 0:
        return 0.0
    mx, my = np.mean(x), np.mean(y)
    dx, dy = x - mx, y - my
    num = float(np.sum(dx * dy))
    den = float(np.sqrt(np.sum(dx ** 2) * np.sum(dy ** 2)))
    return num / den if den > 1e-10 else 0.0


def juror_krumhansl(pcp: np.ndarray) -> Dict[int, float]:
    """
    JURADO 1: Correlação Krumhansl-Aarden.
    Retorna score normalizado [0,1] para cada pitch class como possível tônica.
    
    CORREÇÃO v9: Aplica bias para TOM MAIOR quando a evidência é ambígua.
    Estatisticamente, ~70% das músicas populares são em tom maior.
    
    Também penaliza candidatos que são o RELATIVO MENOR de outro candidato forte.
    """
    if pcp.sum() < 100:
        return {i: 0.0 for i in range(12)}
    
    # Calcula correlação para AMBOS os modos
    scores_major = {}
    scores_minor = {}
    
    for root in range(12):
        rotated_maj = np.roll(AARDEN_MAJOR, root)
        rotated_min = np.roll(AARDEN_MINOR, root)
        
        corr_maj = _pearson(pcp, rotated_maj)
        corr_min = _pearson(pcp, rotated_min)
        
        # Normaliza para [0, 1]
        scores_major[root] = max(0.0, (corr_maj + 1.0) / 2.0)
        scores_minor[root] = max(0.0, (corr_min + 1.0) / 2.0)
    
    # ═══ BIAS PARA TOM MAIOR ═══
    # Quando maior e menor relativo são próximos, favorece o maior
    MAJOR_BIAS = 1.12  # 12% de vantagem para tom maior
    
    final_scores = {}
    for root in range(12):
        major_score = scores_major[root] * MAJOR_BIAS
        minor_score = scores_minor[root]
        
        # Relativo menor está 9 semitons acima (ou 3 abaixo)
        relative_minor_root = (root + 9) % 12
        relative_major_root = (root + 3) % 12
        
        # Se este root é um candidato menor, verificar se o relativo maior é mais forte
        # Penalizar o menor se o maior relativo tem score similar
        if minor_score > major_score:
            # Este root seria melhor como menor
            relative_maj_score = scores_major[relative_major_root] * MAJOR_BIAS
            
            # Se o relativo maior tem score >= 85% do menor, penalizar o menor
            if relative_maj_score >= minor_score * 0.85:
                minor_score *= 0.85  # Penaliza o menor
        
        # Pega o melhor entre maior e menor para este root
        final_scores[root] = max(major_score, minor_score)
    
    # Normaliza para que o máximo seja 1.0
    max_score = max(final_scores.values()) or 1.0
    return {k: v / max_score for k, v in final_scores.items()}


# ═══════════════════════════════════════════════════════════════════════════════
# JURADO 2: CADÊNCIAS (35%) — O MAIS IMPORTANTE
# ═══════════════════════════════════════════════════════════════════════════════

def _interval(from_pc: int, to_pc: int) -> int:
    """Intervalo em semitons (ascendente) de from_pc para to_pc."""
    return (to_pc - from_pc + 12) % 12


def detect_cadences(phrases: List[Phrase]) -> List[CadenceEvidence]:
    """
    Detecta cadências musicais reais nas frases.
    
    CADÊNCIAS DETECTADAS:
    - V→I (Autêntica): intervalo de 5ª justa descendente (7 semitons para baixo)
    - IV→I (Plagal): intervalo de 4ª justa descendente (5 semitons para baixo)
    - →V (Meia-cadência): frase termina na dominante (suspensão)
    - II→V→I (Ciclo): sequência de quintas descendentes
    
    Cada cadência VOTA para a tônica correspondente.
    """
    cadences: List[CadenceEvidence] = []
    
    for idx, phrase in enumerate(phrases):
        if len(phrase.notes) < 2:
            continue
        
        notes = phrase.notes
        last = notes[-1]
        second_last = notes[-2]
        
        # Intervalo entre penúltima e última nota
        interval = _interval(second_last.pitch_class, last.pitch_class)
        
        # ═══ CADÊNCIA AUTÊNTICA (V→I) ═══
        # Movimento de 5ª descendente (ou 4ª ascendente = 5 semitons)
        # V está 7 semitons acima de I, então I→V = 7, V→I = 5
        if interval == 5:  # 5 semitons para cima = 7 para baixo = V→I
            # A última nota é provavelmente a TÔNICA
            strength = min(1.0, last.dur_ms / 300.0) * last.rms_conf
            cadences.append(CadenceEvidence(
                cadence_type=CadenceType.AUTHENTIC,
                resolved_to_pc=last.pitch_class,
                strength=strength * 1.0,  # Peso máximo
                phrase_index=idx,
            ))
        
        # ═══ CADÊNCIA PLAGAL (IV→I) ═══
        # IV está 5 semitons acima de I, então IV→I = movimento de 5 semitons para baixo
        # que é 7 semitons para cima
        elif interval == 7:  # 7 semitons para cima = 5 para baixo = IV→I
            strength = min(1.0, last.dur_ms / 300.0) * last.rms_conf
            cadences.append(CadenceEvidence(
                cadence_type=CadenceType.PLAGAL,
                resolved_to_pc=last.pitch_class,
                strength=strength * 0.8,  # Peso menor que autêntica
                phrase_index=idx,
            ))
        
        # ═══ CICLO II→V→I ═══
        if len(notes) >= 3:
            third_last = notes[-3]
            int1 = _interval(third_last.pitch_class, second_last.pitch_class)
            int2 = _interval(second_last.pitch_class, last.pitch_class)
            
            # II→V = 5 semitons (ciclo de 5as), V→I = 5 semitons
            if int1 == 5 and int2 == 5:
                strength = min(1.0, last.dur_ms / 300.0) * last.rms_conf
                cadences.append(CadenceEvidence(
                    cadence_type=CadenceType.CYCLE,
                    resolved_to_pc=last.pitch_class,
                    strength=strength * 1.2,  # Peso extra por ser ciclo completo
                    phrase_index=idx,
                ))
        
        # ═══ MEIA-CADÊNCIA (→V) ═══
        # Se a frase termina em suspensão (nota não-resolutiva)
        # Detectamos quando a última nota poderia ser uma dominante
        # (vai ser usada negativamente — diminui confiança se termina em V)
        # Por ora, não implementamos para não complicar.
    
    return cadences


def juror_cadences(phrases: List[Phrase], notes: List[Note]) -> Dict[int, float]:
    """
    JURADO 2: Análise de cadências.
    Retorna score [0,1] para cada pitch class baseado em cadências que resolvem nele.
    
    Este é o jurado mais CONFIÁVEL para determinar a tônica real.
    """
    scores = {i: 0.0 for i in range(12)}
    
    cadences = detect_cadences(phrases)
    
    if not cadences:
        # Sem cadências detectadas — usar fins de frase como proxy fraco
        for phrase in phrases:
            if phrase.last_note:
                pc = phrase.last_note.pitch_class
                dur_factor = min(1.0, phrase.last_note.dur_ms / 400.0)
                scores[pc] += 0.3 * dur_factor * phrase.last_note.rms_conf
        
        # Normaliza
        max_s = max(scores.values()) or 1.0
        return {k: v / max_s for k, v in scores.items()}
    
    # Processar cadências detectadas
    for cad in cadences:
        pc = cad.resolved_to_pc
        scores[pc] += cad.strength
        
        # Bônus: se múltiplas cadências resolvem no mesmo PC, é muito forte
        count = sum(1 for c in cadences if c.resolved_to_pc == pc)
        if count >= 2:
            scores[pc] *= 1.2
    
    # Normaliza
    max_s = max(scores.values()) or 1.0
    return {k: v / max_s for k, v in scores.items()}


# ═══════════════════════════════════════════════════════════════════════════════
# JURADO 3: CENTRO GRAVITACIONAL (35%)
# ═══════════════════════════════════════════════════════════════════════════════

def juror_gravity(notes: List[Note], phrases: List[Phrase], pcp: np.ndarray) -> Dict[int, float]:
    """
    JURADO 3: Centro gravitacional tonal.
    
    CORREÇÃO v9: Maior peso para notas de repouso e fins de frase.
    Estas são as indicações mais fortes da tônica real.
    
    Combina:
    1. Nota mais cantada (duração total) — 25%
    2. Notas de repouso (> 300ms) — 30%
    3. Fins de frase (resolução) — 30%
    4. Início de frases — 15%
    
    Retorna score [0,1] para cada pitch class.
    """
    scores = np.zeros(12, dtype=np.float64)
    
    # ═══ 1. DURAÇÃO TOTAL (nota mais cantada) ═══
    # Peso: 25% do jurado (reduzido de 35%)
    pcp_norm = pcp / (pcp.max() or 1.0)
    scores += pcp_norm * 0.25
    
    # ═══ 2. NOTAS DE REPOUSO (longas) ═══
    # Notas > 300ms indicam centro tonal (reduzido de 350ms)
    # Peso: 30% do jurado (aumentado de 25%)
    rest_weight = np.zeros(12, dtype=np.float64)
    for n in notes:
        if n.dur_ms >= 300:
            # Peso exponencial baseado na duração
            dur_factor = (n.dur_ms / 300.0) ** 1.5
            rest_weight[n.pitch_class] += dur_factor * n.rms_conf
    if rest_weight.max() > 0:
        rest_norm = rest_weight / rest_weight.max()
        scores += rest_norm * 0.30
    
    # ═══ 3. FINS DE FRASE ═══
    # Onde as frases terminam = provável tônica
    # Peso: 30% do jurado (aumentado de 25%)
    phrase_end_weight = np.zeros(12, dtype=np.float64)
    for phrase in phrases:
        if phrase.last_note:
            pc = phrase.last_note.pitch_class
            # Peso maior para notas finais longas
            dur_factor = min(2.0, phrase.last_note.dur_ms / 300.0)
            phrase_end_weight[pc] += dur_factor * phrase.last_note.rms_conf * 1.5
    if phrase_end_weight.max() > 0:
        end_norm = phrase_end_weight / phrase_end_weight.max()
        scores += end_norm * 0.30
    
    # ═══ 4. INÍCIO DE FRASES ═══
    # Anacruse vs ataque na tônica
    # Peso: 15% do jurado
    phrase_start_weight = np.zeros(12, dtype=np.float64)
    for phrase in phrases:
        if phrase.notes:
            first = phrase.notes[0]
            # Notas iniciais longas são mais importantes
            dur_factor = min(1.0, first.dur_ms / 300.0)
            phrase_start_weight[first.pitch_class] += dur_factor * first.rms_conf * 0.5
    if phrase_start_weight.max() > 0:
        start_norm = phrase_start_weight / phrase_start_weight.max()
        scores += start_norm * 0.15
    
    # Normaliza para [0, 1]
    max_s = scores.max() or 1.0
    return {i: float(scores[i] / max_s) for i in range(12)}


# ═══════════════════════════════════════════════════════════════════════════════
# DECISÃO DE MODO (MAIOR vs MENOR) — APÓS DEFINIR TÔNICA
# ═══════════════════════════════════════════════════════════════════════════════

def decide_mode(tonic_pc: int, pcp: np.ndarray, notes: List[Note], phrases: List[Phrase] = None) -> Tuple[str, float, Dict[str, Any]]:
    """
    Decide se o tom é MAIOR ou MENOR baseado em múltiplas evidências.
    
    CORREÇÃO v9: Análise mais completa com:
    1. Presença da 3ª (maior vs menor)
    2. Presença da 6ª e 7ª (escala menor natural vs harmônica)
    3. Contexto melódico (movimento para a 3ª)
    4. Bias estatístico para maior
    
    REGRAS:
    1. Se 3ª maior presente E 3ª menor ausente → MAIOR (confiança alta)
    2. Se 3ª menor presente E 3ª maior ausente → MENOR (confiança alta)
    3. Se ambas presentes → análise detalhada + bias para maior
    4. Se nenhuma presente → verificar 6ª/7ª, senão default MAIOR
    
    Args:
        tonic_pc: Pitch class da tônica já definida
        pcp: Pitch Class Profile
        notes: Lista de notas
        phrases: Lista de frases (opcional)
    
    Returns:
        (quality, confidence, evidence)
    """
    maj_3rd_pc = (tonic_pc + 4) % 12  # 3ª maior = 4 semitons
    min_3rd_pc = (tonic_pc + 3) % 12  # 3ª menor = 3 semitons
    maj_6th_pc = (tonic_pc + 9) % 12  # 6ª maior = 9 semitons
    min_6th_pc = (tonic_pc + 8) % 12  # 6ª menor = 8 semitons
    maj_7th_pc = (tonic_pc + 11) % 12 # 7ª maior = 11 semitons
    min_7th_pc = (tonic_pc + 10) % 12 # 7ª menor = 10 semitons
    fifth_pc = (tonic_pc + 7) % 12    # 5ª justa = 7 semitons
    
    maj_3rd_weight = float(pcp[maj_3rd_pc])
    min_3rd_weight = float(pcp[min_3rd_pc])
    maj_6th_weight = float(pcp[maj_6th_pc])
    min_6th_weight = float(pcp[min_6th_pc])
    maj_7th_weight = float(pcp[maj_7th_pc])
    min_7th_weight = float(pcp[min_7th_pc])
    tonic_weight = float(pcp[tonic_pc])
    fifth_weight = float(pcp[fifth_pc])
    
    total_3rd = maj_3rd_weight + min_3rd_weight
    total_6th = maj_6th_weight + min_6th_weight
    total_7th = maj_7th_weight + min_7th_weight
    
    evidence = {
        'major_3rd_pc': maj_3rd_pc,
        'minor_3rd_pc': min_3rd_pc,
        'major_3rd_weight': round(maj_3rd_weight, 2),
        'minor_3rd_weight': round(min_3rd_weight, 2),
        'total_3rd_weight': round(total_3rd, 2),
        'major_6th_weight': round(maj_6th_weight, 2),
        'minor_6th_weight': round(min_6th_weight, 2),
        'major_7th_weight': round(maj_7th_weight, 2),
        'minor_7th_weight': round(min_7th_weight, 2),
        'tonic_weight': round(tonic_weight, 2),
        'fifth_weight': round(fifth_weight, 2),
    }
    
    # Threshold mínimo para considerar que uma nota está presente
    MIN_WEIGHT = 30.0  # Reduzido para captar mais evidência
    
    maj_3rd_present = maj_3rd_weight > MIN_WEIGHT
    min_3rd_present = min_3rd_weight > MIN_WEIGHT
    maj_6th_present = maj_6th_weight > MIN_WEIGHT
    min_6th_present = min_6th_weight > MIN_WEIGHT
    maj_7th_present = maj_7th_weight > MIN_WEIGHT
    min_7th_present = min_7th_weight > MIN_WEIGHT
    
    evidence['major_3rd_present'] = maj_3rd_present
    evidence['minor_3rd_present'] = min_3rd_present
    
    # ═══ CASO 1: Só 3ª maior presente (claramente maior) ═══
    if maj_3rd_present and not min_3rd_present:
        evidence['decision_reason'] = 'only_major_3rd_present'
        return 'major', 0.95, evidence
    
    # ═══ CASO 2: Só 3ª menor presente (possivelmente menor) ═══
    if min_3rd_present and not maj_3rd_present:
        # Verificar evidência adicional de tom menor
        # Tom menor geralmente tem 6ª menor ou 7ª menor
        minor_evidence_count = sum([
            min_6th_present,
            min_7th_present,
        ])
        major_evidence_count = sum([
            maj_6th_present,
            maj_7th_present,
        ])
        
        if minor_evidence_count >= major_evidence_count:
            evidence['decision_reason'] = 'minor_3rd_with_minor_evidence'
            return 'minor', 0.90, evidence
        else:
            # 3ª menor mas com 6ª/7ª maiores = pode ser passagem
            # Ainda assim, provavelmente é menor
            evidence['decision_reason'] = 'minor_3rd_ambiguous_context'
            return 'minor', 0.75, evidence
    
    # ═══ CASO 3: Ambas as terças presentes — análise detalhada ═══
    if maj_3rd_present and min_3rd_present:
        ratio = maj_3rd_weight / total_3rd
        evidence['major_3rd_ratio'] = round(ratio, 3)
        
        # Aplicar BIAS para maior (músicas populares são ~70% em tom maior)
        MAJOR_BIAS_THRESHOLD = 0.45  # Se maior >= 45%, considerar maior
        
        if ratio >= 0.55:
            evidence['decision_reason'] = 'both_present_major_dominant'
            return 'major', 0.75 + (ratio - 0.55) * 0.4, evidence
        elif ratio >= MAJOR_BIAS_THRESHOLD:
            # Zona ambígua: 45-55%
            # Verificar 6ª e 7ª para desempatar
            maj_context = maj_6th_weight + maj_7th_weight
            min_context = min_6th_weight + min_7th_weight
            
            if maj_context > min_context * 1.2:
                evidence['decision_reason'] = 'ambiguous_3rd_major_context'
                return 'major', 0.65, evidence
            elif min_context > maj_context * 1.5:
                evidence['decision_reason'] = 'ambiguous_3rd_minor_context'
                return 'minor', 0.60, evidence
            else:
                # Realmente ambíguo — default para maior
                evidence['decision_reason'] = 'ambiguous_3rd_default_major'
                return 'major', 0.55, evidence
        else:
            # ratio < 45% — mais evidência de menor
            evidence['decision_reason'] = 'both_present_minor_dominant'
            return 'minor', 0.65 + (0.45 - ratio) * 0.4, evidence
    
    # ═══ CASO 4: Nenhuma terça presente ═══
    # Verificar 6ª e 7ª como proxy
    if maj_6th_present or maj_7th_present:
        if min_6th_present or min_7th_present:
            # Ambas presentes — default maior
            evidence['decision_reason'] = 'no_3rd_mixed_67_default_major'
            return 'major', 0.45, evidence
        else:
            # Só maior
            evidence['decision_reason'] = 'no_3rd_major_67_present'
            return 'major', 0.55, evidence
    elif min_6th_present or min_7th_present:
        # Só menor
        evidence['decision_reason'] = 'no_3rd_minor_67_present'
        return 'minor', 0.50, evidence
    
    # ═══ CASO 5: Nenhuma evidência — default maior ═══
    evidence['decision_reason'] = 'no_evidence_default_major'
    return 'major', 0.40, evidence


# ═══════════════════════════════════════════════════════════════════════════════
# TRIBUNAL DE EVIDÊNCIAS — FUNÇÃO PRINCIPAL
# ═══════════════════════════════════════════════════════════════════════════════

# Pesos dos jurados
WEIGHT_KRUMHANSL = 0.30
WEIGHT_CADENCES = 0.35
WEIGHT_GRAVITY = 0.35

def tribunal_decide(
    notes: List[Note],
    phrases: List[Phrase],
    pcp: np.ndarray,
) -> Dict[str, Any]:
    """
    TRIBUNAL DE EVIDÊNCIAS TONAL
    
    3 jurados votam independentemente para cada pitch class como possível tônica.
    O candidato com maior score combinado é eleito.
    A decisão de modo (maior/menor) é feita APÓS a eleição da tônica.
    
    Returns:
        Resultado completo com diagnóstico
    """
    if not notes:
        return {
            'success': False,
            'error': 'no_notes',
            'message': 'Nenhuma nota detectada.',
        }
    
    if pcp.sum() < 100:
        return {
            'success': False,
            'error': 'insufficient_audio',
            'message': 'Áudio insuficiente para análise.',
        }
    
    # ═══ COLETA DE VOTOS ═══
    ks_votes = juror_krumhansl(pcp)
    cad_votes = juror_cadences(phrases, notes)
    grav_votes = juror_gravity(notes, phrases, pcp)
    
    # ═══ COMBINAÇÃO DOS VOTOS ═══
    combined = {}
    for pc in range(12):
        combined[pc] = (
            WEIGHT_KRUMHANSL * ks_votes[pc] +
            WEIGHT_CADENCES * cad_votes[pc] +
            WEIGHT_GRAVITY * grav_votes[pc]
        )
    
    # Ordena candidatos por score
    ranked = sorted(combined.items(), key=lambda x: x[1], reverse=True)
    
    # Top candidato
    winner_pc = ranked[0][0]
    winner_score = ranked[0][1]
    runner_up_pc = ranked[1][0] if len(ranked) > 1 else None
    runner_up_score = ranked[1][1] if len(ranked) > 1 else 0.0
    
    # ═══ DECISÃO DE MODO ═══
    quality, mode_confidence, third_evidence = decide_mode(winner_pc, pcp, notes, phrases)
    
    # ═══ CONFIDENCE FINAL ═══
    # Combina score combinado + margem + confiança do modo
    margin = winner_score - runner_up_score
    margin_factor = min(1.0, margin / 0.15)  # Normaliza margem
    
    confidence = (
        0.50 * winner_score +
        0.25 * margin_factor +
        0.25 * mode_confidence
    )
    confidence = max(0.0, min(1.0, confidence))
    
    # ═══ FLAGS DE DIAGNÓSTICO ═══
    flags = []
    
    if margin < 0.05:
        flags.append('close_call')
    
    if not third_evidence.get('major_3rd_present') and not third_evidence.get('minor_3rd_present'):
        flags.append('no_third_evidence')
    elif third_evidence.get('major_3rd_present') and third_evidence.get('minor_3rd_present'):
        ratio = third_evidence.get('major_3rd_ratio', 0.5)
        if 0.35 < ratio < 0.65:
            flags.append('ambiguous_third')
    
    if len(notes) < 5:
        flags.append('few_notes')
    
    if len(phrases) < 2:
        flags.append('single_phrase')
    
    cadences = detect_cadences(phrases)
    if not cadences:
        flags.append('no_cadences')
    
    # Verifica confusão com relativo
    if runner_up_pc is not None:
        # Relativo menor está 9 semitons acima do maior (ou 3 abaixo)
        is_relative = (
            (quality == 'major' and (winner_pc + 9) % 12 == runner_up_pc) or
            (quality == 'minor' and (winner_pc + 3) % 12 == runner_up_pc)
        )
        if is_relative and margin < 0.10:
            flags.append('relative_ambiguous')
    
    # ═══ RESULTADO ═══
    return {
        'success': True,
        'tonic': winner_pc,
        'tonic_name': NOTE_NAMES_BR[winner_pc],
        'quality': quality,
        'key_name': f"{NOTE_NAMES_BR[winner_pc]} {'Maior' if quality == 'major' else 'menor'}",
        'confidence': round(confidence, 3),
        'confidence_breakdown': {
            'combined_score': round(winner_score, 3),
            'margin': round(margin, 3),
            'mode_confidence': round(mode_confidence, 3),
        },
        'votes': {
            'krumhansl': {NOTE_NAMES_BR[i]: round(ks_votes[i], 3) for i in range(12)},
            'cadences': {NOTE_NAMES_BR[i]: round(cad_votes[i], 3) for i in range(12)},
            'gravity': {NOTE_NAMES_BR[i]: round(grav_votes[i], 3) for i in range(12)},
            'combined': {NOTE_NAMES_BR[i]: round(combined[i], 3) for i in range(12)},
        },
        'top_candidates': [
            {
                'tonic_pc': pc,
                'tonic_name': NOTE_NAMES_BR[pc],
                'score': round(combined[pc], 4),
                'ks': round(ks_votes[pc], 3),
                'cad': round(cad_votes[pc], 3),
                'grav': round(grav_votes[pc], 3),
            }
            for pc, _ in ranked[:5]
        ],
        'flags': flags,
        'third_evidence': third_evidence,
        'cadences_found': [
            {
                'type': c.cadence_type.value,
                'resolved_to': NOTE_NAMES_BR[c.resolved_to_pc],
                'strength': round(c.strength, 3),
            }
            for c in cadences
        ],
        'stats': {
            'notes_count': len(notes),
            'phrases_count': len(phrases),
            'pcp_total': round(float(pcp.sum()), 1),
        },
        'method': 'tribunal-v8',
    }


# ═══════════════════════════════════════════════════════════════════════════════
# ACUMULADOR DE SESSÃO (MEMÓRIA DE LONGO PRAZO)
# ═══════════════════════════════════════════════════════════════════════════════

class SessionAccumulator:
    """
    Acumula evidências ao longo de múltiplas análises.
    Resolve o problema de análises independentes e fragmentadas.
    
    DECAY REDUZIDO: Mantém memória por mais tempo (30s de memória efetiva).
    """
    
    def __init__(self, decay: float = 0.995):  # Decay muito mais lento que antes (0.98)
        self.pcp = np.zeros(12, dtype=np.float64)
        self.notes: List[Note] = []
        self.phrases: List[Phrase] = []
        self.decay = decay
        self.last_update = time.time()
        self.analysis_count = 0
        
        # Histórico de decisões (para histerese)
        self.decision_history: List[Dict[str, Any]] = []
        self.locked_tonic: Optional[int] = None
        self.locked_quality: Optional[str] = None
        self.locked_at: Optional[float] = None
        self.locked_confidence: float = 0.0
    
    def apply_decay(self):
        """Aplica decay baseado no tempo desde última atualização."""
        now = time.time()
        elapsed = now - self.last_update
        
        # Decay por segundo (muito mais lento)
        decay_factor = self.decay ** elapsed
        self.pcp *= decay_factor
        self.last_update = now
    
    def add_analysis(self, notes: List[Note], phrases: List[Phrase], pcp: np.ndarray):
        """Adiciona nova análise ao acumulador."""
        self.apply_decay()
        
        # Acumula PCP (com peso para análises novas)
        self.pcp += pcp * 0.5  # Peso reduzido para não dominar
        
        # Mantém notas e frases recentes (últimas 50 notas, 10 frases)
        self.notes = (self.notes + notes)[-50:]
        self.phrases = (self.phrases + phrases)[-10:]
        
        self.analysis_count += 1
    
    def get_accumulated_result(self) -> Dict[str, Any]:
        """Retorna análise baseada nos dados acumulados."""
        if self.pcp.sum() < 50:
            return {
                'success': False,
                'error': 'insufficient_accumulated',
                'message': 'Dados acumulados insuficientes.',
            }
        
        return tribunal_decide(self.notes, self.phrases, self.pcp)
    
    def should_update_lock(self, new_result: Dict[str, Any]) -> bool:
        """
        Decide se deve atualizar o tom travado (histerese forte).
        
        REGRAS:
        1. Se não há tom travado, travar se confiança >= 0.35
        2. Se já tem tom travado, só trocar se:
           - Novo tom aparece 5+ vezes consecutivas
           - Margem de confiança >= 0.12
           - Tempo desde lock >= 4 segundos
        """
        if not new_result.get('success'):
            return False
        
        new_tonic = new_result['tonic']
        new_quality = new_result['quality']
        new_conf = new_result['confidence']
        
        # ═══ CASO 1: Nenhum tom travado ═══
        if self.locked_tonic is None:
            if new_conf >= 0.35:
                self._lock(new_tonic, new_quality, new_conf)
                return True
            return False
        
        # ═══ CASO 2: Mesmo tom — reforçar ═══
        if new_tonic == self.locked_tonic and new_quality == self.locked_quality:
            self.locked_confidence = max(self.locked_confidence, new_conf)
            return False
        
        # ═══ CASO 3: Tom diferente — verificar histerese ═══
        
        # Adicionar ao histórico
        self.decision_history.append({
            'tonic': new_tonic,
            'quality': new_quality,
            'confidence': new_conf,
            'time': time.time(),
        })
        self.decision_history = self.decision_history[-10:]  # Manter últimas 10
        
        # Contar consecutivos do novo tom
        consecutive = 0
        for d in reversed(self.decision_history):
            if d['tonic'] == new_tonic and d['quality'] == new_quality:
                consecutive += 1
            else:
                break
        
        # Verificar tempo desde lock
        time_since_lock = time.time() - (self.locked_at or time.time())
        
        # Verificar margem de confiança
        margin = new_conf - self.locked_confidence
        
        # Condições para troca
        if (
            consecutive >= 5 and
            margin >= 0.08 and
            time_since_lock >= 4.0
        ):
            self._lock(new_tonic, new_quality, new_conf)
            return True
        
        # Condições mais fortes para troca rápida
        if consecutive >= 7 and new_conf >= 0.55:
            self._lock(new_tonic, new_quality, new_conf)
            return True
        
        return False
    
    def _lock(self, tonic: int, quality: str, confidence: float):
        """Trava um novo tom."""
        self.locked_tonic = tonic
        self.locked_quality = quality
        self.locked_confidence = confidence
        self.locked_at = time.time()
        self.decision_history.clear()
    
    def get_locked_result(self) -> Optional[Dict[str, Any]]:
        """Retorna o tom travado, se houver."""
        if self.locked_tonic is None:
            return None
        
        return {
            'tonic': self.locked_tonic,
            'tonic_name': NOTE_NAMES_BR[self.locked_tonic],
            'quality': self.locked_quality,
            'key_name': f"{NOTE_NAMES_BR[self.locked_tonic]} {'Maior' if self.locked_quality == 'major' else 'menor'}",
            'confidence': self.locked_confidence,
            'locked_for_seconds': round(time.time() - (self.locked_at or time.time()), 1),
        }
    
    def reset(self):
        """Reseta o acumulador (nova sessão)."""
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


# Dicionário global de acumuladores por device_id
_session_accumulators: Dict[str, SessionAccumulator] = {}


def get_session_accumulator(device_id: str) -> SessionAccumulator:
    """Obtém ou cria acumulador para um device_id."""
    if device_id not in _session_accumulators:
        _session_accumulators[device_id] = SessionAccumulator()
    return _session_accumulators[device_id]


def reset_session(device_id: str):
    """Reseta sessão de um device."""
    if device_id in _session_accumulators:
        _session_accumulators[device_id].reset()


# ═══════════════════════════════════════════════════════════════════════════════
# FUNÇÃO PÚBLICA PRINCIPAL
# ═══════════════════════════════════════════════════════════════════════════════

def analyze_audio_bytes_v8(
    audio_bytes: bytes,
    device_id: str = 'anon',
    use_accumulator: bool = True,
) -> Dict[str, Any]:
    """
    FUNÇÃO PRINCIPAL — Análise de áudio com Tribunal de Evidências.
    
    Args:
        audio_bytes: Áudio em bytes (WAV/OGG/M4A)
        device_id: ID do dispositivo para acumulação de sessão
        use_accumulator: Se True, usa memória de sessão
    
    Returns:
        Resultado da análise com tom detectado e diagnóstico
    """
    # ═══ CARREGAR ÁUDIO ═══
    audio = load_audio_from_bytes(audio_bytes)
    duration_s = len(audio) / SAMPLE_RATE
    
    if duration_s < 1.0:
        return {
            'success': False,
            'error': 'audio_too_short',
            'message': 'Áudio muito curto. Cante pelo menos 1.5 segundos.',
            'duration_s': duration_s,
        }
    
    # ═══ EXTRAIR F0 COM CREPE ═══
    f0, conf = extract_f0_with_crepe(audio)
    valid_f0_count = int(np.sum(~np.isnan(f0)))
    
    if valid_f0_count < 15:
        return {
            'success': False,
            'error': 'no_pitch_detected',
            'message': 'Não conseguimos detectar notas claras. Cante mais alto.',
            'duration_s': duration_s,
            'valid_f0_frames': valid_f0_count,
        }
    
    # ═══ SEGMENTAR NOTAS E FRASES ═══
    midi = f0_to_midi(f0)
    notes = segment_notes(midi, conf)
    phrases = detect_phrases(notes)
    pcp = compute_pcp(notes)
    
    # ═══ ANÁLISE DO CLIP ATUAL ═══
    clip_result = tribunal_decide(notes, phrases, pcp)
    
    # ═══ ACUMULADOR DE SESSÃO ═══
    if use_accumulator:
        accumulator = get_session_accumulator(device_id)
        accumulator.add_analysis(notes, phrases, pcp)
        
        # Obter resultado acumulado
        acc_result = accumulator.get_accumulated_result()
        
        if acc_result.get('success'):
            # Verificar se deve atualizar lock
            accumulator.should_update_lock(acc_result)
            
            # Usar resultado do lock se disponível
            locked = accumulator.get_locked_result()
            if locked:
                # Combinar info do lock com diagnóstico do clip atual
                return {
                    'success': True,
                    'tonic': locked['tonic'],
                    'tonic_name': locked['tonic_name'],
                    'quality': locked['quality'],
                    'key_name': locked['key_name'],
                    'confidence': locked['confidence'],
                    'locked': True,
                    'locked_for_seconds': locked['locked_for_seconds'],
                    'clip_result': clip_result,  # Diagnóstico do clip
                    'accumulated_analyses': accumulator.analysis_count,
                    'method': 'tribunal-v8-accumulated',
                    'duration_s': round(duration_s, 2),
                    'notes_count': len(notes),
                    'phrases_count': len(phrases),
                    'flags': clip_result.get('flags', []),
                    'cadences_found': clip_result.get('cadences_found', []),
                }
    
    # ═══ RETORNAR RESULTADO DO CLIP ═══
    clip_result['duration_s'] = round(duration_s, 2)
    clip_result['valid_f0_frames'] = valid_f0_count
    clip_result['locked'] = False
    
    return clip_result


# ═══════════════════════════════════════════════════════════════════════════════
# COMPATIBILIDADE COM API ANTIGA
# ═══════════════════════════════════════════════════════════════════════════════

def analyze_audio_bytes(audio_bytes: bytes) -> Dict[str, Any]:
    """Wrapper para compatibilidade com API antiga."""
    return analyze_audio_bytes_v8(audio_bytes, device_id='anon', use_accumulator=True)
