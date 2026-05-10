# Relatório Diagnóstico — Tom Certo

**Investigação técnica profunda do pipeline de detecção de tonalidade**
**Data:** 2026-02
**Tipo:** Diagnóstico exclusivamente (sem alterações de código)
**Idioma:** Português (Brasil)

---

## Sumário Executivo

O pipeline atual do Tom Certo é dividido em três camadas: **captura nativa de áudio (`@siteed/audio-studio`)**, **pré-processamento e clip ML no frontend (React Native)** e **decisão tonal acumulada no backend (Python + torchcrepe + Krumhansl)**. Há um motor de YIN local que orienta UI em tempo real e um **acumulador de sessão por dispositivo/modo no servidor** com **máquina de estados controlada por *tempo decorrido*** e **lock pegajoso (sticky-lock)**.

O comportamento percebido pelo usuário (45 s de espera, travas em "Ouvindo…/Analisando…", tom errado com confiança alta, inconsistência entre tonalidades) **não é uma falha pontual; é uma consequência direta de quatro decisões arquiteturais combinadas**:

1. **Janela mínima de 30 s "hardcoded" no backend** antes de qualquer exposição de tom (`SessionAccumulator._current_stage()` em `key_detection_v10.py`, linhas 840–848). Tudo o que o usuário vê antes disso é "Ouvindo…" / "Analisando…" — independentemente da qualidade do sinal.
2. **Sete critérios rigorosos simultâneos** para liberar a decisão (margin, cadence, third_ratio, confidence, !relative, !dominant, consensus). **Qualquer um falhando** → `uncertain` (faixa 30 s+ continua sem mostrar tom). Em condições reais (microfone simples, voz com vibrato), o critério `consensus ≥ 4/10` é o que mais frequentemente atrasa, empurrando a confirmação para 45–90 s.
3. **Sticky-lock irrevogável**: uma vez travado, o backend praticamente nunca solta (precisa de `consensus ≥ 7/10` no novo + `votes_for_locked ≤ 2` para autorizar troca). Se o lock cair em base ruim (sessão contaminada, primeiros 30 s pobres em harmonia), o usuário vê **tom errado a 90–95 % de confiança**, e o frontend trava o `lockedKey` imediatamente sem confrontá-lo com o motor local.
4. **Reset de sessão "fire-and-forget"** entre frontend e backend, com chave de sessão `f"{device_id}::{mode}"` em dicionário in-memory **sem TTL**. Se o reset falha (rede, timeout 5 s, `device_id` vazio no boot), a próxima análise reativa a sessão antiga com `start_time`, `all_notes`, `vote_history` e `locked_*` antigos — eis a contaminação clássica.

A camada de **vocal_focus** filtra clips inteiros antes do motor tonal; quando o áudio é "ruidoso/percussivo" por longos períodos, **o relógio do `SessionAccumulator` continua andando**, mas nada se acumula em `all_notes`. Aos 30 s o backend retorna `uncertain` por insuficiência (`len(all_notes) < 4`) e a UI fica indefinidamente em "Analisando…".

A causa de **inconsistência entre as 24 tonalidades** está no **modelo `tiny` do torchcrepe**, que tem viés de oitava em F0 alto, e nos **perfis Krumhansl-Kessler simétricos demais entre relativa maior/menor** (peso de 3ª deveria dominar a decisão de qualidade, mas o limiar `third_ratio ≥ 0.65 OR ≤ 0.35` deixa passar margens estreitas como decisões "limpas").

A diferença entre **browser, Expo Go, dev build e APK Android** decorre de:
- O fallback **web** não implementa `captureClip` (retorna `null`) → o pipeline ML simplesmente **não funciona em browser**.
- **Expo Go** não tem o módulo nativo `@siteed/audio-studio` — `useAudioRecorder()` retorna handle inválido e o modal de erro "Falha ao inicializar" é exibido.
- **Dev build** funciona mas com Metro/JS slower e logs verbosos.
- **APK release** roda com `audioSource: 'unprocessed'` (Android) e `mode: 'measurement'` (iOS), o que desativa AGC/echo-cancel — em ambientes ruidosos comuns o RMS pode ficar abaixo de `MIN_RMS = 0.010` por janelas longas, alimentando rejeição de vocal_focus em cascata.

**Conclusão executiva:** o app não está perdendo velocidade por bugs isolados; ele está **arquitetonicamente desenhado para esperar 30 s antes de qualquer tom + exigir consenso pesado + nunca soltar lock**. Os sintomas relatados são consequências naturais desse desenho. Ajustes pontuais (reduzir threshold, mudar timeout) **não resolvem** sem revisitar a máquina de estados temporal e o reset transacional do servidor.

---

# APÊNDICE TÉCNICO

## 1. Mapa Completo do Pipeline (Captura → Resultado)

```
[Microfone físico]
   │  (PCM Float32 a 16 kHz, mono, intervalo 100 ms)
   ▼
[@siteed/audio-studio nativo] ──► Permissão (AudioStudioModule.getPermissionsAsync)
   │
   ▼
[usePitchEngine.handleAudioStream(event)]   ◄── linhas 115–247 de usePitchEngine.ts
   │  ├─ Detecta tipo (Float32Array | base64 | ArrayBuffer | number[])
   │  ├─ Calcula RMS amostrado (stride=4)
   │  ├─ Atualiza framesPerSec (janela móvel 1 s)
   │  ├─ Escreve no captureRing (15 s contínuos, capacidade 240 000 samples)
   │  ├─ Escreve no ring YIN (RING_CAPACITY=8192 samples)
   │  └─ A cada FRAME_SIZE=2048 samples (~128 ms) chama runYinOnFrame
   ▼
[yin.ts → yinPitch(frame, 16 kHz)]
   │  ├─ RMS gate: < 0.01 ⇒ retorna -1
   │  ├─ Cumulative mean normalized difference
   │  ├─ Octave validation (anti-octave-down)
   │  ├─ Parabolic interpolation
   │  └─ Retorna {frequency, probability, rms} se 65–1200 Hz e prob≥0.55
   ▼
[useKeyDetection.onPitch(ev)]   ◄── linhas 283–367 de useKeyDetection.ts
   │  ├─ Atualiza lastAudioFrameAtRef e (se voiced) lastValidPitchAtRef
   │  ├─ Filtros: rms ≥ 0.010, clarity ≥ 0.55, freq 65–2000 Hz
   │  ├─ Mediana de pitch class (janela 5 frames)
   │  ├─ Anti-salto de oitava (diff 10–14 ⇒ ±12)
   │  ├─ Commit de nota: ≥4 frames + ≥130 ms ⇒ DetectedNoteEvent
   │  └─ Fechamento de frase: pausa 300 ms | legato 1500 ms | 6 notas + 3500 ms | timeout 10 s
   ▼
[phraseKeyDetector.ingestPhrase(state, phrase)]
   │  └─ Atualiza tonicConfidence e stage (listening | probable | confirmed | definitive)
   │     SOMENTE para UX local — NÃO é a fonte da verdade
   │
   ╠══ Ramo paralelo (loop ML reativo) ══════════════════════════════════════
   │
   ▼
[useEffect ML-LOOP] (linhas 805–854 de useKeyDetection.ts)
   │  Agenda runMLAnalysis():
   │   ├─ idle:    400 ms
   │   ├─ waiting: 800 ms
   │   ├─ done(locked):    6000 ms
   │   ├─ done(!locked):   1500 ms
   │   └─ Re-checka a cada 600 ms via setInterval
   ▼
[runMLAnalysis()]   ◄── linhas 500–611
   │  ├─ Lock anti-concorrência (mlInFlightRef boolean)
   │  ├─ Cria AbortController (cancelável por stop/reset/hardReset)
   │  ├─ engine.captureClip(2000 ms) ⇒ snapshot do captureRing
   │  ├─ Validação: ≥1.2 s de samples ou volta para 'waiting'
   │  ▼
[mlKeyAnalyzer.analyzeKeyML(clip, timeout=12000ms, deviceId, signal, mode)]
   │  ├─ float32ToWav (PCM 16-bit little-endian)
   │  ├─ POST {BACKEND_URL}/api/analyze-key
   │  │     headers: Content-Type: audio/wav
   │  │              X-Device-Id: <id>
   │  │              X-Detection-Mode: vocal | vocal_instrument
   │  │     body: WAV bytes
   │  └─ Timeout interno 12 s; signal externo encadeado
   ▼
[server.py POST /api/analyze-key]   ◄── linhas 742–792
   │  ├─ Valida ≥ 500 bytes
   │  └─ Chama analyze_audio_bytes_v10(audio_bytes, device_id, mode)
   ▼
[key_detection_v10.analyze_audio_bytes_v10]   ◄── linhas 1327–1562
   │  ├─ load_audio (librosa @ 16 kHz, normaliza, RMS gate 0.010)
   │  ├─ extract_pitch (torchcrepe 'tiny', filtro mediano 5)
   │  ├─ vocal_focus.apply_vocal_focus (rejeita percussão/ruído/silêncio)
   │  │    └─ Se rejeita: NÃO alimenta motor; retorna stage corrente do session
   │  ├─ pitch_to_notes (gap≥150 ms = end_phrase; dur≥60 ms; conf≥0.35)
   │  ├─ [vocal_instrument] detect_chords_and_bass + Notes sintéticas
   │  ├─ session = get_session(device_id, mode)
   │  │    └─ AUTO-RESET se >10 s sem chamar add_analysis (linha 812)
   │  ├─ session.add_analysis(notes)  ⇒ all_notes (cap 250) + analysis_count++
   │  ├─ result = session.get_result()
   │  │    ├─ elapsed = now - start_time
   │  │    ├─ <10s: stage='listening' (show_key=False)
   │  │    ├─ <30s: stage='analyzing' (show_key=False, alimenta vote_history)
   │  │    └─ ≥30s: avalia 7 critérios → confirmed (lock) | uncertain
   │  └─ Retorna JSON com noise_rejection + stage_label + show_key + key_name
   ▼
[useKeyDetection (resposta)]   ◄── linhas 571–611
   │  ├─ Aborta tardiamente (controller.signal.aborted) ⇒ descarta resposta
   │  ├─ Atualiza ingestNoiseStage (debounce 1.5 s)
   │  ├─ Sucesso ⇒ setMlResult + setMlState('done') + lastBackendProgressAtRef = now
   │  └─ Falha   ⇒ setMlState('waiting')
   ▼
[index.tsx ActiveScreen useEffect mlResult]   ◄── linhas 516–581
   │  ├─ Se stage='confirmed' && backend_locked=true ⇒ TRAVA lockedKey direto
   │  ├─ Se stage='probable'                          ⇒ passa por processAnalysis (engine local)
   │  └─ visualConfidence = Math.round(conf * 100)
   ▼
[UI mostra]: TOM DETECTADO + chord em tempo real + campo harmônico + barra
```

---

## 2. Arquivos e Funções Envolvidos (com Linhas)

### Frontend
| Arquivo | Função/Trecho | Linhas | Papel |
|---|---|---|---|
| `frontend/src/audio/usePitchEngine.ts` | `usePitchEngine`, `handleAudioStream`, `runYinOnFrame`, `start`, `stop`, `restart`, `getHealth`, `captureClip` | 59–495 | Motor nativo de captura + YIN + ring buffers + watchdog interno |
| `frontend/src/audio/usePitchEngine.web.ts` | `usePitchEngine` (Web Audio API) | 20–149 | Fallback web; `captureClip` retorna null sempre (linha 121–125) |
| `frontend/src/audio/yin.ts` | `yinPitch` | 24–120 | YIN com octave validation + parabolic interpolation |
| `frontend/src/audio/audioLogger.ts` | `audioLog.{info,warn,error}` | 30–44 | Wrapper de console com prefixo `[AudioHealth]` |
| `frontend/src/audio/types.ts` | `PitchEngineHandle`, `AudioEngineHealth`, `CapturedClip` | 1–47 | Contratos |
| `frontend/src/hooks/useKeyDetection.ts` | `useKeyDetection`, `onPitch`, `closePhrase`, `commitCurNote`, `runMLAnalysis`, `start`, `stop`, `reset`, `softReset`, `hardReset`, **Pipeline Health Watchdog** | 132–1108 | Orquestrador completo do pipeline |
| `frontend/src/utils/phraseKeyDetector.ts` | `buildPhrase`, `ingestPhrase`, `createInitialState` | (não inspecionado nesta sessão) | Detecção tonal local (UX) |
| `frontend/src/utils/tonalScorer.ts` | `TemporalBuffer`, `buildWeightedHistogram`, `rankAllKeys`, `agreementMultiplier`, `isInTop3` | (não inspecionado nesta sessão) | Scoring tonal local + redutor de confiança |
| `frontend/src/utils/mlKeyAnalyzer.ts` | `analyzeKeyML`, `resetKeyAnalysisSession`, `float32ToWav` | 247–344 | HTTP client backend |
| `frontend/src/utils/noiseStageDebouncer.ts` | `createNoiseStageDebouncer` | (não inspecionado) | Debounce 1.5 s do `noise_stage` |
| `frontend/src/utils/stableKeyEngine.ts` | `processAnalysis`, `getDisplayKey`, `shouldShowKey`, `incrementVisualConfidence` | (não inspecionado) | Engine de "estabilidade visual" no UI |
| `frontend/app/index.tsx` | `HomeScreen`, `InitialScreen`, `ActiveScreen`, useEffect mlResult, `resetDetectionSession` | 48–1192 | UI + reset combinado FE/BE |

### Backend
| Arquivo | Função/Trecho | Linhas | Papel |
|---|---|---|---|
| `backend/server.py` | `analyze_key` (POST /api/analyze-key) | 742–792 | Recebe WAV, dispara v10 |
| `backend/server.py` | `reset_key_session` (POST /api/analyze-key/reset) | 458–472 | Zera sessão por device+mode |
| `backend/server.py` | `analyze_key_diagnostic` | 667–739 | Endpoint de inspeção (CREPE raw) |
| `backend/key_detection_v10.py` | `load_audio`, `extract_pitch`, `pitch_to_notes` | 129–271 | Pipeline DSP |
| `backend/key_detection_v10.py` | `analyze_tonality`, `_score_tonic_candidate`, `_compute_confidence` | 551–759 | Decisão da tônica e qualidade (Krumhansl + cadence + 3ª) |
| `backend/key_detection_v10.py` | `SessionAccumulator.{add_analysis,_current_stage,get_result,_lock,_should_change}` | 762–1255 | **CORAÇÃO da máquina de estados temporal e do sticky-lock** |
| `backend/key_detection_v10.py` | `_sessions`, `get_session`, `reset_session` | 1258–1284 | Estado global in-memory por `device_id::mode` |
| `backend/key_detection_v10.py` | `analyze_audio_bytes_v10` | 1327–1562 | Função pública chamada pelo server |
| `backend/vocal_focus.py` | `apply_vocal_focus`, `VocalFocusConfig` | 1–447 | Filtragem por frame (RMS / confiança / percussão / instabilidade) |
| `backend/vocal_instrument_focus.py` | `INSTRUMENT_CONFIG` | 1–67 | Configuração mais permissiva para modo voz+instrumento |
| `backend/instrument_chord_detector.py` | `detect_chords_and_bass` | (não inspecionado) | Adiciona evidência harmônica |

---

## 3. Estados Internos e Transições

### 3.1 Estados do `usePitchEngine`
- `activeRef`: bool — recorder rodando
- `isStartingRef`: bool — anti-duplo-clique
- Health: `lastFrameAtRef`, `lastRmsRef`, `fpsLastMeasuredRef`, `streamFrameCountRef`
- Watchdog interno (linha 411–430): a cada 2.5 s, se `now - lastFrameAt > 5000` ⇒ apenas LOG `audio_frame_timeout` (não age — ação fica no hook acima).

### 3.2 Estados do `useKeyDetection`
| Estado | Origem | Significado |
|---|---|---|
| `mlState` | local | `idle | waiting | listening | analyzing | done | error` — controla o loop reativo |
| `recoveryStatus` | local | `idle | restarting | soft_reset | hard_reset` |
| `keyState` (`stage`) | `phraseKeyDetector` | `listening | probable | confirmed | definitive` (UX local) |
| `noiseStage` (debounciado) | backend | `clean | noisy | percussion | silence` |
| `mlInFlightRef` | local | Lock booleano para impedir 2 análises simultâneas |
| `mlAbortControllerRef` | local | Cancelamento da request HTTP (stop/reset/hardReset) |

### 3.3 Estados do `SessionAccumulator` (backend)
| Atributo | Tipo | Significado |
|---|---|---|
| `start_time` | float | Marco temporal — base de toda a máquina de estados |
| `last_activity_time` | float | Auto-reset por inatividade (>10 s sem `add_analysis`) |
| `analysis_count` | int | Contador acumulado |
| `all_notes` | list[Note] | Janela deslizante (cap 250) |
| `vote_history` | list[int] | Últimos 20 votos de tônica para consenso |
| `locked_*` | t/q/conf/at | Tom travado (sticky-lock) |
| `_detection_duration_s` | float | Tempo desde o início até o **primeiro** lock (não atualiza após) |
| `last_result_snapshot` | dict | Para feedback "tom errado" |

### 3.4 Máquina de Estados Temporal (Backend)
```
start_time = 0.0
                                    ┌── analysis_count++ a cada chamada
   t < 10s   →  stage='listening'   │   (não mostra tom; alimenta nada de vote_history)
   t < 30s   →  stage='analyzing'   │   (alimenta vote_history e snapshot, sem expor)
   t ≥ 30s   →  stage='decision'    │
                ├─ all_notes < 4    │   →  uncertain (insufficient)
                ├─ analyze fails    │   →  uncertain (nofit)
                ├─ 7 critérios OK   │   →  confirmed + LOCK
                └─ critérios falham │   →  uncertain (failing_criteria=[...])
```
Após o primeiro `confirmed` + lock:
- `same_as_locked` ⇒ reforça `locked_confidence` (cap em 0.95)
- `overwhelming_switch` ⇒ troca tom (raríssimo)
- caso contrário ⇒ **mantém o tom locked, mesmo que o candidato atual seja melhor**

---

## 4. Pontos de Falha (Onde o App Está Perdendo Velocidade, Precisão e Estabilidade)

### 4.1 Latência média de **45 s** — múltiplas causas somando-se

| # | Componente | Custo (cumulativo) | Evidência (arquivo:linha) |
|---|---|---|---|
| 1 | **Janela mínima 30 s** antes de qualquer "show_key" | **30 s "fixos"** | `key_detection_v10.py:840–848` |
| 2 | Após 30 s, exigência de `consensus ≥ 4/10` → cada análise leva ~3–5 s (clip 2 s + CREPE 1–3 s + rede + interval 1.5 s) | +6–15 s | `key_detection_v10.py:967–969` |
| 3 | torchcrepe `tiny` em CPU ≈ 1.5–3 s para 2 s de áudio | (componente do #2) | `key_detection_v10.py:148–167` |
| 4 | Loop FE inicia primeira análise só após `clip ≥ 1.2 s` (mín 1.2 s no captureRing) | +1.2 s no boot | `useKeyDetection.ts:498` |
| 5 | Se `vocal_focus` rejeitar clip → `clip_rejected=true` mas `start_time` continua andando; relógio chega a 30 s sem `all_notes` suficientes ⇒ `uncertain` ⇒ continua escutando | até +∞ | `key_detection_v10.py:1396–1419, 907–920` |
| 6 | Critério `third_ok` (≥0.65 ou ≤0.35): tonalidades com 3ª ambígua nunca passam | até +∞ | `key_detection_v10.py:961` |
| 7 | Critério `confidence_ok ≥ 0.60`: vozes com vibrato leve raramente atingem 0.60 sem múltiplas frases | +10–30 s | `key_detection_v10.py:963` |
| 8 | RTT de rede em conexão móvel: 200–800 ms × N chamadas | +2–10 s | `mlKeyAnalyzer.ts:281` |
| 9 | Loop em estado `done` re-dispara só a cada **6000 ms** quando locked, **1500 ms** se não locked | + delay entre análises | `useKeyDetection.ts:827` |

**Resultado típico:** 30 s (janela) + 8 s (4 análises × ~2 s cada incluindo CREPE) + 7 s (consenso adicional/rede) ≈ **45 s**. Em condições adversas (microfone fraco, ambiente ruidoso), facilmente passa de **60–90 s** ou nunca confirma.

### 4.2 Trava em **"Ouvindo…"** (~15 s)
- **Causa A — Backend mudo após RESET falho:** O `useEffect` de boot em `index.tsx:52–63` envia POST `/api/analyze-key/reset` com `Content-Type: application/json` mas **sem `X-Device-Id`** (porque `getDeviceId()` ainda não resolveu). O servidor reseta `anon::vocal`, não a sessão real do usuário. A primeira análise real cria uma **nova** sessão se for a primeira vez **OU** reusa uma sessão antiga ainda rodando. Como `start_time` está antigo, podemos passar direto para `stage='analyzing'` ou `'decision'`, alterando a UX esperada.
- **Causa B — Frames não chegam:** Recorder Android pausa silenciosamente ao receber notificação ou ao virar a tela; após 5 s sem frame, watchdog camada B chama `engine.restart()` (`useKeyDetection.ts:904–928`). Durante esses ~5 s + 3 s de grace = **8 s de "Ouvindo…" sem progresso**.
- **Causa C — Permissão limbo:** Em iOS, se o usuário marcou "Permitir uma vez", a sessão de áudio é cortada após o app perder foco. Watchdog detecta, restart pede permissão de novo, usuário vê delay.

### 4.3 Trava em **"Analisando…"** (~30 s+)
- **Causa A — vocal_focus rejeitando todo clip:** Em ambiente com TV/fundo musical/percussão, o filtro pode classificar `stage='noisy'` ou `'percussion'` e descartar todos os clips. Backend retorna stage corrente baseado em `start_time` (anda) mas `all_notes` permanece pequeno → aos 30 s, `len(all_notes) < 4` ⇒ `'uncertain'` indefinido. Frontend mostra "Analisando…" para sempre. **`useKeyDetection.ts` não tem timeout para esse caso** (o watchdog camada D só dispara em 30 s **sem nenhuma resposta de sucesso** — mas `clip_rejected` retorna `success=true` silenciosamente).
- **Causa B — Critérios nunca convergem:** Voz a capela com vibrato amplo e poucas frases gera `confidence < 0.60` repetidamente. Backend retorna `'uncertain'` indefinidamente; UI não tem botão "forçar decisão".

### 4.4 **Tom errado com confiança alta** (90–95 %)
1. **Sticky-lock irrevogável:** `key_detection_v10.py:984–1064` — uma vez travado, troca exige `consensus ≥ 7/10` para o NOVO + `votes_for_locked ≤ 2` para o ANTIGO + `confidence ≥ 0.80` + `margin_ratio ≥ 0.40`. Em sessão contaminada, esses critérios são quase impossíveis.
2. **Confidence cap em 0.95** (`line 994`): a cada análise concordante, sobe geometricamente. **A barra de confiança visual não reflete acerto, reflete persistência do lock.**
3. **Frontend congela `lockedKey` direto** (`index.tsx:540–567`) ao receber `stage='confirmed' && locked=true`. Não confronta com o motor local `phraseKeyDetector` (que poderia estar discordando). `agreementMul` (`useKeyDetection.ts:262–272`) **só funciona** durante o caminho `phraseKeyDetector`, não no caminho ML — o que cria duas verdades concorrentes.
4. **Janela `all_notes` cap 250** (~30–60 s) acumula material antigo. Se o usuário mudou de música ou tom, o backend recalcula sobre histograma misturado. Sticky-lock impede correção mesmo que Krumhansl mude.
5. **Sessão contaminada por reset perdido** (ver item 4.6): o relógio antigo + vote_history antigo lock-am rapidamente em "tom velho" assim que a primeira análise nova chega.

### 4.5 **Inconsistência entre as 24 tonalidades** (12 maiores × 12 menores)
- **Modelo `tiny` do torchcrepe** tem viés conhecido em F0 alto (>500 Hz) e F0 baixo (<100 Hz). Vozes femininas em Si/Dó# Maior tendem a ter octave-up; vozes masculinas em Fá/Mi menor tendem a octave-down. (`key_detection_v10.py:85` `MODEL_CAPACITY = 'tiny'`)
- **Perfis Krumhansl-Kessler:**
  - `KK_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]`
  - `KK_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]`
  - A correlação entre eles compartilha 6/12 elementos com peso semelhante. **Tonalidades relativas (ex: Dó M / Lá m, Sol M / Mi m) ficam dentro da margem de 5–10 % de diferença**, ativando `is_relative_ambiguous = True` (offset 3 ou 9 + margin<0.20) e **bloqueando `confirmed` para sempre**.
- **`third_ok = third_ratio >= 0.65 OR <= 0.35`**: aceita decisão "limpa" se a 3ª maior tem 65 %+ ou 35 %− dos casos. **A faixa 35–65 % é zona morta** → `third_ok = false` → `uncertain`. Para áudio real com vibrato, a 3ª oscila tipicamente em 40–55 %, **caindo na zona morta**.
- **Cadências fracas:** `cadence_ok ≥ 0.15` requer 1+ cadência V→I, IV→I ou II→V→I detectada. Frases curtas/incompletas (típicas de "humming" ou trecho solto) raramente têm cadência detectável → `confirmed` impossível.
- **PCP (Pitch Class Profile)** acumulado por janela móvel de 250 notas tende a "vazar" para enarmônicas em tonalidades com muitos acidentes. Ex: Fá# Maior tem `Si` pouco frequente, mas `Si bemol` (Lá#) pode aparecer por erro de oitava → confunde Krumhansl.

### 4.6 **Contaminação de estado entre detecções**
**Cenário 1 — Reset do servidor falha silenciosamente:**
```
T=0:   FE.start() ⇒ resetKeyAnalysisSession(deviceId, mode)  // fire-and-forget
T=5s:  rede lenta/timeout/network blip ⇒ reset ABORTA (timeout 5s no analyzer:323)
T=6s:  Primeira análise vai para POST /api/analyze-key
T=6s:  Backend get_session(deviceId, mode) ⇒ retorna sessão ANTIGA com start_time=T-180s
T=6s:  elapsed=186s ⇒ stage='decision' ⇒ LOCK ANTIGO retorna instantaneamente
T=6s:  FE recebe key_name="<tom da última sessão>" + locked=true
T=6s:  index.tsx:540–567 trava lockedKey IMEDIATAMENTE
```
Resultado: usuário vê tom da sessão antiga em <1 s, com 90 %+ de confiança falsa.

**Cenário 2 — Auto-reset por inatividade incompleto:**
```
key_detection_v10.py:812: if now - last_activity_time > 10.0 and analysis_count > 0: reset()
```
Mas se a sessão foi criada agora (analysis_count=0) e o ÚLTIMO uso foi há 8 segundos por outro fluxo, o reset NÃO dispara — start_time permanece antigo.

**Cenário 3 — Resposta tardia chega após reset:**
- FE manda análise A, espera. Usuário aperta "Nova Detecção" antes da resposta.
- `mlAbortControllerRef.abort()` dispara — FE descarta a resposta de A.
- **Mas o servidor já processou A e adicionou `notes` ao `vote_history`.** A nova sessão herda esses votos se o reset chegou após A.

**Cenário 4 — Boot com `device_id` ausente:**
```
index.tsx:52–63 useEffect roda no mount com:
  fetch(`${base}/api/analyze-key/reset`, {Content-Type: 'application/json'}) // SEM X-Device-Id
```
- Servidor reseta apenas `anon::vocal` (default). Sessão real do device permanece intacta.

### 4.7 **Diferenças entre browser, Expo Go, Dev build e APK Android**

| Plataforma | Comportamento | Causa |
|---|---|---|
| **Browser (web preview)** | Detecção em tempo real funciona, mas **ML nunca dispara** | `usePitchEngine.web.ts:121–125` retorna `null` em `captureClip` ⇒ `runMLAnalysis` aborta com `ml_clip_unavailable`. `getHealth` retorna sempre `alive=false`. |
| **Expo Go** | `recorder_handle_missing` ⇒ Modal "Falha ao inicializar o gravador" | `@siteed/audio-studio` é módulo nativo custom, não está no Expo Go. `useAudioRecorder()` retorna handle vazio. |
| **Dev build (`expo run:android` / `--dev-client`)** | Funciona, com Metro slower e logs verbosos. | OK, mas tempos podem ser ~10–15 % maiores que release pelo overhead do JS interpreter dev. |
| **APK release Android** | Funciona, mas `audioSource: 'unprocessed'` pode dar RMS mais baixo | `usePitchEngine.ts:330` — alguns OEMs (Xiaomi, Samsung) entregam áudio cru atenuado. RMS abaixo de 0.010 ⇒ YIN gate corta ⇒ "Ouvindo…" sem progresso. |
| **iOS standalone** | `mode: 'measurement'` desliga AGC/echo-cancel | `usePitchEngine.ts:331`. Áudio fica mais cru e fiel, mas em ambiente ruidoso pode ter RMS instável. Background audio session é cortada ao receber notificação. |
| **Foreground/Background Android 14+** | Recorder pausa em background; ao voltar, AppState dispara `start()` | `useKeyDetection.ts:979–1011`. Funciona, mas usuário vê 1–2 s de delay e perde os 30 s do `start_time` (recomeça do zero). |

---

## 5. Métricas e Evidências de Logs

### 5.1 Logs Frontend (prefixo `[AudioHealth]`)
**Eventos disponíveis** (de `audioLogger.ts:5–22`):
- `audio_frame_received` (sampleado 1/100, ou seja, a cada ~10 s)
- `audio_frame_timeout` (5 s sem frame)
- `recorder_started`, `recorder_stopped`, `recorder_restart`, `recorder_restart_done`
- `backend_request_start`, `backend_request_success`, `backend_request_error`, `backend_request_cancelled`, `backend_request_exception`
- `watchdog_restart`, `watchdog_ml_stuck`, `pitch_timeout`, `no_progress_hard_reset`
- `lock_released`, `app_state_changed`, `hard_reset_detection`
- `detection_mode_loaded`, `detection_mode_changed`

**O que está bom:** cobertura horizontal (ciclo de vida + watchdogs + ML).

**Lacunas críticas para diagnóstico:**
- ❌ Não há log de `mlState` transition (idle→listening→analyzing→done) — fica por inferência.
- ❌ Não há log do `stage_label` recebido do backend — difícil correlacionar UX com servidor.
- ❌ `audio_frame_received` é sampleado a cada 100 frames (~10 s); para diagnosticar Android pause silencioso, **deveria logar a cada 10 frames** durante 30 s pós-start e depois afrouxar.
- ❌ Sem **correlation ID** entre request FE e log BE — impossível amarrar uma chamada específica.
- ❌ Sem log de `reset request status` (o reset do boot é fire-and-forget; falhas são invisíveis).
- ❌ Sem log de `ringFilledSamples` quando `captureClip` retorna null por buffer pequeno.
- ❌ Não há log de RTT por chamada `/api/analyze-key`.

### 5.2 Logs Backend
**Eventos disponíveis:**
- `[AnalyzeKey v10] recebeu N bytes dev=XXXX mode=YYY` (server.py:755)
- `[AnalyzeKey v10] ✓ 🔒TRAVADO/⏳analisando mode=... key=... conf=... analyses=... notes=...` (server.py:771–778)
- `[v10] Auto-reset por inatividade (Xs)` (key_detection_v10.py:813)
- `[v10] 🔒 LOCK: <key>` (key_detection_v10.py:1251)
- `[v14.2] TROCA DE TOM autorizada/BLOQUEADA` (linhas 1024–1043)
- `[v10] Notas: [(nome, durMs, END?)...]` (linha 1523)
- `[v10/{mode}] Clip rejeitado por focus: stage=... motivo=...` (linha 1402)
- `[v14] DECISÃO INCERTA aos Xs — failing=[...]` (linha 1126)

**Lacunas:**
- ❌ Não loga `start_time` da sessão a cada chamada (impede ver quando uma sessão velha foi reusada).
- ❌ Não loga `vote_history` na linha do request (só a contagem).
- ❌ Sem snapshot do `all_notes.length` por chamada.
- ❌ Sem timing breakdown (load_audio Xms / extract_pitch Yms / vocal_focus Zms / score Wms).
- ❌ Sem log do `noise_rejection.stage` em chamadas onde NÃO houve rejeição (apenas no `clip_rejected=true`).
- ❌ Sem ID de request — impossível seguir uma chamada do `/reset` ao `/analyze-key`.

---

## 6. Causas-Raiz (Análise Sistêmica)

### Causa-Raiz #1 — Janela temporal "hardcoded" desconectada da qualidade do sinal
**Arquivo:** `key_detection_v10.py:840–848`
A máquina de estados é **puramente cronológica**. O backend não pergunta "tenho material suficiente?" — pergunta "passaram 30 s?". Se em 5 s o sinal já é claríssimo (ex: violão tocando arpejo perfeito de Dó Maior), o usuário **espera 25 s a mais por nada**. Se em 60 s o sinal ainda é insuficiente, o backend nunca confirma.

### Causa-Raiz #2 — Sticky-lock como cláusula de consistência, não como cláusula de qualidade
**Arquivo:** `key_detection_v10.py:984–1064`
O lock foi pensado para "evitar oscilação visual", mas implementado como "lock irrevogável a menos de overwhelming switch". O resultado é que **erros de detecção ficam congelados a 95 % de confiança**, e o usuário não tem como dizer "está errado, recalcule" sem fazer Hard Reset (que destrói o histórico inteiro).

### Causa-Raiz #3 — Reset "fire-and-forget" sem garantia de ordem
**Arquivo:** `useKeyDetection.ts:430` e `index.tsx:52–63`
O reset é assíncrono e pode chegar **depois** da primeira análise. Não há `await` garantido nem fila no backend para "esperar reset terminar antes de aceitar análise". Resultado: race condition garantida em rede lenta.

### Causa-Raiz #4 — Estado global in-memory por device_id sem TTL nem fronteira clara
**Arquivo:** `key_detection_v10.py:1260` (`_sessions: Dict[str, SessionAccumulator]`)
- Sem TTL: sessão de ontem ainda está lá hoje.
- Auto-reset por 10 s de inatividade tem condição `analysis_count > 0` — se a sessão foi recém-criada por outro fluxo, condição não dispara.
- Chave `f"{device_id}::{mode}"` mistura dispositivo com modo — trocar de modo = sessão nova, mas esquecer de limpar o modo antigo deixa-o vivo para sempre.
- Não há "session_id" passado pelo cliente (poderia ser um UUID por sessão de uso, garantindo isolamento).

### Causa-Raiz #5 — vocal_focus rejeita silenciosamente sem timeout no FE
**Arquivo:** `key_detection_v10.py:1396–1419`
Quando vocal_focus rejeita o clip, o backend retorna `success=true` com `clip_rejected=true`. O FE alimenta `lastBackendProgressAtRef` (`useKeyDetection.ts:589`) — **isso é um bug**: rejeições não deveriam contar como "progresso", mas estão contando, **anulando o watchdog camada D (30 s sem progresso)** quando o ambiente é apenas ruidoso. O usuário fica preso indefinidamente em "Analisando…" sem que o app tente recuperação.

### Causa-Raiz #6 — Modelo CREPE `tiny` insuficiente para voz com vibrato
**Arquivo:** `key_detection_v10.py:85`
- `tiny` (~5 MB) é o menor; sacrifica precisão em F0 alto/baixo.
- `CONFIDENCE_THRESHOLD = 0.35` é permissivo, deixa passar muito ruído tonal.
- Filtro mediano de 5 frames + `pitch_to_notes` com `MIN_NOTE_DUR_MS = 60ms` é generoso, captura microflutuações como notas.
- Resultado: PCP bagunçado em tonalidades com 3ª, 6ª e 7ª frequentes em mesma região (ex: Fá# / Si / Mi♭ Maior).

### Causa-Raiz #7 — Frontend tem 2 pipelines tonais concorrentes (local + ML) sem fusão
**Arquivos:** `useKeyDetection.ts` (caminho local via `phraseKeyDetector`) e `index.tsx` (caminho ML via `setStableState`)
- O `phraseKeyDetector` local roda em paralelo, alimenta `keyState`/`agreementMul`, mas **somente o caminho ML decide o que é exibido** (`shouldShowKey`/`getDisplayKey` do `stableKeyEngine`).
- `agreementMul` reduz `liveConfidence` quando local discorda do ML, mas **`liveConfidence` é apenas exibido se `currentKey` veio do caminho local** — quando vem do ML, ignora-se a discordância.
- Resultado: o "voto" do detector local é desperdiçado; ele poderia ser um sanity check valioso.

### Causa-Raiz #8 — Diferença web vs nativo é ignorada no UI
**Arquivo:** `usePitchEngine.web.ts:121–125`
Em web, `captureClip` sempre retorna `null` com `console.warn`. O `runMLAnalysis` no FE detecta isso e fica em `'waiting'` para sempre. Como o UI não diferencia "ML não suportado" de "ML demorando", o usuário em browser vê "Analisando…" eternamente sem entender que **o pipeline ML nem existe no web**.

---

## 7. Anatomia dos Sintomas Específicos

### 7.1 Por que **15 s** de espera ocorre
- Caso típico: primeiros 1.2 s para encher o captureRing + 1ª análise (~3 s round-trip) + 2ª análise + 3ª análise dentro da janela 0–10 s **'listening'**. UI mostra "Ouvindo…" todo esse tempo. Aos 10–15 s, transita para 'analyzing'. O número 15 s é o ponto onde o usuário percebe que o app **ainda não começou a tentar achar tom de verdade** (porque até 30 s nada é exibido).

### 7.2 Por que **30 s** de espera ocorre
- Igual ao 15 s, mas o usuário esperou até a transição `analyzing→decision`. Se os 7 critérios passarem em primeira tentativa, vê o tom; senão, continua em "Analisando…" indefinidamente.

### 7.3 Por que **45 s** de espera ocorre
- 30 s da janela + 1–2 ciclos de "uncertain" (tipicamente 7–15 s) até consenso convergir. Em vozes médias com vibrato: ~3 análises adicionais × 5 s = 15 s.

### 7.4 Confiança alta em **tom errado**
- Sticky-lock nunca solta + `locked_confidence` capa em 0.95 + frontend trava `lockedKey` direto. **Não há mecanismo de auto-rejeição** mesmo quando análises subsequentes contradizem o lock.

### 7.5 Diferença maior/menor
- Krumhansl tem ambiguidade conhecida em relativas (offset 3/9 entre tônicas).
- `third_ratio` tem zona morta 35–65 % onde decisão é bloqueada.
- Sem 7ª sensível detectada (raro em humming), maior/menor vira chute.

---

## 8. Como o App Está Perdendo Velocidade (Resumo)

| Fonte de delay | Magnitude | Pode-se reduzir? |
|---|---|---|
| Janela hardcoded 30 s | 30 s | Sim — substituir por máquina baseada em qualidade |
| torchcrepe `tiny` em CPU | 1.5–3 s × N | Sim — usar `small`/`full` em GPU ou warmup |
| Loop reativo: 1.5–6 s entre análises | +5–20 s | Sim — adaptive backoff baseado em qualidade |
| Consenso 4/10 + 7 critérios | +10–30 s | Sim — relaxar critérios em condições claras |
| Vocal_focus rejeições silenciosas | +∞ | Sim — timeout específico para `clip_rejected` recorrente |
| RTT de rede | +200–800 ms × N | Marginal — depende do user |
| Reset assíncrono | até +180 s (sessão antiga) | Sim — reset síncrono ou session_id por uso |

---

## 9. Como o App Está Perdendo Precisão (Resumo)

| Fator | Impacto |
|---|---|
| Modelo CREPE `tiny` | Erros de oitava em F0 extremos → PCP poluído |
| `CONFIDENCE_THRESHOLD = 0.35` | Aceita frames borderline → false notes |
| `MIN_NOTE_DUR_MS = 60ms` | Captura microflutuações como notas |
| `MAX_GAP = 15 frames (150ms)` | Quebra frases em pontos de vibrato/respiração |
| Janela `all_notes` cap 250 (30–60 s) | Mistura material musical antigo com novo |
| Krumhansl-Kessler simétrico em relativas | 50 % de chance de errar maior/menor sem 3ª/cadência |
| `third_ratio` zona morta 35–65 % | Decisão de qualidade bloqueada em casos comuns |
| Sticky-lock irrevogável | Cristaliza erros iniciais |
| Sem fusão FE local + BE | Voto local descartado |

---

## 10. Como o App Está Perdendo Estabilidade (Resumo)

| Fator | Impacto |
|---|---|
| `_sessions` global sem TTL | Memória cresce indefinidamente; sessões fantasma |
| Reset fire-and-forget | Race conditions em rede lenta |
| Boot reset sem `device_id` | Reseta a sessão errada |
| AppState recovery reseta `start_time` | Usuário "perde" os 30 s anteriores |
| Vocal_focus alimenta `lastBackendProgressAtRef` em rejeições | Watchdog 30 s nunca dispara em ambiente ruidoso |
| Web sem captureClip | UX confusa (parece ML rodando, mas não está) |
| Expo Go sem módulo nativo | Erro genérico "Falha ao inicializar" |
| Watchdog FE pode chamar `restart()` em loop | 5 s timeout + 3 s grace = ~8 s de blackout |

---

## 11. Dependências Funcionais Críticas

```
┌───────────────────────────────────────────────────────────┐
│ MICROFONE                                                 │
│  ↓ depende de: permissão OS, audioSource (Android),       │
│                 audioSession (iOS), foreground            │
└───────────────────────────────────────────────────────────┘
            ↓
┌───────────────────────────────────────────────────────────┐
│ PITCH NATIVO (YIN)                                        │
│  ↓ depende de: RMS ≥ 0.010, freq 65–1200 Hz, prob ≥ 0.55 │
└───────────────────────────────────────────────────────────┘
            ↓
┌───────────────────────────────────────────────────────────┐
│ NOTAS LOCAIS (commitCurNote)                              │
│  ↓ depende de: ≥4 frames, ≥130 ms, mediana estável       │
└───────────────────────────────────────────────────────────┘
            ↓
┌───────────────────────────────────────────────────────────┐
│ FRASES LOCAIS (closePhrase)                               │
│  ↓ depende de: gap ≥300 ms | legato ≥1.5s | 6 notas+3.5s│
└───────────────────────────────────────────────────────────┘
            ↓
┌─── Ramo paralelo ────────────────────────────────────────┐
│ CAPTURE CLIP (15 s ring)                                 │
│  ↓ depende de: ringFilled ≥ 1.2 s                        │
└───────────────────────────────────────────────────────────┘
            ↓
┌───────────────────────────────────────────────────────────┐
│ HTTP /api/analyze-key                                     │
│  ↓ depende de: rede, cabeçalhos device_id+mode,           │
│                 reset prévio bem-sucedido                 │
└───────────────────────────────────────────────────────────┘
            ↓
┌───────────────────────────────────────────────────────────┐
│ BACKEND v10                                               │
│  ↓ load_audio (RMS≥0.010)                                 │
│  ↓ extract_pitch (CREPE tiny, conf≥0.35)                  │
│  ↓ vocal_focus (RMS, conf, percussão, instabilidade)      │
│  ↓ pitch_to_notes (dur≥60ms, gap≥150ms)                  │
│  ↓ session = get_session(device_id, mode)                 │
│  ↓ session.add_analysis(notes)                            │
│  ↓ session.get_result() → stage por TEMPO                 │
└───────────────────────────────────────────────────────────┘
            ↓
┌───────────────────────────────────────────────────────────┐
│ DECISÃO ≥30s                                              │
│  ↓ AND(margin≥.25, cadence≥.15, third clean,             │
│        conf≥.60, !relative, !dominant, consensus≥4/10)    │
│  → confirmed (lock pegajoso) | uncertain (silêncio UX)    │
└───────────────────────────────────────────────────────────┘
            ↓
┌───────────────────────────────────────────────────────────┐
│ FRONTEND ActiveScreen                                     │
│  ↓ stage='confirmed' && locked → trava lockedKey direto   │
│  ↓ stage='probable'           → processAnalysis local     │
│  ↓ Demais stages              → "Analisando…"              │
└───────────────────────────────────────────────────────────┘
```

---

## 12. Plano de Ação por Fases (Sem Implementação Agora)

### Fase 1 — Estabilização Imediata (1–2 dias) — risco baixo
**Objetivo: parar de mostrar tom errado com 95 % de confiança e parar travas eternas em "Analisando…".**

1. **Bug do `lastBackendProgressAtRef` em rejeições** (`useKeyDetection.ts:589`):
   - **Problema:** rejeições do vocal_focus contam como "progresso", anulando o watchdog 30 s.
   - **Ação proposta:** atualizar `lastBackendProgressAtRef` somente quando `result.show_key === true` ou `result.stage in {confirmed, probable}` (não em `clip_rejected`/`uncertain`/`listening`/`analyzing`).
2. **Reset síncrono no botão "Iniciar Detecção"**:
   - **Problema:** reset assíncrono pode chegar depois da primeira análise.
   - **Ação proposta:** `await resetKeyAnalysisSession(...)` antes do `engine.start()`. Adicionar timeout de 2 s e proceder mesmo em falha (com log de aviso visível ao usuário).
3. **Reset do boot com device_id correto**:
   - **Problema:** `index.tsx:52–63` chama reset sem `X-Device-Id`.
   - **Ação proposta:** aguardar `getDeviceId()` antes do reset; ou enviar reset apenas após o primeiro `start()`.
4. **Tom errado: botão "Recalibrar" no UI** (sem destruir ring buffer):
   - **Problema:** o botão atual é "Nova Detecção" que faz hard reset destrutivo.
   - **Ação proposta:** botão adicional que chama apenas `resetKeyAnalysisSession` + `softReset` no FE, mantendo `captureRing` (15 s já capturados). UX: "Esse não é o tom — recalibrar".
5. **Logs faltantes** (mínimo viável para debugar produção):
   - Adicionar `[v10] start_time=X.X elapsed=Y.Y` em cada chamada `analyze_audio_bytes_v10`.
   - Adicionar `audioLog.info('ml_state_transition', {from, to})` em cada `setMlState`.
   - Adicionar `[v10] timing: load=Xms crepe=Yms focus=Zms score=Wms` em cada chamada.
   - Adicionar log do `vote_history` (lista) na decisão.

### Fase 2 — Reduzir Latência (3–5 dias) — risco médio
**Objetivo: chegar abaixo de 15 s em 80 % dos casos claros.**

1. **Substituir janela cronológica por janela por evidência** (refactor da `_current_stage`):
   - Trocar `elapsed < 30s` por: "tem ≥ 25 notas + ≥ 3 frases + ≥ 8 análises". Manter um *floor* mínimo de 5 s para evitar decisões prematuras.
   - Stage `analyzing` só termina quando consenso atinge 3/5 (não 4/10) E confiança ≥ 0.55.
2. **Adaptive backoff do loop ML**:
   - Quando `mlResult.confidence > 0.7` por 2 análises seguidas, aumentar delay (já existe, mas começar antes).
   - Quando vocal_focus rejeita 3 clips seguidos, reduzir frequência (1 análise / 5 s) e mostrar UI "ambiente ruidoso" mais cedo.
3. **CREPE `small` em CPU** (~2× mais lento que `tiny`, mas precisão muito melhor) ou warmup do `tiny` em background:
   - Avaliar se `small` cabe no orçamento de tempo (~3–6 s por clip de 2 s em CPU médio).
   - Alternativa: GPU/Apple Silicon backend já suporta MPS — testar.
4. **Captura de clip mais curta (1 s) para primeira análise**:
   - Já está em 2 s; testar 1 s para 1ª análise (warmup), aumentar para 2 s nas seguintes.

### Fase 3 — Eliminar Sticky-Lock e Contaminação (3–5 dias) — risco alto
**Objetivo: zero contaminação cruzada; lock revogável de forma sensata.**

1. **Session-ID por uso (UUID gerado no `start()`)**:
   - Frontend gera UUID v4 a cada `start()`, envia em header `X-Session-Id`.
   - Backend usa `f"{device_id}::{mode}::{session_id}"` como chave.
   - Garbage collect sessões inativas há > 5 min em background task.
2. **Lock revogável em janela deslizante**:
   - Em vez de `votes_for_locked ≤ 2` (quase impossível), usar: "se nas últimas 6 análises o lock só ganhou em ≤ 2, e o novo candidato ganhou em ≥ 4, troca".
   - Adicionar "vida útil" do lock: após 60 s da última confirmação, lock vira "candidato" e pode ser desafiado mais facilmente.
3. **Fusão FE local ↔ BE ML**:
   - Backend retorna top-3 candidatos com scores absolutos.
   - FE compara com `phraseKeyDetector` local; se discordância > 50 %, **reduz confiança visual** e permite reanálise automática.

### Fase 4 — Precisão Tonal (5–10 dias) — risco alto, alto impacto
**Objetivo: consistência ≥ 90 % nas 24 tonalidades em condições controladas.**

1. **Decidir maior/menor por evidência cumulativa, não threshold único**:
   - Substituir `third_ratio` pelo **Bayes ratio** entre presença de 3ª maior + 7ª sensível (maior) versus 3ª menor + 7ª menor + 6ª aumentada (menor).
   - Adicionar peso para cadência V→i (menor) vs V→I (maior).
2. **Resolver ambiguidade relativa com cadência ponderada**:
   - Em offset 3/9 (relativas), avaliar **onde frases terminam mais frequentemente** (cadence_weight) — é o critério musical correto.
3. **Modelo melhor**: avaliar `crepe small`/`full`, ou `BasicPitch (Spotify)` para POLIFONIA, ou rede própria leve treinada em vozes.
4. **PCP por janela curta + voto majoritário**:
   - Em vez de 1 PCP de 250 notas, calcular PCP em janelas de 5 s e votar.
   - Reduz contaminação por mudança de seção.

### Fase 5 — Resiliência e Plataformas (2–3 dias) — risco baixo
1. **Web pipeline ML**: implementar `captureClip` no `usePitchEngine.web.ts` usando `MediaRecorder` ou `AudioWorklet` para snapshot dos últimos 15 s.
2. **Expo Go fallback**: detectar ausência de `@siteed/audio-studio` e mostrar mensagem clara "Use o app instalado para detecção de tom" em vez de erro genérico.
3. **Android `audioSource: 'voice_recognition'` como fallback** se RMS < 0.010 por 5 s consecutivos com `'unprocessed'`.
4. **iOS background recovery**: pré-aquecer a sessão de áudio antes de reabrir; salvar `start_time` em AsyncStorage para recovery após bg.

### Fase 6 — Observabilidade (paralelo a tudo)
1. Correlation ID FE↔BE em todos os logs.
2. Request-level timing (FE: clip_capture, http_total, http_response_size; BE: load, crepe, focus, score, total).
3. Endpoint `/api/analyze-key/debug?device_id=X` que retorna estado da sessão atual (start_time, all_notes counts, vote_history, locked_*).
4. Dashboard simples com taxa de `confirmed/uncertain` por dispositivo, tempo médio até confirmar, top tonalidades detectadas e tempos médios.

---

## 13. Recomendações Operacionais Antes da Refatoração

1. **Não mexer em `MIN_NOTE_DUR_MS`, `CONFIDENCE_THRESHOLD`, `MAX_GAP` isoladamente.** Esses parâmetros estão no caminho crítico do PCP e do consenso; mudanças pontuais cascateiam imprevisivelmente em consequência das demais decisões arquiteturais.
2. **Mensurar antes de otimizar.** Adicionar logs de timing por componente (Fase 1 item 5) é pré-requisito para qualquer ajuste de performance — sem isso, otimização é cega.
3. **Reproduzir em ambiente controlado.** Gravar 24 amostras (12 maiores + 12 menores) a capela em sala silenciosa e usá-las como golden set para regressão antes de qualquer refactor.
4. **Não confundir "lock" com "decisão".** Hoje o backend mistura ambos. A próxima arquitetura deve diferenciar:
   - **Decisão atual** (a cada chamada): qual o tom mais provável agora?
   - **Decisão estável** (com histerese): qual o tom que persistiu pelas últimas N análises com qualidade Q?
5. **Web e nativo devem ter pipelines explicitamente diferentes na UI.** Em web, mostrar "Modo simples (sem ML)" com detecção apenas pelo motor local.

---

## Anexo A — Trechos de Código Relevantes (para Reproduzir o Diagnóstico)

### A.1 Janela hardcoded 30 s (`key_detection_v10.py`)
```python
# linha 840–848
elapsed = time.time() - self.start_time
return {
    'elapsed_s': round(elapsed, 1),
    'stage': (
        'listening' if elapsed < 10.0
        else 'analyzing' if elapsed < 30.0
        else 'decision'
    ),
}
```

### A.2 Sticky-lock irrevogável (`key_detection_v10.py:1015–1023`)
```python
new_consensus = sum(1 for v in self.vote_history[-10:] if v == result.tonic)
overwhelming_switch = (
    all_ok
    and new_consensus >= 7
    and result.confidence >= 0.80
    and ambiguity['margin_ratio'] >= 0.40
    and votes_for_locked <= 2
)
```

### A.3 Reset fire-and-forget no boot (`index.tsx:52–63`)
```javascript
useEffect(() => {
  const base = (process.env.EXPO_PUBLIC_BACKEND_URL as string) ?? '';
  if (!base) return;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10000);
  fetch(`${base}/api/analyze-key/reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },  // ← SEM X-Device-Id
    signal: ctrl.signal,
  }).catch(() => {}).finally(() => clearTimeout(t));
  return () => { ctrl.abort(); clearTimeout(t); };
}, []);
```

### A.4 Lock visual no FE em "confirmed+locked" sem confronto (`index.tsx:540–567`)
```javascript
if (stage === 'confirmed' && backendLocked) {
  setStableState(prev => {
    if (prev.lockedKey && prev.lockedKey.tonic === tonic && prev.lockedKey.quality === quality) return prev;
    // ...
    return {
      ...prev,
      internalStage: 'locked',
      // ...
      lockedKey: { tonic, quality, keyName, lockedAt: Date.now(), confidence: conf, totalAnalyses: ..., stabilityScore: 0 },
      visualConfidence: Math.round(conf * 100),
    };
  });
  return;
}
```

### A.5 Bug do `lastBackendProgressAtRef` em rejeições silenciosas (`useKeyDetection.ts:580–595`)
```javascript
if (result.success) {
  // ...
  lastBackendProgressAtRef.current = Date.now();   // ← também atualiza em clip_rejected
  setMlResult(result);
  setMlState('done');
}
```

### A.6 Fallback web sem captureClip (`usePitchEngine.web.ts:121–125`)
```javascript
const captureClip = useCallback(async (_durationMs: number) => {
  console.warn('[captureClip.web] Web não suporta captureClip - usando versão errada do hook!');
  return null;
}, []);
```

---

## Anexo B — Resumo dos Números

| Parâmetro | Valor atual | Onde |
|---|---:|---|
| Sample rate | 16 000 Hz | usePitchEngine.ts:29, key_detection_v10.py:82 |
| Frame YIN | 2048 samples (128 ms) | usePitchEngine.ts:30 |
| Stream interval nativo | 100 ms | usePitchEngine.ts:31 |
| Ring YIN | 8192 samples (512 ms) | usePitchEngine.ts:33 |
| Capture ring | 15 s = 240 000 samples | usePitchEngine.ts:77–78 |
| YIN min/max freq | 65 / 1200 Hz | yin.ts:14–15 |
| YIN clarity gate | ≥ 0.55 | yin.ts:13 |
| FE RMS gate | ≥ 0.010 | useKeyDetection.ts:50 |
| FE clarity gate | ≥ 0.55 | useKeyDetection.ts:51 |
| Median window pitch | 5 frames | useKeyDetection.ts:52 |
| Min commit frames | 4 | useKeyDetection.ts:55 |
| Min note dur (FE) | 130 ms | useKeyDetection.ts:56 |
| Voiced gap | 300 ms | useKeyDetection.ts:59 |
| Legato sustain | 1500 ms | useKeyDetection.ts:60 |
| Long phrase | 6 notas + 3500 ms | useKeyDetection.ts:61–62 |
| Safety phrase timeout | 10 000 ms | useKeyDetection.ts:63 |
| ML capture duration | 2000 ms | useKeyDetection.ts:497 |
| ML min clip | 1.2 s = 19 200 samples | useKeyDetection.ts:498 |
| Watchdog tick | 1 s | useKeyDetection.ts:42 |
| Audio frame timeout | 5 s | useKeyDetection.ts:43 |
| Pitch valid timeout | 10 s | useKeyDetection.ts:44 |
| No-progress hard reset | 30 s | useKeyDetection.ts:45 |
| ML stuck timeout | 18 s | useKeyDetection.ts:46 |
| Post-restart grace | 3 s | useKeyDetection.ts:47 |
| ML loop delay (idle) | 400 ms | useKeyDetection.ts:823 |
| ML loop delay (waiting) | 800 ms | useKeyDetection.ts:824 |
| ML loop delay (done locked) | 6000 ms | useKeyDetection.ts:827 |
| ML loop delay (done unlocked) | 1500 ms | useKeyDetection.ts:827 |
| HTTP timeout | 12 000 ms | mlKeyAnalyzer.ts:249 |
| Reset HTTP timeout | 5 000 ms | mlKeyAnalyzer.ts:324 |
| BE CREPE model | tiny | key_detection_v10.py:85 |
| BE confidence threshold | 0.35 | key_detection_v10.py:93 |
| BE min note dur | 60 ms | key_detection_v10.py:94 |
| BE min RMS | 0.010 | key_detection_v10.py:95 |
| BE max gap entre notas | 150 ms (15 frames) | key_detection_v10.py:191 |
| BE F0 range | 65–1000 Hz | key_detection_v10.py:86–87 |
| BE all_notes cap | 250 notas | key_detection_v10.py:823 |
| BE vote_history cap | 20 | key_detection_v10.py:890 |
| Stage 'listening' até | 10 s | key_detection_v10.py:844 |
| Stage 'analyzing' até | 30 s | key_detection_v10.py:845 |
| Stage 'decision' a partir | 30 s | key_detection_v10.py:846 |
| Critério margin_ratio | ≥ 0.25 | key_detection_v10.py:956 |
| Critério cadence | ≥ 0.15 | key_detection_v10.py:958 |
| Critério third_ratio | ≥ 0.65 ou ≤ 0.35 | key_detection_v10.py:961 |
| Critério confidence | ≥ 0.60 | key_detection_v10.py:963 |
| Critério consensus | ≥ 4/10 | key_detection_v10.py:969 |
| Sticky switch consensus | ≥ 7/10 | key_detection_v10.py:1019 |
| Sticky switch confidence | ≥ 0.80 | key_detection_v10.py:1020 |
| Sticky switch margin | ≥ 0.40 | key_detection_v10.py:1021 |
| Sticky old votes | ≤ 2 | key_detection_v10.py:1022 |
| Auto-reset por inatividade | > 10 s sem add_analysis | key_detection_v10.py:812 |
| Min `_should_change` time since lock | 4 s | key_detection_v10.py:1204 |
| Locked confidence cap (same lock) | 0.92 (em _should_change) / 0.95 (em get_result) | key_detection_v10.py:1198, 994 |

---

**Fim do relatório.**
*Documento somente diagnóstico — nenhuma alteração de código foi realizada nesta sessão.*
