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

# FIX BUG 4: Thresholds mais rígidos para não aceitar pitches ruidosos
CONFIDENCE_THRESHOLD = 0.45  # era 0.35 — filtrar mais ruído
MIN_NOTE_DUR_MS = 100        # era 60 — notas muito curtas são ornamentos/ruído
MIN_RMS_THRESHOLD = 0.010    # era 0.008

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
    
    # ═══ 3. CORRELAÇÃO KRUMHANSL (40%) ═══
    pcp = np.zeros(12, dtype=np.float64)
    for n in notes:
        pcp[n.pitch_class] += n.dur_ms * n.confidence
    
    krumhansl_score = np.zeros(12, dtype=np.float64)
    krumhansl_major = np.zeros(12, dtype=np.float64)
    krumhansl_minor = np.zeros(12, dtype=np.float64)
    
    for root in range(12):
        rotated_major = np.roll(KK_MAJOR, root)
        corr_major = np.corrcoef(pcp, rotated_major)[0, 1] if pcp.sum() > 0 else 0
        
        rotated_minor = np.roll(KK_MINOR, root)
        corr_minor = np.corrcoef(pcp, rotated_minor)[0, 1] if pcp.sum() > 0 else 0
        
        krumhansl_major[root] = max(0.0, float(corr_major))
        krumhansl_minor[root] = max(0.0, float(corr_minor))
        krumhansl_score[root] = max(krumhansl_major[root], krumhansl_minor[root])
    
    # Normalizar Krumhansl
    min_k = krumhansl_score.min()
    max_k = krumhansl_score.max()
    if max_k > min_k:
        krumhansl_score = (krumhansl_score - min_k) / (max_k - min_k)
    else:
        krumhansl_score = np.zeros(12)
    
    # ═══ COMBINAÇÃO FINAL (pesos corrigidos) ═══
    final_score = (
        0.35 * phrase_end_score +
        0.25 * duration_score +
        0.40 * krumhansl_score
    )
    
    # ═══ PENALIZAÇÃO ANTI-DOMINANTE + ANTI-MEDIANT ═══
    # 
    # Dois erros clássicos de confusão tonal:
    # 1. ANTI-DOMINANTE: A dominante (V = +7st) é muito frequente mas não é tônica
    # 2. ANTI-MEDIANT:   A terça (III = +4st) pode acumular peso quando o cantor
    #    permanece muito no 3ª grau (ex: em Sol maior, Si recebe mais tempo que Sol)
    #    → resulta em "Sol maior detectado como Si maior" (exatamente o bug G→B)
    #
    # Aplicamos as duas penalizações em cascata:
    for pc in range(12):
        if final_score[pc] > 0.55:
            # Penalizar dominante (V → pode confundir com tônica)
            dominant_of_pc = (pc + 7) % 12
            penalty_dom = final_score[pc] * 0.12
            final_score[dominant_of_pc] = max(0, final_score[dominant_of_pc] - penalty_dom)
            # Penalizar mediant maior (III → 3ª maior, ex: Si de Sol maior)
            mediant_major = (pc + 4) % 12
            penalty_med = final_score[pc] * 0.10
            final_score[mediant_major] = max(0, final_score[mediant_major] - penalty_med)
            # Penalizar mediant menor (bIII → 3ª menor, ex: Sib de Sol menor)
            mediant_minor = (pc + 3) % 12
            penalty_med_m = final_score[pc] * 0.07
            final_score[mediant_minor] = max(0, final_score[mediant_minor] - penalty_med_m)
    
    # ═══ ÂNCORA DE DURAÇÃO ═══
    # Se a nota com MAIOR tempo total diferir do vencedor Krumhansl,
    # dar bônus para ela. Em música tonal, a tônica é sempre a nota
    # mais sustentada. Este é o indicador mais confiável.
    dur_winner_pc = int(np.argmax(duration_weight))
    if dur_winner_pc != int(np.argmax(final_score)):
        # Discordância: Krumhansl e duração apontam direções diferentes
        # Dar bônus à nota mais longa para desempatar com evidência física
        bonus = min(0.15, duration_score[dur_winner_pc] * 0.20)
        final_score[dur_winner_pc] = min(1.0, final_score[dur_winner_pc] + bonus)
        logger.info(f"[v10] Âncora duração: bônus {bonus:.3f} para {NOTE_NAMES_BR[dur_winner_pc]}")
    
    ranked = sorted(enumerate(final_score), key=lambda x: x[1], reverse=True)
    winner_pc = ranked[0][0]
    winner_score = ranked[0][1]
    runner_up_score = ranked[1][1] if len(ranked) > 1 else 0
    
    # ═══ DETERMINAR MODO: MAIOR vs MENOR (FIX BUG 3) ═══
    #
    # Para tom com tônica em winner_pc:
    #   Terça Maior = winner_pc + 4 semitoms
    #   Terça Menor = winner_pc + 3 semitoms
    #   Sétima Sensível (maior) = winner_pc + 11 semitoms
    #   Sétima Menor = winner_pc + 10 semitoms
    #   Sexta Maior  = winner_pc + 9 semitoms
    #   Sexta Menor  = winner_pc + 8 semitoms
    #
    # Exemplo: Sol Maior vs Mi Menor
    #   Sol Maior: terça=Si(11), sensível=Fá#(6), 6ªM=Mi(4)
    #   Mi Menor:  terça=Sol(7), 7ª_menor=Ré(2), 6ªm=Dó(0)
    #   A presença de Fá# (sensível de Sol) distingue fortemente Sol Maior de Mi Menor.
    
    major_3rd   = (winner_pc + 4) % 12
    minor_3rd   = (winner_pc + 3) % 12
    major_7th   = (winner_pc + 11) % 12  # sensível (leading tone)
    minor_7th   = (winner_pc + 10) % 12  # sétima menor
    major_6th   = (winner_pc + 9) % 12   # 6ª maior
    minor_6th   = (winner_pc + 8) % 12   # 6ª menor
    
    dw = duration_weight  # atalho
    
    # Score para modo maior (0..1 cada)
    major_evidence = (
        0.50 * (dw[major_3rd] / (dw[major_3rd] + dw[minor_3rd] + 1e-6)) +
        0.30 * (dw[major_7th] / (dw[major_7th] + dw[minor_7th] + 1e-6)) +
        0.20 * (dw[major_6th] / (dw[major_6th] + dw[minor_6th] + 1e-6))
    )
    
    # Score para modo menor (espelho)
    minor_evidence = (
        0.50 * (dw[minor_3rd] / (dw[major_3rd] + dw[minor_3rd] + 1e-6)) +
        0.30 * (dw[minor_7th] / (dw[major_7th] + dw[minor_7th] + 1e-6)) +
        0.20 * (dw[minor_6th] / (dw[major_6th] + dw[minor_6th] + 1e-6))
    )
    
    # Desambiguação adicional via Krumhansl (usar correlação direta maior/menor)
    ks_major_winner = krumhansl_major[winner_pc]
    ks_minor_winner = krumhansl_minor[winner_pc]
    
    # Combinar evidência de graus + Krumhansl para decisão final
    combined_major = 0.65 * major_evidence + 0.35 * ks_major_winner
    combined_minor = 0.65 * minor_evidence + 0.35 * ks_minor_winner
    
    if combined_major > combined_minor * 1.15:
        quality = 'major'
    elif combined_minor > combined_major * 1.15:
        quality = 'minor'
    else:
        quality = 'major'  # Default: maior quando ambíguo (maioria dos casos em música popular)
    
    # ═══ CALCULAR CONFIANÇA ═══
    margin = winner_score - runner_up_score
    phrase_end_confidence = 1.0 if phrase_end_count[winner_pc] >= 2 else 0.7
    
    confidence = (
        0.40 * winner_score +
        0.35 * min(1.0, margin / 0.12) +
        0.25 * phrase_end_confidence
    )
    confidence = max(0.0, min(1.0, confidence))
    
    logger.info(f"[v10] Top 3: {[(NOTE_NAMES_BR[pc], f'{s:.3f}') for pc, s in ranked[:3]]}")
    logger.info(f"[v10] Maior evidence={combined_major:.3f} vs Menor evidence={combined_minor:.3f}")
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
            'mode_evidence': {
                'major': round(combined_major, 3),
                'minor': round(combined_minor, 3),
            },
            'scores': {
                'phrase_end': {NOTE_NAMES_BR[i]: round(phrase_end_score[i], 3) for i in range(12) if phrase_end_score[i] > 0.1},
                'duration': {NOTE_NAMES_BR[i]: round(duration_score[i], 3) for i in range(12) if duration_score[i] > 0.1},
                'krumhansl': {NOTE_NAMES_BR[i]: round(krumhansl_score[i], 3) for i in range(12) if krumhansl_score[i] > 0.1},
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
        # Janela deslizante maior = mais contexto musical = menos confusão
        self.all_notes.extend(notes)
        if len(self.all_notes) > 80:
            self.all_notes = self.all_notes[-80:]
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
        """
        if self.locked_tonic is not None:
            return self._should_change(result)
        
        phrases = result.phrases_count
        
        # Critério 1: Confiança muito alta + múltiplas frases detectadas
        if self.analysis_count >= 3 and result.confidence >= 0.65 and phrases >= 2:
            return True
        
        # Critério 2: Confiança excepcional (muito difícil de ser ruído)
        if result.confidence >= 0.80 and phrases >= 1 and self.analysis_count >= 2:
            return True
        
        # Critério 3: Consenso forte ao longo do tempo (3 de 4 últimos votos)
        if len(self.vote_history) >= 4 and result.confidence >= 0.55 and phrases >= 2:
            votes_for_current = sum(1 for v in self.vote_history[-4:] if v == result.tonic)
            if votes_for_current >= 3:
                return True
        
        # Critério 4: Timeout inteligente — após 12s sem lock, usar melhor candidato
        elapsed = time.time() - self.start_time
        if elapsed >= 12.0 and self.analysis_count >= 4 and result.confidence >= 0.45:
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
