# Tom Certo v2 — Product Requirements

## Visão Geral
App mobile (Expo) para detecção de tonalidade de voz a capela em tempo real.
Backend Python com CREPE (torchcrepe) para extração F0 e lógica tonal madura portada do frontend TS.

## Modo Voz + Instrumento (NOVO — 2026-02-09)

Segundo modo de detecção, **adicionado sem alterar o modo Voz/A capela**.

### Arquitetura
- `/app/backend/vocal_instrument_focus.py` — `INSTRUMENT_CONFIG` (variante mais permissiva: F0 50–1500Hz, min_rms menor, mantém rejeição de percussão idêntica)
- `/app/backend/instrument_chord_detector.py` — chroma CQT + 24 templates (12 maj + 12 min) + bass-note via FFT banda 50-200Hz
- `/app/backend/key_detection_v10.py` — parâmetro `mode='vocal'|'vocal_instrument'`; sessões isoladas via chave `f"{device}::{mode}"`; rollback via `INSTRUMENT_MODE_ENABLED`
- `/app/backend/server.py` — header `X-Detection-Mode` (default `vocal`); valor inválido cai em `vocal`
- `/app/frontend/src/utils/detectionMode.ts` — persistência AsyncStorage
- `/app/frontend/src/components/DetectionModeSelector.tsx` — card colapsado expansível, posicionado abaixo do CTA
- `/app/frontend/src/hooks/useKeyDetection.ts` — `detectionMode` + `setDetectionMode` (dispara hardReset automático)
- `/app/frontend/src/utils/mlKeyAnalyzer.ts` — envia header + tipa `instrument_evidence` na resposta

### Fluxo do modo vocal_instrument
1. `apply_vocal_focus(config=INSTRUMENT_CONFIG)` → aceita instrumentos sem perder rejeição de percussão
2. `detect_chords_and_bass(audio)` → lista de detecções (chord_pc, chord_quality, bass_pc, strength) por janela de 500ms
3. Acordes consecutivos com mesmo root viram **Note sintética** (PC root + duração proporcional + alta confiança)
4. Bass dominante vira outra Note (oitava 2)
5. Tudo alimenta o motor tonal existente (`pitch_to_notes` → `session.add_analysis`)
6. Hysteresis do `SessionAccumulator` já existente protege troca de tom

### Rollback
```python
# /app/backend/key_detection_v10.py
INSTRUMENT_MODE_ENABLED: bool = False  # ⇒ servidor força mode='vocal' em tudo
```

### Resposta API (modo `vocal_instrument`)
```json
{
  "mode": "vocal_instrument",
  "noise_rejection": {...},
  "instrument_evidence": {
    "chords": [{"pc": 0, "quality": "major", "dur_ms": 1500, "strength": 0.83, "start_s": 0.5}],
    "bass_notes": [{"pc": 0, "dur_ms": 1050, "strength": 0.42, "start_s": 0.5}]
  }
}
```

### Logs estruturados (`[InstrMode]`)
`modo_ativo`, `frames_vocais_aceitos`, `frames_instrumentais_aceitos`, `frames_rejeitados_ruido`, `acordes_detectados`, `notas_baixo_detectadas`, `motivo_rejeicao`, `tonalidade_final`, `confianca_final`, `tom_protegido_por_hysteresis`, `troca_de_tonalidade`.

### Testes (22/22 passando)
- `tests/test_vocal_focus.py` (10) — regressão modo vocal
- `tests/test_vocal_instrument_focus.py` (6) — INSTRUMENT_CONFIG: bass E2, violão D3, C6, percussão rejeitada, silêncio rejeitado
- `tests/test_instrument_chord_detector.py` (6) — detecta C major, A minor, ruído branco não gera, performance <2s

## Pipeline Health Watchdog (2026-02-08)

Sistema completo de auto-recuperação para impedir o estado zumbi "Ouvindo..." infinito.

### Camadas
1. **Audio Health (engine layer)** — `usePitchEngine.ts`
   - Refs: `lastFrameAtRef`, `lastRmsRef`, `framesPerSec`
   - `getHealth()` → `{alive, active, lastFrameAgeMs, framesPerSec, totalFrames, lastRms, ringFilledSamples}`
   - `restart()` — destrói + recria recorder do zero (chamado pelo Pipeline Health)
   - Watchdog interno (apenas log) em `audio_frame_timeout` >5s

2. **Pipeline Health (hook layer)** — `useKeyDetection.ts`
   - Refs: `lastAudioFrameAtRef`, `lastValidPitchAtRef`, `lastBackendProgressAtRef`, `lastWatchdogActionAtRef`
   - Lock anti-concorrência: `mlInFlightRef` + `mlAbortControllerRef`
   - Watchdog escalonado a cada 1s:
     - **5s** sem frame de áudio → `engine.restart()` (silencioso) → fallback hardReset
     - **10s** sem pitch válido → reset de timestamp (não mata áudio)
     - **18s** ML preso em `analyzing` → abort + `setMlState('waiting')`
     - **30s** sem progresso real → `hardReset()` automático
   - Grace period após cada ação: 3s

3. **Hard Reset real** (`hardReset`)
   - Cancela request ML em voo via `AbortController.abort()`
   - Libera lock `mlInFlightRef = false`
   - `engine.stop()` + `engine.restart()` (recria recorder)
   - Limpa todos os state, refs, buffers, debouncer
   - Reseta timestamps com grace period
   - Reset PCP no backend (idempotente)
   - Estado `recoveryStatus = 'hard_reset'` durante a operação

4. **AppState recovery**
   - `wasRunningBeforeBackgroundRef` rastreia estado pré-background
   - Background → cancela ML em voo + `stop()`
   - Active de volta → `start()` automático se estava rodando antes
   - Log: `app_state_changed`, `app_state_recovery_restart/done`

5. **Cancelamento de requests ML**
   - `analyzeKeyML` aceita `externalSignal?: AbortSignal`
   - `stop()`, `softReset()`, `hardReset()`, `AppState→background` chamam `controller.abort()`
   - Distingue `error: 'cancelled'` de `error: 'timeout'`
   - Resposta tardia após cancelamento NUNCA contamina estado novo

6. **Lock anti-concorrência ML**
   - `mlInFlightRef` booleano + `try/finally` garante release sempre
   - Mesmo com guard de `mlState`, watchdog + loop podem disparar em paralelo
   - `lock_released` logado no `finally`

### Botão "Nova Detecção"
Agora chama `hardReset()` (era `reset()` que não destruía o recorder).

### Logs estruturados (`[AudioHealth]` prefix)
`audio_frame_received` (1/100 sample), `audio_frame_timeout`, `recorder_started`, `recorder_stopped`, `recorder_restart`, `watchdog_restart`, `watchdog_ml_stuck`, `pitch_timeout`, `no_progress_hard_reset`, `hard_reset_detection`, `backend_request_start`, `backend_request_cancelled`, `backend_request_success`, `backend_request_error`, `lock_released`, `app_state_changed`, `app_state_recovery_restart/done`, `recorder_handle_missing`, `recorder_start_exception`.

### Critério de aceite (validação manual)
1. ✓ Detectar normalmente
2. ✓ Minimizar e voltar (recovery automático)
3. ✓ Bloquear/desbloquear tela (AppState handler)
4. ✓ Múltiplos cliques em "Nova Detecção" (hardReset idempotente + lock)
5. ✓ Silêncio prolongado (10s pitch_timeout não restarta áudio)
6. ✓ Cantar depois de silêncio (timestamps são atualizados em tempo real)
7. ✓ Backend lento (>18s analyzing → unstuck automático)
8. ✓ Nunca trava em "Ouvindo..." por mais de 30s sem progresso real

## Vocal Focus / Noise Rejection (2026-02-08)

Camada de **pré-processamento** antes do motor tonal CREPE.
Objetivo: proteger a detecção de tom contra ruído ambiente, percussão, notas curtas e pitch instável.

### Arquivos
- `/app/backend/vocal_focus.py` — implementação (configurável, com bypass global)
- `/app/backend/key_detection_v10.py` — integração via flag `VOCAL_FOCUS_ENABLED`
- `/app/backend/tests/test_vocal_focus.py` — 10 testes unitários (silêncio, ruído, percussão, voz limpa, nota curta, pitch instável, bypass)
- `/app/frontend/src/utils/noiseStageDebouncer.ts` — histerese para o `noise_stage` (≥1.5s no novo estado antes de trocar)
- `/app/frontend/src/hooks/useKeyDetection.ts` — expõe `noiseStage` e `noiseDisplay` debounciados
- `/app/frontend/app/index.tsx` — badge informativo "Ambiente com ruído" / "Percussão detectada" / "Aguardando voz"

### Rollback rápido
Em `key_detection_v10.py`:
```python
VOCAL_FOCUS_ENABLED = False  # camada totalmente bypassada
```
Ou ajustar agressividade sem refatorar:
```python
VOCAL_FOCUS_CONFIG = VocalFocusConfig(min_frame_confidence=0.30, min_note_duration_ms=80)
```

### Contrato API (`POST /api/analyze-key`)
A resposta agora SEMPRE contém:
```json
{
  "noise_rejection": {
    "enabled": true,
    "stage": "clean | noisy | percussion | silence",
    "passed": true,
    "quality_score": 0.83,
    "valid_ratio": 0.99,
    "rejection_reason": null,
    "total_frames": 200,
    "valid_frames": 198,
    "rejected_frames": 2,
    "rejection_counts": {"low_confidence": 2},
    "processing_ms": 4.5
  },
  "clip_rejected": false   // true quando o filtro descartou o clip antes do motor tonal
}
```

## Core Features
1. **Ativação via token** (TEST-DEV2026 para devs)
2. **Gravação contínua** com visualização de pitch
3. **Análise de tonalidade** ML via backend:
   - CREPE (tiny) → F0 por frame (10ms)
   - Segmentação MIDI → notas com duração
   - Detecção de frases (gap ≥ 200ms)
   - **Krumhansl-Schmuckler** (Pearson) + cadência + força + penalidade
   - **TonicAnchor**: gravidade tonal 70/20/10 em tônica/5ª/4ª
   - **Anti-grau-diatônico guard**: trava graus ii–vii como tônicas falsas (1.3× gravity threshold)
   - **Tiebreaker de pares relativos** (maj/min distance of 9 semitones)

## Admin
- Painel HTML single-file em `/api/admin-ui` (e alias `/api/admin`)
- Login via header `X-Admin-Key` (ADMIN_KEY env var)
- Features: listar, criar, revogar/ativar, limpar devices, editar, excluir tokens

## URLs
- **Backend API:** `https://vocal-shield.preview.emergentagent.com/api/*`
- **Admin UI:** `https://vocal-shield.preview.emergentagent.com/api/admin-ui`
- **Expo Web Preview:** `https://vocal-shield.preview.emergentagent.com/`

## Stack
- Frontend: Expo SDK + expo-router + react-native-reanimated
- Backend: FastAPI + Motor (MongoDB) + torchcrepe + librosa
- Auth: JWT (30 dias) + token de ativação por device_limit

## Algoritmo de Detecção de Tom (v14 — 2026-02-XX)

### Janela fixa 30s — DECISÃO BINÁRIA (sem intermediário)

Regra principal: **É melhor não mostrar nada do que mostrar um tom errado.**

| Tempo       | Stage       | UI mostra                                                                 | Tom exibido? |
|-------------|-------------|---------------------------------------------------------------------------|--------------|
| 0 – 10s     | `listening` | "Ouvindo…" + barra de progresso 0→33%                                     | ❌           |
| 10 – 30s    | `analyzing` | "Analisando padrão melódico…" + barra 33→100%                             | ❌           |
| 30s+ (ok)   | `confirmed` | "Tom confirmado" — só se 7 critérios rigorosos passam                    | ✅           |
| 30s+ (dúvida)| `uncertain`| "Continue cantando mais alguns segundos para confirmar o tom."           | ❌           |

### 7 critérios RIGOROSOS para `confirmed` (TODOS devem passar):
1. Margem top1/top2 ≥ 25%
2. Cadência ≥ 0.15 (evidência de repouso)
3. Third_ratio ≥ 0.65 OU ≤ 0.35 (3ª claramente maior ou menor)
4. Confiança ≥ 0.60
5. NÃO é relativo ambíguo
6. NÃO é dominante/subdominante ambígua
7. Consenso ≥ 4 votos iguais nas últimas 10 análises

### Mudanças vs v13
- ❌ Removido stage `probable` (causava exibição de tons errados entre 15-25s)
- ✅ Decisão **binária** aos 30s: confirmado com evidência real OU incerto (sem tom)
- ✅ Payload novo: `window_s: 30`, `window_progress: 0..1`, `failing_criteria`, `criteria`
- ✅ Log detalhado dos critérios que falharam quando `uncertain`

### Frontend v14 (OTA 2026-02-XX)
- Barra de progresso agora é "Janela de análise · Ns / 30s"
- Removida exposição de tom em qualquer stage ≠ `confirmed`
- Update ID: `da5f4b8a-258b-4598-920c-f88eca5e2a8c`

## Algoritmo de Detecção de Tom (v13 — anterior)

### Máquina de Estados por TEMPO DECORRIDO (UX redesenhada pelo usuário)

O backend agora controla 5 estágios baseados no tempo desde o início da sessão:

| Tempo       | Stage       | UI mostra                                           | Tom mostrado?         |
|-------------|-------------|-----------------------------------------------------|-----------------------|
| 0 – 5s      | `listening` | "Ouvindo…"                                          | ❌ não                |
| 5 – 15s    | `analyzing` | "Analisando padrão melódico…"                       | ❌ não (oculto)       |
| 15 – 25s   | `probable`  | "Tom provável" (se confiança ≥ 0.55)               | ⚠️ sim, sem lock      |
| 25s+        | `confirmed` | "Tom confirmado"                                    | ✅ sim, com lock      |
| 30s+ ambíguo| `needs_more`| "Continue cantando mais alguns segundos…"           | ❌ não                |

### Critérios para `confirmed` (rigorosos — evita erro rápido):
- confiança ≥ 0.70
- margem relativa top/runner ≥ 25%
- NÃO é relativo ambíguo (diff +3/+9 + margem < 20%)
- NÃO é dominante/subdominante ambígua (diff +5/+7 + margem < 20%)
- consenso de votos: ≥ 5 votos para o mesmo tom nas últimas 10 análises

### Contrato do payload API (novo):
```json
{
  "stage": "listening|analyzing|probable|confirmed|needs_more",
  "stage_label": "texto em pt-BR pronto para exibir",
  "stage_hint": "sub-texto opcional",
  "show_key": true/false,
  "elapsed_s": 12.5,
  "locked": true/false,
  "tonic": 0, "quality": "major", "key_name": "Dó Maior",
  "confidence": 0.85,
  "ambiguity": { "margin_ratio": 0.35, ... }
}
```

### Frontend (v13 OTA 2026-02-XX):
- `index.tsx` respeita `stage_label` do backend como fonte única da verdade
- `processAnalysis` da engine cliente só roda em stages `probable`/`confirmed`
- Lock client-side só acontece quando backend manda `locked: true`
- Update ID: `505cc2d0-ea2f-4d26-bed2-18981cdcd69c` (produção)

## Algoritmo de Detecção de Tom (v12 — 2026-02-XX)

### Mudanças v11 → v12 (baseadas em 5 feedbacks reais do usuário)
Diagnóstico: em múltiplos casos reais, a escala correta aparecia como top-1 no
`scale_fit`, mas a tônica escolhida dentro dessa escala era errada (ex: iii, vi, ou IV).
Em um caso (Lá# Maior) a tônica real chegava a aparecer com score 0.0 por conta
de uma penalty absoluta que anulava o score base.

Correções globais aplicadas a TODOS os 24 campos harmônicos:
1. **24 escalas**: agora testamos 12 major naturais + 12 harmonic minor (antes
   só 12 major). Resolve hinos em menor harmônico com sensível ativa (Lá menor H).
2. **Scale-aligned tonic bonus**: tônica da escala top-1 recebe bônus aditivo
   (0.28 major / 0.25 minor harmônico) + bônus proporcional à margem da escala
   (até +0.20). Isso garante que quando a escala acerta, a tônica dentro dela
   também acerta — corrigindo iii/vi/IV/V spoofing.
3. **Penalty não-dominante multiplicativa e tolerante a 3ª forte**: a penalty
   antiga (-0.30 absoluto + max(0,...)) podia zerar a tônica correta. Agora é
   fator multiplicativo (0.92 a 0.70) atenuado por third_ratio ≥ 0.75.
4. **Tratamento de empate entre escalas (margin < 0.01)**: em testes sintéticos
   ideais ou em pares tônica/subdominante (Sol=Dó compartilham 6/7 notas), várias
   escalas podem ter fit idêntico. O bônus agora é distribuído entre todas as
   empatadas (até 4), evitando que a ordem arbitrária de sort decida o resultado.
5. **Default major vs minor**: bônus para major_natural (0.28) > harmonic_minor
   (0.25) enforce a convenção "quando ambíguo, prefira maior".

### Validação (tests/test_global_key_detection.py + test_key_detection.py)
- 37/37 testes sintéticos passando
- 3/5 feedbacks REAIS resolvidos (cases 2, 3, 4)
- 2/5 feedbacks falham porque têm captura corrompida (case 1: diff=6 semitons
  irrecuperável; case 5: diff=1 semitom + PCP dominado por C#, G#, A# que não
  estão em Sol Maior — confirma pitch-shift do microfone na captura).

### Fórmula de score por candidato (tônica)
```
score_base = 0.40*cadence + 0.20*pcp_tonic + 0.25*third_ratio + 0.15*fifth_score
score_base *= not_dominant_penalty_factor  # 0.92 a 0.70 multiplicativo
score_final = score_base * scale_multiplier(fit_ratio) + alignment_bonus
```
- `cadence`: força de repouso ponderada (últimas 8 notas + phrase ends + última nota)
- `pcp_tonic`: duração ponderada total da tônica (0..1)
- `third_ratio`: 3ª da qualidade certa / (3ª certa + 3ª errada) → 0.5 neutro
- `fifth_score`: duração ponderada da 5ª
- `scale_multiplier` ∈ [0.45..1.0] baseado em fit relativo ao top-1
- `alignment_bonus` ∈ [0, 0.48] quando tônica alinha com escala top-1

## Algoritmo de Detecção de Tom (v6 — anterior, descontinuado)
Fórmula validada matematicamente (168/168 = 100% em testes sintéticos):
```
score = (corr + 0.3 × third_diff) × axis^1.2 + 0.3 × final_match
```
- `corr`: Pearson(PCP, perfil_Aarden_Essen_rotacionado)
- `third_diff`: peso da 3ª do modo − peso da 3ª oposta (∈ [-1,+1])
- `axis^1.2`: força do eixo Tônica-5ª (= min(peso_tônica, peso_5ª))
- `final_match`: bônus de resolução (1.0 tônica / 0.6 3ª / 0.5 5ª, escalonado por dur)

Confidence multiplicativa (precisa correlação alta E margem clara).
PCP acumulado por sessão (zera no /reset chamado pelo START).

## Status
- ✅ Migração do repo GitHub
- ✅ Ativação + gravação
- ✅ Lógica avançada de tonalidade (portada TS→Python)
- ✅ Painel admin HTML restaurado e servido pelo FastAPI
- ✅ Algoritmo de detecção definitivo (Krumhansl-Aarden + axis + third_diff + final_match) — 168/168
- ✅ OTA pipeline funcional (v3.4.0 e v4.0.0 publicados)
- ✅ **Visual Premium v4.0.0** — Apple/Tesla style com fonte Poppins, big mic com glow dourado animado, brain vortex com partículas (estado analisando), bottom nav Histórico/Detectar/Configurações, AICard premium, GoldWaveform reativo, AsyncStorage para histórico persistente.
- ✅ **Key Detection v10.1 (Feb 2026)** — Lógica universal por teoria musical aplicada aos 24 tons:
  - Anti-mediant penalty explícito (variáveis `mediant_major`/`mediant_minor`/`dominant_offset`) — resolve confusão Sol→Si/Lá Maior reportada
  - Razão neutra (0.5) na ausência de 3ª/6ª/7ª — corrige viés artificial para menor em letras modais/sem terça
  - MAX_GAP=15 (150ms) para agrupar notas em frases
  - Krumhansl com peso 40% (antes 15%)
  - CONFIDENCE_THRESHOLD=0.35 / MIN_NOTE_DUR_MS=60ms — calibrado p/ voz humana real
  - Watchdog/timeout no frontend (`useKeyDetection.ts`, `mlKeyAnalyzer.ts`) p/ evitar congelamento >60s
  - **31/31 pytest** (incluindo `test_global_key_detection.py` cobrindo todos os 24 tons)
  - Smoke tests via `/api/analyze-key`: Dó/Sol/Ré Maior + Lá menor detectados ≤ 9s
- ✅ **Key Detection v10.2 (Feb 2026)** — Correção do bug "tom oscilando para 3ª maior" em áudios reais:
  - **Janela de notas: 80 → 250** no `SessionAccumulator` (≈30-60s de contexto musical, suficiente para Krumhansl convergir corretamente)
  - **Anti-mediant Krumhansl-anchored bidirecional + swap forçado**: quando o vencedor pós-fórmula é uma 3ª/5ª do vencedor de Krumhansl puro (que olha conjunto INTEIRO de notas), o algoritmo força o swap garantindo que o Krumhansl winner fique acima com margem clara. Aplicado universalmente aos 24 tons via aritmética modular (gate KS_margin>0.03)
  - **Resultado validado**: hino "Os guerreiros se preparam" (Vanessa Ferreira, a capela 3:32) detectado como **Mi Maior 100%** (antes: Sol# menor 97% errado)
  - **Streaming chunks de 5s (simulação realista do app)**: trava corretamente em Mi Maior aos 20s (antes travava em Si Maior aos 10s)
  - **Lock criteria endurecido** (`_should_lock`): mínimo 4 análises (20s de áudio) para qualquer lock + gate anti-dominante/anti-mediant que rejeita lock se runner-up é 3ª/5ª do top com margem <25%
  - **Lock criteria descongela** (`_should_change`): cap em 0.92 + fast-path anti-dominante/mediant retroativo para descongelar quando descobre raiz tonal real
- ✅ **Sistema de Feedback "Tom Errado?" (v3.17.0, Feb 2026)** — Aprendizado baseado em reports do usuário:
  - **Backend**: novo módulo `feedback_service.py` com classificação automática de tipo de erro (relative, dominant, subdominant, mediant, wrong_scale, wrong_quality) + sugestão de causa raiz musical para cada caso
  - **Endpoints**: `POST /api/key-feedback/submit` (salva snapshot de features: notes, PCP, top_candidates, cadence, scale_fit — sem áudio cru) e `GET /api/key-feedback/stats` (agregação de tipos de erro, top confusões, recent samples)
  - **MongoDB collection `key_feedback`**: persistência leve (~2KB por caso) que permite reanálise offline com futuras versões
  - **SessionAccumulator agora grava `last_result_snapshot`** após cada análise para feedback posterior
  - **Frontend**: novo componente `WrongKeyFeedback.tsx` com botão "Tom errado?" no card do tom detectado. Modal elegante com grid 4x3 das 12 tônicas + toggle Maior/menor + comentário opcional
  - **Admin dashboard** (acessível com X-Admin-Token se ADMIN_TOKEN está configurado): mostra padrões agregados para decidir ajustes futuros do algoritmo
  - Validado end-to-end: envio de feedback testado, classifica corretamente "Mi detectado vs Sol esperado = dominant (diff=7)" e gera sugestões musicologicamente corretas

- ✅ **Key Detection v11 (Feb 2026)** — REESCRITA MUSICOLÓGICA do zero:
  - **Removidas 6+ camadas conflitantes** (Krumhansl + phrase_end + duration + anti-mediant + anti-relativo + anti-dominante)
  - **Substituídas por 5 etapas explícitas, transparentes, testáveis:**
    1. **PCP** (Pitch Class Profile ponderado por duração e confiança)
    2. **Identificar escalas diatônicas candidatas** (top 3 com `_score_diatonic_scales`)
    3. **Para cada escala, ranquear 2 tônicas** (tom maior + relativo menor) via `_score_tonic_candidate` que aplica:
       - LEI 1 (REPOUSO): cadence_score (cadência final + últimas notas + phrase ends)
       - LEI 2 (3ª): 3ª maior para 'major', 3ª menor para 'minor', com penalidade se 3ª errada está mais presente
       - LEI 3 (V GRADE): 5ª justa presente reforça função tonal
       - LEI 4 (NÃO-V): se candidato é 5ª de outro pc com mais cadência, penaliza
    4. **Selecionar tônica final** por score (combinação 50% cadência + 20% PCP + 20% 3ª + 10% 5ª)
    5. **Confiança HONESTA** com 5 caps automáticos:
       - margem ratio ≥ 85% entre top1 e top2 → cap 0.55
       - margem ratio ≥ 75% → cap 0.65
       - poucas notas (< 8) → cap 0.75
       - poucos phrase ends (< 3) → cap 0.78
       - 3ª fraca → cap 0.70
       - cadência fraca → cap 0.65
       - relativos com diff +9/+3 ratio ≥ 65% → cap 0.55
       - tônica/dominante com diff +5/+7 ratio ≥ 60% → cap 0.55
       - mediant maior diff +4 ratio ≥ 65% → cap 0.60
  - **Validação:** 37/37 pytest passando. Si Maior, Dó# Maior, Mi Maior, Sol Maior balada (com 6ª longa), Ré menor, Lá menor — todos detectados corretamente. Áudios reais "Os guerreiros" Mi Maior 100% conf.
  - **Logs transparentes:** cada decisão musical é logada com cadence, third_ratio, scale_fit explícitos.
  - **Prova de globalidade (33 testes pytest)**: novos testes `test_padrao_hino_funciona_em_todos_12_tons_maiores` e `_menores` aplicam o exato padrão musical do hino problemático aos 24 tons — todos passam, provando que a correção é puramente baseada em aritmética modular (mod 12) sem hardcode
- ✅ **Landing Page** — refatorada de 3 → 2 planos (Essencial e Profissional) em `/app/backend/tom-certo-emergent-ready/standalone-html/index.html`
- ✅ **Railway + MongoDB Setup** — variáveis de ambiente configuradas (ver `/app/RAILWAY_SETUP_GUIDE.md`)
- ✅ **Branding & Copy refinement (Feb 2026)**:
  - Removida promessa "Teste grátis" da landing → "Escolha seu plano e comece agora."
  - Frase "Pagamento seguro..." centralizada com `mt-16`, fonte 13px, cor #666 (75% opacidade)
  - Favicon Tom Certo (logo dourado em fundo preto) servido em `/favicon.ico`, `/favicon.png`, `/favicon-256.png`, `/apple-touch-icon.png`
  - Tags `<link rel="icon">` adicionadas em landing, admin UI e página de download
  - Email de credenciais com URL de download corrigida para `https://tomcerto.online/download`
- ✅ **Plano Profissional — Atualizações Inclusas (Feb 2026)**:
  - "Afinador completo" renomeado para "Afinador Inteligente com IA" (apenas no plano Profissional)
  - Nova seção "Atualizações Inclusas" com 2 itens (Modo Ensaio, Acordes Sofisticados & Rearmonização)
  - Badge "Em breve" dourado/amarelo (#FFB020) estilo pill minimalista — percepção positiva (benefícios futuros já inclusos)
  - Microcopy: "Você garante acesso a todas as futuras atualizações sem custo adicional."
  - Bloco secundário com divisor dashed dourado, hierarquia preservada abaixo das features principais

- ✅ **Afinador Inteligente v2 (Feb 2026)** — refator completo para experiência profissional:
  - **Root cause fix:** microfone NÃO abre mais automaticamente ao entrar na tela. `tuner.start()` só é chamado quando o usuário seleciona uma corda.
  - **Máquina de estados explícita:** `no_string → starting_mic → awaiting_attack → listening → guiding → tuned` (+ `out_of_range` + `error`)
  - **Cordas são tocáveis** (`TouchableOpacity`) — selecionada fica destacada em âmbar com scale 1.05
  - **Gate duplo:** energia (`noise >= 0.15`) + janela de ±400¢ (±4 semitons) relativa à corda-alvo — rejeita voz, ventilador, outra corda
  - **Harmônicos de oitava** são clampados para a mesma nota (freq*2 ou freq/2 → mesma corda)
  - **Estabilidade:** mediana de 8 leituras + desvio padrão <22¢ por 250ms antes de orientar; afinado exige |cents|≤5 mantido por 400ms
  - **Silêncio de 900ms** reseta para "Toque a corda selecionada" (nunca mantém orientação residual)
  - **Cents relativos à corda-alvo**, não à nota cromática mais próxima — orientação é sempre contextual
  - **`useTuner.ts`:** `minVolume` do Pitchy native elevado de −60 → −42 dBFS para rejeitar ambiente
  - **Validação:** 7 cenários pytest-like em `/tmp/test_tuner_logic.mjs` — todos passando (silêncio, ruído baixo, corda errada, desafinada, afinada, silêncio pós-afinado, harmônico)
  - **Arquivos:** `/app/frontend/app/tuner.tsx` (rewrite completo) + `/app/frontend/src/hooks/useTuner.ts` (minVolume)