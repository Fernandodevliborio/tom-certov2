"""
vocal_instrument_focus.py — Pré-processador para o modo Voz + Instrumento
═══════════════════════════════════════════════════════════════════════════════

Variante de `vocal_focus.py` calibrada para misturas voz + instrumento harmônico
(violão, guitarra, teclado, piano).

Diferenças vs vocal_focus padrão:
  - F0 estendido: 50–1500 Hz (cobre baixo de violão E2 ~82Hz)
  - min_rms menor (instrumentos podem ser mais baixos que voz)
  - max_pitch_std mais tolerante (notas de instrumento + voz oscilam mais)
  - min_note_duration_ms menor (acordes têm ataques mais curtos)
  - Mantém rejeição de percussão IDÊNTICA (bateria/palmas continuam fora)
  - Mantém min_valid_frame_ratio mínimo

Como usar:
    from vocal_instrument_focus import INSTRUMENT_CONFIG
    from vocal_focus import apply_vocal_focus
    result = apply_vocal_focus(audio, f0, conf, config=INSTRUMENT_CONFIG)

Rollback: setar INSTRUMENT_MODE_ENABLED = False em key_detection_v10.py.
═══════════════════════════════════════════════════════════════════════════════
"""

from __future__ import annotations

from vocal_focus import VocalFocusConfig

# Configuração equilibrada para o modo Voz + Instrumento.
# Calibrada para aceitar evidência tonal de instrumentos harmônicos,
# mantendo rejeição rigorosa de ruído percussivo.
INSTRUMENT_CONFIG: VocalFocusConfig = VocalFocusConfig(
    enabled=True,

    # Confiança mínima — um pouco mais baixa que vocal puro,
    # já que instrumentos têm harmônicos que confundem CREPE
    min_frame_confidence=0.35,

    # Notas de instrumento podem ser mais curtas que sílabas vocais
    # (ex: acordes dedilhados dão ataques de 80-100ms)
    min_note_duration_ms=90.0,

    # Estabilidade — instrumentos polifônicos + voz produzem mais oscilação
    # entre as fundamentais; ampliamos a tolerância
    stability_window_frames=7,
    max_pitch_std_semitones=2.2,

    # Energia — instrumentos podem ser bem mais quietos que voz
    min_rms=0.005,
    max_rms=0.98,

    # Rejeição de percussão IDÊNTICA ao vocal_focus (não relaxar isso)
    percussion_onset_drms=0.040,
    percussion_lookahead_frames=8,
    percussion_min_pitch_ratio=0.35,
    percussion_reject_frames=5,

    # Faixa de F0 estendida:
    #   - 50 Hz cobre G1 (fundamental de baixo de violão muito grave)
    #   - 1500 Hz cobre F#6 (notas agudas de teclado)
    f0_min_hz=50.0,
    f0_max_hz=1500.0,

    # Mínimo de frames válidos — exigência um pouco menor que vocal puro
    # (instrumentos ainda dão sinal mesmo com voz fraca/ausente)
    min_valid_frame_ratio=0.06,
)
