# RCA — Detecção de Tom Quebrada

Data: 2026-02
Reporter: Usuário
Bug: Cantou em **SOL MAIOR** → sistema detectou **LÁ MAIOR**

---

## 1. Mapa do sistema (pipeline completo)

```
[Áudio do microfone do celular]
        │ (WAV/M4A/AAC, sr nativo do device, mono ou stereo)
        ▼
[Frontend] expo-av grava chunk → POST /api/analyze-key (body raw)
        │
        ▼
┌───────────────────────────────────────────────────┐
│ BACKEND key_detection_v10.py — pipeline           │
├───────────────────────────────────────────────────┤
│                                                   │
│  ① load_audio(bytes)                              │
│     └─ librosa.load(tmp.audio, sr=16000)          │
│         (resample para 16kHz, mono, normalizado)  │
│     └─ retorna y: np.ndarray, has_audio: bool     │
│                                                   │
│  ② extract_pitch(y)                               │
│     └─ torchcrepe.predict(model='tiny',           │
│          F0_MIN=65, F0_MAX=1000, hop=10ms)        │
│     └─ filtra com confiança ≥ 0.35                │
│     └─ retorna f0[ms] em Hz e confiança[ms]       │
│                                                   │
│  ③ pitch_to_notes(f0, conf)                       │
│     └─ converte Hz → MIDI: m = 69 + 12*log2(f/440)│
│     └─ pitch_class = round(m) % 12                │
│     └─ agrupa frames consecutivos com mesmo pc    │
│     └─ MAX_GAP=15 frames (150ms) → fim de frase   │
│     └─ MIN_NOTE_DUR_MS=60ms                       │
│     └─ retorna List[Note]                         │
│                                                   │
│  ④ analyze_tonality(notes)                        │
│     └─ a) phrase_end_score[12]   (peso 35%)       │
│     └─ b) duration_score[12]     (peso 25%)       │
│     └─ c) krumhansl_score[12]    (peso 40%)       │
│         · scores_24[(root, major/minor)]          │
│         · correlação Pearson com perfis KK        │
│     └─ final_score = 0.35a + 0.25b + 0.40c        │
│     └─ ANTI-CONFUSÃO etapa A (KS-anchored swap)   │
│     └─ ANTI-CONFUSÃO etapa B (top-anchored)       │
│     └─ Âncora duração (+0.15 bonus se diferente)  │
│     └─ DECISÃO maior/menor:                       │
│         · scores_24[(winner, major)] vs (minor)   │
│         · graus 3ª + 7ª + 6ª como tiebreaker      │
│                                                   │
│  ⑤ SessionAccumulator.add_chunk()                 │
│     └─ acumula notas (janela 250)                 │
│     └─ chama analyze_tonality                     │
│     └─ aplica _should_lock / _should_change       │
│     └─ retorna {tonic, quality, locked, ...}      │
│                                                   │
└───────────────────────────────────────────────────┘
        │
        ▼
[Frontend stableKeyEngine.ts]
   - Hits + confidence ≥ 0.35 → trava localmente
   - MIN_HITS_FOR_LOCK = 2
   - ATUAL: backend retorna 0.30 nos primeiros 4 chunks p/ travar lock prematuro
```

---

## 2. Análise musical do erro reportado

**Sol Maior** vs **Lá Maior**:

| Aspecto | Sol Maior | Lá Maior |
|--------|--------|--------|
| Tônica (pitch class) | Sol = 7 | Lá = 9 |
| Diferença | — | +2 semitons (2ª maior) |
| Escala | Sol Lá Si Dó Ré Mi Fá# | Lá Si Dó# Ré Mi Fá# Sol# |
| Notas exclusivas a Sol Maior | **Dó natural**, **Sol natural** | — |
| Notas exclusivas a Lá Maior | — | **Dó#**, **Sol#** |

**Conclusão musical:** essa NÃO é uma confusão tonal natural. As escalas têm sobreposição parcial (Lá-Si-Ré-Mi-Fá# em comum), mas as notas-chave que distinguem (Dó vs Dó#, Sol vs Sol#) são ANTAGÔNICAS. Se o cantor realmente cantou Sol Maior, deveria haver:
- **Dó natural** (não Dó#) → Krumhansl Lá Maior penaliza
- **Sol natural** (não Sol#) → Krumhansl Lá Maior penaliza

Para Krumhansl reportar Lá Maior, o áudio teria que conter **Dó# e Sol#** efetivamente. Logo: ou o áudio realmente tem Dó# e Sol# (cantor desafinou +2 semitons), OU **o pipeline está distorcendo as frequências**.

---

## 3. Hipóteses ranqueadas por probabilidade

### H1 — Pitch shift estrutural na captura/transporte (★★★★★ — MAIS PROVÁVEL)

**Mecanismo:** se o áudio é gravado a sample rate X mas interpretado como sample rate Y (Y > X), todos os pitches ficam multiplicados por Y/X. Para shift de +2 semitons:
- 2 semitons = 2^(2/12) ≈ 1.1225
- Exemplo: gravado a 44100 Hz interpretado como 49500 Hz

**Onde pode acontecer:**
- Frontend: `expo-av` grava em sr nativo do device (geralmente 44100 ou 48000), formato `.m4a/.aac`
- Backend: `librosa.load(file, sr=16000)` — pede resampling para 16k
- Se `librosa` falhar em ler o sample rate original do arquivo (ex: arquivo M4A sem cabeçalho válido, ou arquivo `.wav` com cabeçalho corrompido), pode default para 22050 Hz e resamplear errado → SHIFT DE PITCH

**Por que o hino MP3 da Vanessa Ferreira funcionou:** MP3 sempre tem sample rate explícito no cabeçalho. Áudio do app pode não ter (arquivo PCM raw sem WAV header, ou WAV com header questionável).

**Como confirmar:**
- Pedir ao usuário um áudio gravado pelo app em Sol Maior
- Inspecionar o arquivo: `ffprobe`/`soxi`/`librosa.get_samplerate`
- Se o sample rate detectado não bate com o real → pitch shift confirmado

### H2 — Bug de agregação favorecendo a 2ª da escala (★★)

**Mecanismo:** se o cantor canta Sol Maior mas faz frases que repousam em Lá (ex: "Lá-Sol-Lá-Sol" insistente), o phrase_end_score pode dar peso indevido a Lá. No entanto:
- Krumhansl com peso 40% deveria detectar Sol como tônica (correlação superior)
- Se Krumhansl está SENDO usado mas perdendo, há bug nos pesos

### H3 — Sintetização de pitch errada (★)

**Mecanismo:** CREPE pode falhar em vibrato pesado, gritos altos ou sussurros. Mas erro consistente de +2 semitons é raríssimo.

### H4 — Cantor afinado +2 semitons sem perceber (★)

**Mecanismo:** o usuário pensa que cantou Sol mas a primeira nota foi Lá (oitava errada do referência). Improvável se ele tem ouvido absoluto ou afinador.

---

## 4. Próximos passos OBRIGATÓRIOS antes de tocar em código

1. **Obter o áudio real** que o usuário gravou em Sol Maior (.wav/.m4a do app)
2. Inspecionar metadados do arquivo: sample rate, formato, duração, RMS
3. Reprocessar pelo pipeline manualmente:
   - Como o `librosa.load` interpreta o arquivo
   - Histograma das pitch_classes detectadas pelo CREPE
   - Análise de Krumhansl puro vs final_score
4. **SE H1 confirmada** → corrigir o transporte/parse de áudio (raiz do problema)
5. **SE H2 confirmada** → reescrever a parte de scoring/decisão (raiz do problema)
6. **NUNCA** ajustar parâmetros sem evidência empírica

---

## 5. Princípio inegociável

Se o backend não tem evidência forte sobre o tom, o frontend deve mostrar **"Ouvindo..."** (não um tom errado). Esse princípio JÁ está implementado pela proteção anti-lock-prematuro (confidence=0.30 retornado nos primeiros 4 chunks ambíguos), mas **não resolve a raiz** se o áudio chegando ao backend está distorcido.

Resolver na raiz é OBRIGATÓRIO.
