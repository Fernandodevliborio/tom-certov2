"""
key_detection.py — Análise ML de Tonalidade para Voz A Capela
═══════════════════════════════════════════════════════════════════════

Pipeline:
    áudio (WAV/OGG/M4A)
    → librosa (resample para 16kHz mono)
    → torchcrepe (extração F0 com confidence por frame)
    → filtragem de frames confiáveis
    → segmentação em notas (MIDI + duração)
    → detecção de frases (silêncios/pausas)
    → análise de tonalidade v2 (Krumhansl + cadência + TonicAnchor
      + guard anti-grau-diatônico + tiebreaker de relativos)
    → retorno: tonic (pc), quality (maj/min), confidence, f0_count, notes_count

Pipeline v2 idêntico ao frontend (TypeScript portado → Python):
    CREPE (99% precisão de nota) + lógica musical madura de decisão tonal.
"""

from __future__ import annotations

import io
import tempfile
from pathlib import Path
from typing import List, Dict, Any, Optional, Tuple

import numpy as np
import librosa
import soundfile as sf
import torch
import torchcrepe

# ─── Perfis Krumhansl-Schmuckler ──────────────────────────────────────
KS_MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
KS_MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])

NOTE_NAMES_BR = ['Dó', 'Dó#', 'Ré', 'Ré#', 'Mi', 'Fá', 'Fá#', 'Sol', 'Sol#', 'Lá', 'Lá#', 'Si']

# ─── Parâmetros ──────────────────────────────────────────────────────
SAMPLE_RATE = 16000
HOP_MS = 10  # CREPE roda a cada 10ms
HOP_LENGTH = int(SAMPLE_RATE * HOP_MS / 1000)  # 160 samples
MODEL_CAPACITY = 'tiny'  # 'tiny' ou 'full'. Tiny é 5x mais rápido e suficiente
F0_MIN = 65.0   # C2 (voz grave masculina)
F0_MAX = 1000.0  # B5 (voz aguda feminina)
CONFIDENCE_THRESHOLD = 0.50  # frames abaixo disso são descartados
MIN_NOTE_DUR_MS = 100  # notas muito curtas (< 100ms) são descartadas

DEVICE = torch.device('cuda' if torch.cuda.is_available() else 'cpu')


def load_audio_from_bytes(audio_bytes: bytes, target_sr: int = SAMPLE_RATE) -> np.ndarray:
    """Carrega áudio de bytes (qualquer formato), converte para mono 16kHz float32."""
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
    """
    Extrai F0 com torchcrepe.
    Retorna (f0 em Hz por frame, confidence 0..1 por frame).
    NaN em F0 significa frame sem pitch confiável.
    """
    audio_t = torch.from_numpy(audio).unsqueeze(0).to(DEVICE)
    pitch, confidence = torchcrepe.predict(
        audio_t,
        sr,
        HOP_LENGTH,
        F0_MIN,
        F0_MAX,
        model,
        batch_size=512,
        device=DEVICE,
        return_periodicity=True,
    )
    win_length = 3
    confidence = torchcrepe.filter.median(confidence, win_length)
    pitch = torchcrepe.filter.mean(pitch, win_length)
    pitch_np = pitch[0].cpu().numpy()
    conf_np = confidence[0].cpu().numpy()
    pitch_np = np.where(conf_np >= CONFIDENCE_THRESHOLD, pitch_np, np.nan)
    return pitch_np, conf_np


def f0_to_midi(f0: np.ndarray) -> np.ndarray:
    """Converte Hz para MIDI note number (float). NaN preservado."""
    with np.errstate(divide='ignore', invalid='ignore'):
        midi = 69.0 + 12.0 * np.log2(f0 / 440.0)
    return midi


def segment_notes(
    midi: np.ndarray,
    conf: np.ndarray,
    hop_ms: float = HOP_MS,
) -> List[Dict[str, Any]]:
    """
    Segmenta a sequência MIDI em notas.
    Agrupa frames consecutivos cujo arredondamento MIDI seja igual.
    """
    notes: List[Dict[str, Any]] = []
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
            notes.append({
                'pitch_class': current_pc,
                'midi': round(current_midi_sum / current_frames, 2),
                'dur_ms': round(dur_ms, 1),
                'start_ms': round(start_frame * hop_ms, 1),
                'rms_conf': round(current_conf_sum / current_frames, 3),
            })
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


def detect_phrases(notes: List[Dict[str, Any]], silence_gap_ms: float = 500.0) -> List[List[Dict[str, Any]]]:
    """
    Agrupa notas em frases usando gap de silêncio.
    Gap de 500ms: respirações curtas (<500ms) não quebram frase.
    Isso evita contar cada respiração como "fim de frase/cadência" e viciar o TonicAnchor.
    """
    phrases: List[List[Dict[str, Any]]] = []
    current: List[Dict[str, Any]] = []
    last_end = -1.0
    for n in notes:
        start = n['start_ms']
        if current and (start - last_end) >= silence_gap_ms:
            phrases.append(current)
            current = []
        current.append(n)
        last_end = start + n['dur_ms']
    if current:
        phrases.append(current)
    return phrases


def compute_weighted_histogram(notes: List[Dict[str, Any]]) -> np.ndarray:
    """Histograma 12-dim ponderado por duração × confidence."""
    h = np.zeros(12, dtype=np.float64)
    for n in notes:
        w = n['dur_ms'] * n['rms_conf']
        h[n['pitch_class']] += w
    return h


def absorb_detuning(hist: np.ndarray, ratio_threshold: float = 0.45) -> np.ndarray:
    """
    Absorve desafinação: se um vizinho cromático (±1 semitom) tem peso
    < ratio_threshold × peso do PC dominante, é tratado como "bleed"
    de desafinação/CREPE harmônico — parte é absorvida no vizinho forte.

    Ex: se F=1000 e F#=300 (30%, < 45%), então 60% do F# é absorvido em F
    (F vira 1180, F# vira 120). Preserva evidência genuína (se F# fosse 700
    = 70%, ficaria intocado).

    Isso estabiliza tremendamente voz desafinada ±30-50 cents.
    """
    out = np.copy(hist).astype(np.float64)
    original = np.copy(hist).astype(np.float64)
    for i in range(12):
        strong = original[i]
        if strong <= 1e-6:
            continue
        for neighbor in ((i - 1) % 12, (i + 1) % 12):
            weak = original[neighbor]
            if weak <= 1e-6:
                continue
            if weak < ratio_threshold * strong:
                # absorve 60% do vizinho fraco no forte
                absorbed = 0.60 * weak
                out[i] += absorbed
                out[neighbor] -= absorbed
    # Sanity: nenhum PC pode ficar negativo
    out = np.maximum(out, 0.0)
    return out


def pearson_correlation(a: np.ndarray, b: np.ndarray) -> float:
    """Correlação de Pearson entre vetores."""
    a_mean = a.mean()
    b_mean = b.mean()
    num = np.sum((a - a_mean) * (b - b_mean))
    den = np.sqrt(np.sum((a - a_mean) ** 2) * np.sum((b - b_mean) ** 2))
    if den < 1e-9:
        return 0.0
    return float(num / den)


# ═══════════════════════════════════════════════════════════════════════
# TONIC ANCHOR — Gravidade Tonal Global (portado de tonicAnchor.ts)
# ═══════════════════════════════════════════════════════════════════════
# Pesos
ANCHOR_DECAY = 0.98        # 15-20s de memória
W_END_PHRASE = 3.0         # cadência (reduzido de 8.0 — respiração != fim de frase)
W_LONG_NOTE = 3.0          # nota >= 400ms
W_DURATION_PER_MS = 0.003  # acumulador por ms
W_RECURRENCE = 1.5         # bonus quando pc já tinha peso
W_STABILITY = 2.0          # nota estável (rms_conf >= 0.7 + dur >= 250ms)
LONG_NOTE_MS = 400
STABLE_NOTE_MIN_DUR_MS = 250
STABLE_NOTE_MIN_RMS = 0.7
RECURRENCE_MIN_PRIOR_WEIGHT = 1.5

# Pesos por função harmônica no alignment
ALIGN_W_TONIC = 0.70
ALIGN_W_FIFTH = 0.20
ALIGN_W_FOURTH = 0.10
MIN_GRAVITY_FOR_ALIGNMENT = 8.0

# Graus diatônicos
DIATONIC_DEGREES_MAJOR = {2, 4, 5, 7, 9, 11}   # ii, iii, IV, V, vi, vii°
DIATONIC_DEGREES_MINOR = {2, 3, 5, 7, 8, 10}   # ii°, III, iv, v, VI, VII


def compute_tonic_gravity(notes: List[Dict[str, Any]], phrases: List[List[Dict[str, Any]]]) -> np.ndarray:
    """
    Calcula a GRAVIDADE TONAL global por pitch class.
    Pesos:
    - Finais de frase (cadência): +8.0 por frase
    - Notas longas >= 400ms: +3.0
    - Duração total: +0.003/ms
    - Estabilidade (rms_conf >= 0.7 e dur >= 250ms): +2.0
    - Recorrência (pc já tinha peso >= 1.5): +1.5
    """
    g = np.zeros(12, dtype=np.float64)

    for n in notes:
        pc = n['pitch_class']
        dur = n['dur_ms']
        g[pc] += W_DURATION_PER_MS * dur
        if dur >= LONG_NOTE_MS:
            g[pc] += W_LONG_NOTE
        if dur >= STABLE_NOTE_MIN_DUR_MS and n.get('rms_conf', 0) >= STABLE_NOTE_MIN_RMS:
            g[pc] += W_STABILITY

    for phrase in phrases:
        if not phrase:
            continue
        last_note = phrase[-1]
        g[last_note['pitch_class']] += W_END_PHRASE

    # Recorrência
    for pc in range(12):
        if g[pc] >= RECURRENCE_MIN_PRIOR_WEIGHT:
            g[pc] += W_RECURRENCE

    return g


def alignment_score(candidate_tonic: int, gravity: np.ndarray) -> float:
    """
    Quão bem uma tônica candidata casa com a gravidade.
    Tônica: 70%, Dominante: 20%, Subdominante: 10%.
    """
    total_g = float(gravity.sum())
    if total_g < MIN_GRAVITY_FOR_ALIGNMENT:
        return 0.5  # neutro (dados insuficientes)
    max_g = float(gravity.max() or 1.0)
    norm = gravity / max_g
    tonic = float(norm[candidate_tonic])
    fifth = float(norm[(candidate_tonic + 7) % 12])
    fourth = float(norm[(candidate_tonic + 5) % 12])
    return max(0.0, min(1.0, ALIGN_W_TONIC * tonic + ALIGN_W_FIFTH * fifth + ALIGN_W_FOURTH * fourth))


def alignment_boost(candidate_tonic: int, gravity: np.ndarray) -> float:
    """Multiplicador 0.4..1.0 baseado no alignment."""
    return 0.4 + 0.6 * alignment_score(candidate_tonic, gravity)


def is_diatonic_degree_of(candidate: int, current_tonic: int, quality: str) -> bool:
    """True se candidate é grau diatônico (II-VII) da current_tonic."""
    if candidate == current_tonic:
        return False
    interval = (candidate - current_tonic + 12) % 12
    if quality == 'minor':
        return interval in DIATONIC_DEGREES_MINOR
    return interval in DIATONIC_DEGREES_MAJOR


def is_relative_pair(cand_a: Dict[str, Any], cand_b: Dict[str, Any]) -> bool:
    """Verifica se dois candidatos formam par maior/relativa menor."""
    if cand_a['quality'] == cand_b['quality']:
        return False
    maj = cand_a if cand_a['quality'] == 'major' else cand_b
    mn  = cand_a if cand_a['quality'] == 'minor' else cand_b
    return mn['root'] == (maj['root'] + 9) % 12


def relative_tiebreak_score(cand: Dict[str, Any], hist: np.ndarray, phrases: List[List[Dict[str, Any]]]) -> float:
    """
    Desempate para par relativo: cadência > freq tônica > 5ª.
    Pesos: cadência 0.55, tônica 0.30, quinta 0.15.
    """
    total = float(hist.sum() or 1.0)
    tonic_freq = hist[cand['root']] / total
    fifth_freq  = hist[(cand['root'] + 7) % 12] / total
    cad = 0.0
    if phrases:
        cad_count = sum(1 for p in phrases if p and p[-1]['pitch_class'] == cand['root'])
        cad = cad_count / len(phrases)
    return 0.55 * cad + 0.30 * tonic_freq + 0.15 * fifth_freq


def score_key(
    hist: np.ndarray,
    phrases: List[List[Dict[str, Any]]],
    root: int,
    quality: str,
) -> Dict[str, float]:
    """
    Pontua (root, quality):
    - Perfil Krumhansl-Schmuckler (Pearson)
    - Cadência (% frases resolvem em root)
    - Força tônica (tônica + 5ª no histograma)
    - Penalidade por notas fora da escala
    """
    profile = KS_MAJOR if quality == 'major' else KS_MINOR
    rotated = np.roll(profile, root)
    pearson = pearson_correlation(hist, rotated)
    ks_score = max(0.0, (pearson + 1) / 2)  # map [-1,1] → [0,1]

    # Cadência
    cadence_score = 0.0
    if phrases:
        cad_count = sum(1 for p in phrases if p and p[-1]['pitch_class'] == root)
        cadence_score = cad_count / len(phrases)

    # Força tônica
    max_h = float(np.max(hist) or 1.0)
    tonic_strength = hist[root] / max_h
    fifth_strength = hist[(root + 7) % 12] / max_h
    force_score = 0.6 * tonic_strength + 0.4 * fifth_strength

    # Penalidade por notas fora da escala
    intervals_major = [0, 2, 4, 5, 7, 9, 11]
    intervals_minor = [0, 2, 3, 5, 7, 8, 10]
    intervals = intervals_major if quality == 'major' else intervals_minor
    in_scale = set((root + iv) % 12 for iv in intervals)
    total = float(hist.sum() or 1.0)
    out_scale = float(sum(hist[pc] for pc in range(12) if pc not in in_scale))
    penalty = out_scale / total

    score = 0.40 * ks_score + 0.35 * cadence_score + 0.15 * force_score - 0.20 * penalty

    return {
        'score': score,
        'ks': ks_score,
        'cadence': cadence_score,
        'force': force_score,
        'penalty': penalty,
    }


def third_clarity(hist: np.ndarray, root: int, quality: str) -> Dict[str, float]:
    """
    Mede a clareza da terça da tônica candidata.
    Returns:
      - third_score: peso harmônico da terça COERENTE (maj se quality=major, min se quality=minor)
      - conflict_score: peso da terça CONFLITANTE (a outra terça)
      - ratio: third_score / (third_score + conflict_score). 1.0 = claro, 0.5 = ambíguo
      - decisive: True se ratio >= 0.70 (terça dominante clara)
    Uma 3ª presente e sustentada é a evidência mais forte para maj vs min.
    """
    maj_third_pc = (root + 4) % 12    # 3ª maior
    min_third_pc = (root + 3) % 12    # 3ª menor
    w_maj = float(hist[maj_third_pc])
    w_min = float(hist[min_third_pc])
    if quality == 'major':
        third_score = w_maj
        conflict_score = w_min
    else:
        third_score = w_min
        conflict_score = w_maj
    total = third_score + conflict_score
    ratio = third_score / total if total > 0 else 0.5
    return {
        'third_score': third_score,
        'conflict_score': conflict_score,
        'ratio': ratio,
        'decisive': ratio >= 0.70 and total > 0,
        'present': total > 0,
    }


def detect_key_from_notes(
    notes: List[Dict[str, Any]],
    phrases: List[List[Dict[str, Any]]],
    hist_override: Optional[np.ndarray] = None,
    gravity_override: Optional[np.ndarray] = None,
) -> Dict[str, Any]:
    """
    Detecta tonalidade com pipeline v3 — honest confidence edition:
    1. Pontua cada 1 dos 24 candidatos (Krumhansl + cadência + força - penalidade)
    2. Aplica BOOST de alignment por gravidade tonal global (TonicAnchor)
    3. Aplica BOOST de terça (maj vs min da mesma raiz) via third_clarity
    4. Ordena e aplica TIEBREAKER de pares relativos se top-2 forem relativos
    5. Aplica GUARD anti-grau-diatônico: se runner-up é V/IV/ii/vi da tônica top
    6. CONFIDENCE HONESTA: baseada em margem relativa, clareza da terça, material disponível

    hist_override/gravity_override permitem passar histograma ACUMULADO
    (de múltiplas análises) para estabilidade temporal em voz a capela.
    """
    if not notes:
        return {'tonic': None, 'quality': None, 'confidence': 0.0, 'reason': 'no_notes'}

    if hist_override is not None:
        hist = hist_override.astype(np.float64)
    else:
        hist_raw = compute_weighted_histogram(notes)
        hist = absorb_detuning(hist_raw, ratio_threshold=0.45)
    total_hist = float(hist.sum())
    if total_hist < 1.0:
        return {'tonic': None, 'quality': None, 'confidence': 0.0, 'reason': 'too_little_audio'}

    # ── Gravidade tonal global (TonicAnchor) ─────────────────────────
    if gravity_override is not None:
        gravity = gravity_override.astype(np.float64)
    else:
        gravity = compute_tonic_gravity(notes, phrases)

    # ── Scores base + boost de terça ─────────────────────────────────
    candidates = []
    for root in range(12):
        for quality in ('major', 'minor'):
            s = score_key(hist, phrases, root, quality)
            boost = alignment_boost(root, gravity)
            tc = third_clarity(hist, root, quality)
            # Third boost: +10% se ratio >= 0.70 e terça presente; -10% se ratio <= 0.30
            if tc['present']:
                if tc['ratio'] >= 0.70:
                    third_multiplier = 1.0 + 0.10 * (tc['ratio'] - 0.70) / 0.30
                elif tc['ratio'] <= 0.30:
                    third_multiplier = 1.0 - 0.10 * (0.30 - tc['ratio']) / 0.30
                else:
                    third_multiplier = 1.0
            else:
                third_multiplier = 0.95  # sem 3ª → leve penalidade
            effective_score = s['score'] * boost * third_multiplier
            candidates.append({
                'root': root,
                'quality': quality,
                'base_score': s['score'],
                'score': effective_score,
                'boost': boost,
                'third_multiplier': third_multiplier,
                'third_ratio': tc['ratio'],
                'third_present': tc['present'],
                'alignment': alignment_score(root, gravity),
                'cadence': s['cadence'],
                'ks': s['ks'],
                'force': s['force'],
                'penalty': s['penalty'],
            })

    candidates.sort(key=lambda c: c['score'], reverse=True)

    # ── TIEBREAKER para pares relativos ──────────────────────────────
    if len(candidates) >= 2 and is_relative_pair(candidates[0], candidates[1]):
        diff = abs(candidates[0]['score'] - candidates[1]['score'])
        avg = (candidates[0]['score'] + candidates[1]['score']) / 2
        closeness = diff / avg if avg > 0 else 1.0
        if closeness < 0.10:
            tb0 = relative_tiebreak_score(candidates[0], hist, phrases)
            tb1 = relative_tiebreak_score(candidates[1], hist, phrases)
            if tb1 > tb0 + 0.03:
                candidates[0], candidates[1] = candidates[1], candidates[0]

    # ── GUARD anti-grau-diatônico ────────────────────────────────────
    top = candidates[0]
    for runner_idx in range(1, min(5, len(candidates))):
        runner = candidates[runner_idx]
        if is_diatonic_degree_of(runner['root'], top['root'], top['quality']):
            grav_top    = float(gravity[top['root']])
            grav_runner = float(gravity[runner['root']])
            if grav_runner > grav_top * 1.3:
                candidates[0], candidates[runner_idx] = runner, top
                break

    top    = candidates[0]
    runner = candidates[1] if len(candidates) > 1 else None
    margin_abs = top['score'] - (runner['score'] if runner else 0)

    # ═══════════════════════════════════════════════════════════════
    # CONFIDENCE HONESTA v3
    # ═══════════════════════════════════════════════════════════════
    # 1) Margem RELATIVA (top vs runner) — peso dominante (50%)
    top_score = max(top['score'], 1e-6)
    relative_margin = margin_abs / top_score  # 0 = empate, 0.15+ = vitória clara
    margin_component = min(1.0, relative_margin / 0.15)

    # 2) Clareza da terça da tônica vencedora — peso 20%
    tc_top = third_clarity(hist, top['root'], top['quality'])
    if tc_top['present']:
        # ratio 0.5 (ambíguo) → 0.0, ratio 1.0 (só uma terça) → 1.0
        third_component = max(0.0, (tc_top['ratio'] - 0.5) * 2.0)
    else:
        third_component = 0.0  # sem terça = sem certeza maj/min

    # 3) Material disponível — peso 10%
    # 4+ notas E 1+ frase já dá material razoável em clips curtos
    notes_saturation = min(1.0, len(notes) / 4.0)
    phrases_saturation = min(1.0, len(phrases) / 1.0)
    material_component = 0.5 * notes_saturation + 0.5 * phrases_saturation

    # 4) Alinhamento tonal (TonicAnchor) — peso 20% (foi 10%)
    # Gravidade no centro tonal é o melhor indicador anti-grau-falso
    alignment_component = top['alignment']

    # 5) Cadência — peso 5%
    cadence_component = top['cadence']

    confidence = (
        0.45 * margin_component +       # margem ainda o mais importante
        0.20 * third_component +        # terça clara
        0.20 * alignment_component +    # AUMENTADO — tônica tem que "puxar"
        0.10 * material_component +
        0.05 * cadence_component
    )
    confidence = float(min(1.0, max(0.0, confidence)))

    # ── Flags de auto-diagnóstico ────────────────────────────────────
    flags = []
    if relative_margin < 0.05:
        flags.append('close_call')               # top e runner quase empatados
    if not tc_top['present']:
        flags.append('no_third_evidence')        # nem maj 3ª nem min 3ª no áudio
    elif 0.35 < tc_top['ratio'] < 0.65:
        flags.append('ambiguous_third')          # ambas terças aparecem (dúvida maj/min)
    if len(notes) < 4:
        flags.append('few_notes')                # < 4 notas segmentadas (antes era 6)
    if len(phrases) < 2:
        flags.append('single_phrase')            # só uma frase — cadência não comparável
    if top['cadence'] == 0.0:
        flags.append('no_resolution')            # nenhuma frase termina na tônica
    if runner and is_relative_pair(top, runner):
        close = abs(top['score'] - runner['score']) / max(top['score'], 1e-6)
        if close < 0.10:
            flags.append('relative_ambiguous')    # maj vs rel-min muito próximos
    # NOVO: tônica-top não tem a maior gravidade no histograma → suspeito
    if len(gravity) == 12:
        grav_list = sorted(range(12), key=lambda i: gravity[i], reverse=True)
        if grav_list[0] != top['root']:
            flags.append('weak_tonic_gravity')   # a tônica escolhida não é o centro gravitacional

    # ── PENALIDADES DE HONESTIDADE (v3.1 — reduzidas) ────────────────
    # ANTES: multiplicativa (0.6 × 0.7 × 0.7 = 0.29) — zerava confidence boa
    # AGORA: penalidade máxima por flag, total acumulativo com TETO em 0.45
    penalty = 0.0
    if 'no_third_evidence' in flags:
        penalty = max(penalty, 0.30)   # sem 3ª é sério
    if 'ambiguous_third' in flags:
        penalty = max(penalty, 0.25)
    if 'few_notes' in flags:
        penalty = max(penalty, 0.15)
    if 'single_phrase' in flags and 'close_call' in flags:
        penalty = max(penalty, 0.20)
    if 'relative_ambiguous' in flags:
        penalty = max(penalty, 0.20)
    if 'weak_tonic_gravity' in flags:
        penalty = max(penalty, 0.20)
    # combo tóxico: múltiplas flags ambíguas empilhadas
    ambig_count = sum(1 for f in flags if f in (
        'close_call', 'ambiguous_third', 'relative_ambiguous', 'weak_tonic_gravity'
    ))
    if ambig_count >= 3:
        penalty = min(0.45, penalty + 0.15)
    elif ambig_count >= 2:
        penalty = min(0.40, penalty + 0.08)

    # TETO 0.45 — nunca dampear mais que 45% (confidence 0.80 -> no mínimo 0.44)
    penalty = min(0.45, penalty)
    confidence = confidence * (1.0 - penalty)
    confidence = float(min(1.0, max(0.0, confidence)))

    # Recomendação honesta
    if confidence < 0.35:
        recommendation = 'keep_analyzing'
    elif confidence < 0.60:
        recommendation = 'uncertain_suggest_more_audio'
    else:
        recommendation = 'confident'

    return {
        'tonic': top['root'],
        'tonic_name': NOTE_NAMES_BR[top['root']],
        'quality': top['quality'],
        'key_name': f"{NOTE_NAMES_BR[top['root']]} {'Maior' if top['quality'] == 'major' else 'menor'}",
        'confidence': confidence,
        'confidence_breakdown': {
            'margin': round(margin_component, 3),
            'third': round(third_component, 3),
            'material': round(material_component, 3),
            'alignment': round(alignment_component, 3),
            'cadence': round(cadence_component, 3),
        },
        'flags': flags,
        'recommendation': recommendation,
        'top_candidates': [
            {
                'key': f"{NOTE_NAMES_BR[c['root']]} {'Maior' if c['quality'] == 'major' else 'menor'}",
                'score': round(c['score'], 4),
                'boost': round(c['boost'], 3),
                'third_mul': round(c['third_multiplier'], 3),
                'third_ratio': round(c['third_ratio'], 3),
                'alignment': round(c['alignment'], 3),
                'cadence': round(c['cadence'], 3),
                'ks': round(c['ks'], 3),
            }
            for c in candidates[:5]
        ],
        'histogram': hist.tolist(),
        'gravity': gravity.tolist(),
        'margin_abs': round(margin_abs, 4),
        'margin_relative': round(relative_margin, 4),
    }


def analyze_audio_bytes(audio_bytes: bytes) -> Dict[str, Any]:
    """
    Função pública principal.
    Recebe bytes de áudio → retorna análise completa.
    """
    audio = load_audio_from_bytes(audio_bytes)
    duration_s = len(audio) / SAMPLE_RATE

    if duration_s < 1.5:
        return {
            'success': False,
            'error': 'audio_too_short',
            'message': 'Áudio muito curto. Cante pelo menos 2 segundos.',
            'duration_s': duration_s,
        }

    f0, conf = extract_f0_with_crepe(audio)
    valid_f0_count = int(np.sum(~np.isnan(f0)))

    if valid_f0_count < 20:
        return {
            'success': False,
            'error': 'no_pitch_detected',
            'message': 'Não conseguimos detectar notas claras. Cante mais alto e sustente as notas.',
            'duration_s': duration_s,
            'f0_frames': int(len(f0)),
            'valid_f0_frames': valid_f0_count,
        }

    midi = f0_to_midi(f0)
    notes = segment_notes(midi, conf)
    phrases = detect_phrases(notes)
    key_result = detect_key_from_notes(notes, phrases)

    return {
        'success': True,
        'duration_s': round(duration_s, 2),
        'f0_frames': int(len(f0)),
        'valid_f0_frames': valid_f0_count,
        'notes_count': len(notes),
        'phrases_count': len(phrases),
        'method': f'torchcrepe-{MODEL_CAPACITY}+tonicanchor-v2',
        **key_result,
    }
