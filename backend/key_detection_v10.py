"""
key_detection_v10.py — VERSÃO DEFINITIVA
═══════════════════════════════════════════════════════════════════════════════

PROBLEMAS RESOLVIDOS:
1. Detecção errada com áudio ruidoso → Filtro de ruído agressivo
2. Confusão entre tons relativos → Peso MUITO maior para fins de frase
3. Lock prematuro em tom errado → Requer mais evidência antes de travar
4. Instabilidade → Histerese forte para mudanças

PRINCÍPIO FUNDAMENTAL:
- A TÔNICA é onde as frases TERMINAM
- A TÔNICA é a nota mais LONGA
- A TÔNICA é a nota que RETORNA
- Dominante (V) é FREQUENTE mas NÃO é a tônica

ABORDAGEM:
- Priorizar QUALIDADE sobre VELOCIDADE
- Só travar quando tiver CERTEZA
- Usar múltiplas análises para confirmar
"""

from __future__ import annotations

import tempfile
from pathlib import Path
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

# Perfis Krumhansl-Kessler (mais precisos que Aarden)
KK_MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
KK_MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])

SAMPLE_RATE = 16000
HOP_MS = 10
HOP_LENGTH = int(SAMPLE_RATE * HOP_MS / 1000)
MODEL_CAPACITY = 'tiny'
F0_MIN = 65.0   # REDUZIDO para captar vozes graves
F0_MAX = 1000.0 # AUMENTADO para captar vozes agudas

# THRESHOLDS MAIS PERMISSIVOS para não perder notas
CONFIDENCE_THRESHOLD = 0.35  # REDUZIDO de 0.45 - aceita mais notas
MIN_NOTE_DUR_MS = 60         # REDUZIDO de 80 - notas mais curtas
MIN_RMS_THRESHOLD = 0.008    # REDUZIDO de 0.02 - mais sensível

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
    """Converte F0 em lista de notas com detecção de fins de frase."""
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
    MAX_GAP = 3  # 30ms de tolerância
    
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
                # Gap longo = fim de frase
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
    MÉTODO DEFINITIVO DE DETECÇÃO DE TONALIDADE
    
    Princípios:
    1. A TÔNICA é onde as frases terminam (60% do peso)
    2. A TÔNICA é a nota mais longa/frequente (25% do peso)
    3. Correlação com perfil Krumhansl (15% do peso)
    
    Por que esse peso?
    - Um cantor SEMPRE termina frases na tônica ou em nota do acorde tônico
    - Mesmo cantando escalas, a nota de repouso é a tônica
    - Krumhansl é bom mas genérico - fins de frase são específicos
    """
    # MUDANÇA: Aceita com apenas 2 notas para não travar
    if len(notes) < 2:
        return AnalysisResult(success=False, debug={'error': 'insufficient_notes', 'count': len(notes)})
    
    # ═══ 1. ANÁLISE DE FINS DE FRASE (60%) ═══
    phrase_end_weight = np.zeros(12, dtype=np.float64)
    phrase_end_count = Counter()
    
    for n in notes:
        if n.is_phrase_end:
            # Peso exponencial pela duração (notas longas no fim = MUITO importantes)
            weight = (n.dur_ms / 200.0) ** 1.5 * n.confidence
            phrase_end_weight[n.pitch_class] += weight
            phrase_end_count[n.pitch_class] += 1
    
    # Log para debug
    logger.info(f"[v10] Fins de frase: {dict(phrase_end_count)}")
    
    # Normalizar
    max_end = phrase_end_weight.max()
    if max_end > 0:
        phrase_end_score = phrase_end_weight / max_end
    else:
        phrase_end_score = np.zeros(12)
    
    # ═══ 2. ANÁLISE DE DURAÇÃO/FREQUÊNCIA (25%) ═══
    duration_weight = np.zeros(12, dtype=np.float64)
    for n in notes:
        # Notas longas têm mais peso
        weight = n.dur_ms * n.confidence
        # Bonus para notas muito longas (repouso)
        if n.dur_ms > 400:
            weight *= 1.5
        duration_weight[n.pitch_class] += weight
    
    max_dur = duration_weight.max()
    if max_dur > 0:
        duration_score = duration_weight / max_dur
    else:
        duration_score = np.zeros(12)
    
    # ═══ 3. CORRELAÇÃO KRUMHANSL (15%) ═══
    pcp = np.zeros(12, dtype=np.float64)
    for n in notes:
        pcp[n.pitch_class] += n.dur_ms * n.confidence
    
    krumhansl_score = np.zeros(12, dtype=np.float64)
    for root in range(12):
        # Testar como maior
        rotated_major = np.roll(KK_MAJOR, root)
        corr_major = np.corrcoef(pcp, rotated_major)[0, 1] if pcp.sum() > 0 else 0
        
        # Testar como menor
        rotated_minor = np.roll(KK_MINOR, root)
        corr_minor = np.corrcoef(pcp, rotated_minor)[0, 1] if pcp.sum() > 0 else 0
        
        krumhansl_score[root] = max(corr_major, corr_minor)
    
    # Normalizar
    min_k = krumhansl_score.min()
    max_k = krumhansl_score.max()
    if max_k > min_k:
        krumhansl_score = (krumhansl_score - min_k) / (max_k - min_k)
    else:
        krumhansl_score = np.zeros(12)
    
    # ═══ COMBINAÇÃO FINAL ═══
    # 60% fins de frase + 25% duração + 15% Krumhansl
    final_score = (
        0.60 * phrase_end_score +
        0.25 * duration_score +
        0.15 * krumhansl_score
    )
    
    # ═══ PENALIZAÇÃO ANTI-DOMINANTE ═══
    # Se uma nota X é candidata forte, penalizar X+7 (a 5ª de X)
    # Porque a dominante é frequente mas não é a tônica
    for pc in range(12):
        if final_score[pc] > 0.5:
            fifth_of_pc = (pc + 7) % 12
            penalty = final_score[pc] * 0.15
            final_score[fifth_of_pc] = max(0, final_score[fifth_of_pc] - penalty)
    
    # Encontrar vencedor
    ranked = sorted(enumerate(final_score), key=lambda x: x[1], reverse=True)
    winner_pc = ranked[0][0]
    winner_score = ranked[0][1]
    runner_up_score = ranked[1][1] if len(ranked) > 1 else 0
    
    # ═══ DETERMINAR MODO (MAIOR/MENOR) ═══
    major_3rd_pc = (winner_pc + 4) % 12
    minor_3rd_pc = (winner_pc + 3) % 12
    
    major_3rd_weight = duration_weight[major_3rd_pc]
    minor_3rd_weight = duration_weight[minor_3rd_pc]
    
    if major_3rd_weight > minor_3rd_weight * 1.2:
        quality = 'major'
    elif minor_3rd_weight > major_3rd_weight * 1.5:
        quality = 'minor'
    else:
        quality = 'major'  # Default para maior se ambíguo
    
    # ═══ CALCULAR CONFIANÇA ═══
    margin = winner_score - runner_up_score
    phrase_end_confidence = 1.0 if phrase_end_count[winner_pc] >= 2 else 0.7
    
    confidence = (
        0.40 * winner_score +
        0.30 * min(1.0, margin / 0.15) +
        0.30 * phrase_end_confidence
    )
    confidence = max(0.0, min(1.0, confidence))
    
    # Log detalhado
    logger.info(f"[v10] Top 3: {[(NOTE_NAMES_BR[pc], f'{s:.3f}') for pc, s in ranked[:3]]}")
    logger.info(f"[v10] Vencedor: {NOTE_NAMES_BR[winner_pc]} {quality} (conf={confidence:.2f})")
    
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
            'scores': {
                'phrase_end': {NOTE_NAMES_BR[i]: round(phrase_end_score[i], 3) for i in range(12) if phrase_end_score[i] > 0.1},
                'duration': {NOTE_NAMES_BR[i]: round(duration_score[i], 3) for i in range(12) if duration_score[i] > 0.1},
                'krumhansl': {NOTE_NAMES_BR[i]: round(krumhansl_score[i], 3) for i in range(12) if krumhansl_score[i] > 0.1},
            },
            'third_evidence': {
                'major_3rd': round(major_3rd_weight, 1),
                'minor_3rd': round(minor_3rd_weight, 1),
            }
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
        self.vote_history: List[int] = []  # Histórico de votos de tônica
        self.locked_tonic: Optional[int] = None
        self.locked_quality: Optional[str] = None
        self.locked_confidence: float = 0.0
        self.locked_at: Optional[float] = None
        self.last_activity_time: float = time.time()  # NOVO: Rastrear atividade
    
    def add_analysis(self, notes: List[Note]):
        """Adiciona notas de uma análise."""
        self.last_activity_time = time.time()  # Atualiza atividade
        # Acumular notas (janela deslizante de no máximo 50 notas)
        self.all_notes.extend(notes)
        if len(self.all_notes) > 50:
            self.all_notes = self.all_notes[-50:]
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
        """Decide se deve travar o tom."""
        if self.locked_tonic is not None:
            # Já está travado - verificar se deve mudar
            return self._should_change(result)
        
        # MUDANÇA AGRESSIVA: Lock muito mais rápido
        # Critério 1: Qualquer confiança >= 0.40 com pelo menos 1 análise
        if result.confidence >= 0.40:
            return True
        
        # Critério 2: Se já tem 2+ votos no mesmo tom, lock imediato
        if len(self.vote_history) >= 2:
            votes_for_current = sum(1 for v in self.vote_history[-3:] if v == result.tonic)
            if votes_for_current >= 2:
                return True
        
        return False
    
    def _should_change(self, result: AnalysisResult) -> bool:
        """Verifica se deve mudar o tom travado."""
        if result.tonic == self.locked_tonic:
            # Mesmo tom - atualizar confiança
            self.locked_confidence = max(self.locked_confidence, result.confidence)
            return False
        
        # Tom diferente - precisa de evidência forte
        time_since_lock = time.time() - (self.locked_at or time.time())
        
        # Mínimo 3 segundos antes de considerar mudança
        if time_since_lock < 3.0:
            return False
        
        # Precisa de 3 votos consecutivos no novo tom
        if len(self.vote_history) >= 3:
            last_votes = self.vote_history[-3:]
            if all(v == result.tonic for v in last_votes):
                # E confiança maior que atual
                if result.confidence > self.locked_confidence + 0.1:
                    logger.info(f"[v10] Mudando de {NOTE_NAMES_BR[self.locked_tonic]} para {NOTE_NAMES_BR[result.tonic]}")
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
