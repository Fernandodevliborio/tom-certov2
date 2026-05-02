"""
feedback_service.py — Sistema de feedback + aprendizado da detecção de tom.

Quando o usuário marca "tom errado", salvamos FEATURES (não áudio cru):
  - PCP (pitch class profile)
  - Notes extraídas
  - Top candidates + cadence breakdown
  - Diff entre tom detectado e tom correto
  - Auto-classificação do tipo de erro (dominante, relativo, mediant, escala, etc.)

Features são leves (<2KB por amostra) e permitem:
  1. Analisar padrões de erro agregados
  2. Reanalisar offline com futuras versões do algoritmo
  3. Anonimizar completamente (sem voz do usuário)

MongoDB collection: key_feedback
"""

from typing import Dict, Any, List, Optional, Tuple
from datetime import datetime, timezone
import logging
from collections import Counter

logger = logging.getLogger(__name__)

# Nomes em ordem PC (0..11)
NOTE_NAMES_BR = ["Dó", "Dó#", "Ré", "Ré#", "Mi", "Fá", "Fá#", "Sol", "Sol#", "Lá", "Lá#", "Si"]


def parse_key_name(key_name: str) -> Optional[Tuple[int, str]]:
    """
    Parse "Sol Maior" / "Lá menor" / "Lá# Maior" → (pitch_class, 'major' | 'minor').
    Retorna None se não conseguir parsear.
    """
    if not key_name:
        return None
    parts = key_name.strip().rsplit(' ', 1)
    if len(parts) != 2:
        return None
    note, quality_pt = parts
    try:
        pc = NOTE_NAMES_BR.index(note)
    except ValueError:
        return None
    if quality_pt.lower() in ('maior', 'major'):
        return (pc, 'major')
    if quality_pt.lower() in ('menor', 'minor'):
        return (pc, 'minor')
    return None


def classify_error_type(detected_pc: int, detected_quality: str,
                        correct_pc: int, correct_quality: str) -> Dict[str, Any]:
    """
    Classifica o TIPO DE ERRO musical entre detectado e correto.
    
    Tipos reconhecidos:
      - `same` — não é erro (tom coincide)
      - `wrong_quality` — tônica certa, qualidade errada (Sol Maior vs Sol menor)
      - `relative` — detectou o relativo (diff +9 ou +3 com quality oposta)
      - `dominant` — detectou a dominante (V grau, diff +7)
      - `subdominant` — detectou a subdominante (IV grau, diff +5)
      - `mediant_major` — detectou a 3ª maior (diff +4)
      - `mediant_minor` — detectou a 3ª menor (diff +3)
      - `wrong_scale` — tonalidade distante (diff 1, 2, 6, 8, 10, 11)
    """
    diff = (detected_pc - correct_pc) % 12
    if detected_pc == correct_pc and detected_quality == correct_quality:
        return {'type': 'same', 'diff_semitones': 0}
    if detected_pc == correct_pc and detected_quality != correct_quality:
        return {'type': 'wrong_quality', 'diff_semitones': 0}
    
    # Relativo: diff +9 (detectou relativo menor do correto maior)
    #           ou diff +3 (detectou relativo maior do correto menor)
    if diff == 9 and correct_quality == 'major' and detected_quality == 'minor':
        return {'type': 'relative', 'diff_semitones': 9, 'direction': 'detected_relative_minor'}
    if diff == 3 and correct_quality == 'minor' and detected_quality == 'major':
        return {'type': 'relative', 'diff_semitones': 3, 'direction': 'detected_relative_major'}
    
    # Dominante: V grau (diff +7)
    if diff == 7:
        return {'type': 'dominant', 'diff_semitones': 7}
    # Subdominante: IV (diff +5)
    if diff == 5:
        return {'type': 'subdominant', 'diff_semitones': 5}
    # Mediant maior: 3ª maior (diff +4)
    if diff == 4:
        return {'type': 'mediant_major', 'diff_semitones': 4}
    # Mediant menor: 3ª menor (diff +3) — quando quality não é relativo
    if diff == 3:
        return {'type': 'mediant_minor', 'diff_semitones': 3}
    
    return {'type': 'wrong_scale', 'diff_semitones': int(diff)}


def suggest_root_cause(error_classification: Dict[str, Any],
                       debug: Dict[str, Any]) -> List[str]:
    """
    Sugere POSSÍVEIS CAUSAS do erro com base na classificação e no debug
    da análise. Usado para fine-tuning automático no futuro.
    """
    causes: List[str] = []
    err = error_classification.get('type', 'unknown')
    
    if err == 'relative':
        causes.append(
            "Algoritmo falhou em distinguir tom maior de seu relativo menor "
            "(mesma escala diatônica). Cadência não deu evidência clara."
        )
        winner = debug.get('winner_details', {})
        if winner.get('cadence', 0) < 0.25:
            causes.append("cadence_score baixa (<0.25) — música não repousou claramente na tônica.")
    elif err == 'dominant':
        causes.append(
            "Algoritmo tratou a 5ª justa (V grau) como tônica. "
            "Provavelmente o V apareceu em posição de phrase_end forte."
        )
    elif err == 'subdominant':
        causes.append(
            "Algoritmo tratou a 4ª justa (IV grau) como tônica. "
            "Caso raro: música modal ou com plagal cadence."
        )
    elif err in ('mediant_major', 'mediant_minor'):
        causes.append(
            "Algoritmo tratou a 3ª como tônica — "
            "anti-mediant insuficiente ou cadência enganosa."
        )
    elif err == 'wrong_quality':
        causes.append(
            "Algoritmo detectou tônica correta mas qualidade (maior/menor) errada. "
            "3ª característica pouco presente ou ambígua no áudio."
        )
        winner = debug.get('winner_details', {})
        if winner.get('third_ratio') is not None:
            ratio = winner['third_ratio']
            if 0.35 < ratio < 0.65:
                causes.append(f"third_ratio = {ratio:.2f} (muito ambíguo — 3ª maior e menor similares).")
    elif err == 'wrong_scale':
        diff = error_classification.get('diff_semitones', 0)
        causes.append(
            f"Tonalidade distante {diff} semitons — possível pitch shift na captura, "
            f"áudio ruidoso, ou cantor em tessitura muito variável."
        )
        if diff in (1, 11):
            causes.append("Diff 1 semitom: pode ser erro de oitava + desafinação ligeira.")
        elif diff == 2:
            causes.append("Diff 2 semitons: SUSPEITA de pitch-shift estrutural na captura de áudio.")
    
    return causes


def build_feedback_document(
    session_id: str,
    device_id: Optional[str],
    detected: Dict[str, Any],
    correct_key_name: str,
    analysis_debug: Dict[str, Any],
    notes_summary: List[Dict[str, Any]],
) -> Optional[Dict[str, Any]]:
    """
    Constrói o documento a salvar no MongoDB. Retorna None se parse falhar.
    """
    detected_parsed = parse_key_name(detected.get('key_name', ''))
    correct_parsed = parse_key_name(correct_key_name)
    
    if detected_parsed is None or correct_parsed is None:
        logger.warning(f"[feedback] parse falhou: detected={detected.get('key_name')} correct={correct_key_name}")
        return None
    
    detected_pc, detected_quality = detected_parsed
    correct_pc, correct_quality = correct_parsed
    
    error_class = classify_error_type(detected_pc, detected_quality, correct_pc, correct_quality)
    causes = suggest_root_cause(error_class, analysis_debug or {})
    
    doc = {
        'session_id': session_id,
        'device_id': device_id or 'anon',
        'timestamp': datetime.now(timezone.utc),
        'detected': {
            'tonic_pc': detected_pc,
            'quality': detected_quality,
            'key_name': detected.get('key_name'),
            'confidence': detected.get('confidence'),
        },
        'correct': {
            'tonic_pc': correct_pc,
            'quality': correct_quality,
            'key_name': correct_key_name,
        },
        'error_classification': error_class,
        'possible_causes': causes,
        'analysis_debug': {
            'top_candidates': analysis_debug.get('top_candidates'),
            'top_scales': analysis_debug.get('top_scales'),
            'mode_evidence': analysis_debug.get('mode_evidence'),
            'winner_details': analysis_debug.get('winner_details'),
            'phrase_ends': {str(k): v for k, v in (analysis_debug.get('phrase_ends') or {}).items()},
            'engine': analysis_debug.get('engine', 'unknown'),
        },
        'notes_summary': notes_summary[:50],  # até 50 notas como snapshot
        'reviewed': False,
        'applied_to_tuning': False,
    }
    return doc


def aggregate_error_stats(feedback_docs: List[Dict[str, Any]]) -> Dict[str, Any]:
    """
    Agrega estatísticas de erros para dashboard.
    
    Responde perguntas:
      - Qual tipo de erro é mais comum? (dominante, relativo, mediant...)
      - Qual tom (entre os 24) mais falha?
      - Padrões emergentes para ajustar pesos
    """
    total = len(feedback_docs)
    if total == 0:
        return {'total': 0, 'by_error_type': {}, 'top_wrong_detections': []}
    
    error_counter: Counter = Counter()
    correct_key_counter: Counter = Counter()
    detected_key_counter: Counter = Counter()
    confusion_pairs: Counter = Counter()
    
    for doc in feedback_docs:
        err = doc.get('error_classification', {}).get('type', 'unknown')
        error_counter[err] += 1
        
        correct = doc.get('correct', {})
        detected = doc.get('detected', {})
        correct_k = correct.get('key_name', '?')
        detected_k = detected.get('key_name', '?')
        correct_key_counter[correct_k] += 1
        detected_key_counter[detected_k] += 1
        confusion_pairs[f"{correct_k} → {detected_k}"] += 1
    
    return {
        'total': total,
        'by_error_type': {
            t: {'count': c, 'percent': round(100 * c / total, 1)}
            for t, c in error_counter.most_common()
        },
        'top_correct_keys_missed': correct_key_counter.most_common(10),
        'top_detected_wrong': detected_key_counter.most_common(10),
        'top_confusions': confusion_pairs.most_common(10),
    }
