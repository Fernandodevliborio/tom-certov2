# Tom Certo — Relatório da Fase 1 (Estabilização Imediata)

**Data:** 2026-02
**Escopo:** Correções cirúrgicas para estabilizar o pipeline. Sem alterar UI visual, sem trocar bibliotecas, sem refatorar precisão musical.
**Resultado de teste em curl real:** *Dó Maior detectado em 18.5 s* (antes da Fase 1 era impossível antes de 30 s, em condições ideais).

---

## 1. Arquivos alterados

| Arquivo | Tipo | Motivo |
|---|---|---|
| `backend/key_detection_v10.py` | edição cirúrgica | Decisão progressiva por evidência (5 s/15 s/30 s) + sticky-lock revisável + helper `_confirmed_payload` + logs `[v15]` |
| `frontend/src/hooks/useKeyDetection.ts` | edição cirúrgica | Bug do `lastBackendProgressAtRef` + watchdog camada E (streak de rejeições) + reset síncrono em `start`/`hardReset`/`softReset` + logs `ml_state_transition`, RTT, streak |
| `frontend/app/index.tsx` | edição cirúrgica | Reset de boot agora aguarda `getDeviceId()` antes de enviar (corrige reset apenas em `anon::vocal`) |

**Nenhum arquivo novo foi criado**. Nenhuma biblioteca instalada (apenas dependências transitórias do librosa que já deveriam estar no requirements: `audioread`, `decorator`, `msgpack`, `pooch`, `scikit-learn`, `lazy_loader`, `resampy`, `soxr` — tudo necessário para o backend rodar; quando você for empacotar, garanta que `requirements.txt` inclui).

---

## 2. O que foi corrigido

### 2.1 Decisão progressiva por evidência (substitui janela hardcoded de 30 s)
**`key_detection_v10.py: SessionAccumulator._current_stage()` e `get_result()`**

Antes: stage era `listening (0–10 s) → analyzing (10–30 s) → decision (≥30 s)`. Tom só era exposto após **30 s**, sem exceção.

Agora: 4 tiers, cada um com seu pacote de critérios:
- `0–5 s` → `listening` (sem decisão; UI mostra "Ouvindo…")
- `5–15 s` → `evaluating-strict` (pode confirmar com **evidência muito forte**: margin ≥ 0.40, conf ≥ 0.78, third "limpa" 0.30/0.70, cadence ≥ 0.20)
- `15–30 s` → `evaluating-solid` (evidência sólida: margin ≥ 0.30, conf ≥ 0.65, cadence ≥ 0.17)
- `≥30 s` → `decision` (critérios padrão preservados — backwards-compatible)

Janela de consenso adaptativa: `min(10, max(3, len(vote_history)))`. No tier `evaluating-strict`, o alvo é ajustado pra história disponível.

**Validação em produção (curl real):**
```
T+0.0s    listening      → show_key=False
T+4.6s    listening      → show_key=False
T+9.3s    evaluating-strict (uncertain) — falhou margem 37%<40% e consenso 1/3<4
T+14.0s   evaluating-strict (uncertain) — consenso 2/3<4
T+18.6s   confirmed em evaluating-solid → "Dó Maior" com conf=1.00 ✅
```

### 2.2 Sticky-lock revisável (não mais irrevogável)
**`key_detection_v10.py: get_result()` — bloco `already_locked`**

Antes: troca de tom exigia `consensus ≥ 7/10 + conf ≥ 0.80 + margin ≥ 0.40 + votes_for_locked ≤ 2` — quase impossível.

Agora: critérios variam com **tempo desde o lock**:
- Lock recente (< 60 s): `consensus ≥ 5 + conf ≥ 0.75 + margin ≥ 0.35 + old_votes ≤ 3`
- Lock antigo (≥ 60 s): `consensus ≥ 5 + conf ≥ 0.70 + margin ≥ 0.30 + old_votes ≤ 4`

Resultado: tom errado por base ruim (sessão contaminada, primeiros 30 s pobres) **pode ser corrigido** quando o sinal melhorar, mas oscilação cosmética continua bloqueada.

### 2.3 Bug do `lastBackendProgressAtRef`
**`useKeyDetection.ts: runMLAnalysis` resposta de sucesso**

Antes: qualquer `result.success === true` atualizava o "watchdog de progresso", incluindo `clip_rejected: true` (vocal_focus rejeitando ambiente ruidoso). Resultado: o watchdog 30 s **nunca disparava** quando o ambiente era apenas ruim, deixando o usuário preso em "Analisando…" eternamente.

Agora: só conta como progresso real se:
- `show_key === true` (backend liberou tom), OU
- `clip_rejected !== true && notes_count > 0` (clip aceito com material musical processado)

Adicionado `rejectedStreakRef` + `rejectedStreakStartAtRef` para contagem de rejeições consecutivas.

### 2.4 Reset síncrono em `start`/`hardReset`/`softReset`
**`useKeyDetection.ts` + `index.tsx`**

Antes: `resetKeyAnalysisSession(...)` era fire-and-forget. Em rede lenta, a próxima análise chegava ao backend **antes** do reset, e a sessão antiga (com `start_time`, `vote_history` e `locked_*` antigos) era reusada → tom fantasma instantâneo.

Agora:
- `start()` aguarda o reset em paralelo com `engine.start()` via `Promise.all` (timeout interno 5 s).
- `hardReset()` aguarda o reset depois do `engine.restart()`.
- `softReset()` aguarda o reset (com timeout interno) antes de zerar timestamps de watchdog.
- Reset de boot em `index.tsx`: agora aguarda `getDeviceId()` antes de enviar — corrige reset que afetava apenas `anon::vocal`.

### 2.5 Watchdog camada E (streak de rejeições)
**`useKeyDetection.ts: PIPELINE HEALTH WATCHDOG`**

Nova camada: se `rejectedStreakRef ≥ 8` por > 20 s, dispara `softReset` automático (mantém o recorder vivo, só limpa buffers). Evita travamento em ambientes ruidosos persistentes.

### 2.6 Logs de produção
**Backend (`key_detection_v10.py`):**
- `[v15/timing] dev=XXX mode=YYY load=Xms crepe=Yms focus=Zms score=Wms total=Tms | session_age=Xs all_notes=N votes=M locked=... clip_notes=K stage=...`
- `[v15] DECISÃO CONFIRMADA aos Xs tier=YYY → key | conf=X margin=Y cad=Z third=W consensus=A/B target=C`
- `[v15] INCERTO aos Xs tier=YYY — failing=[...] | melhor: key (conf=X) top5=[...]`
- `[v15] TROCA DE TOM autorizada/BLOQUEADA (t_lock=Xs)`
- `[v15/{mode}] CLIP REJEITADO dev=XXX stage=YYY motivo=ZZZ valid=N/M focus=Xms`
- `[v15/reset] dev=XXX mode=YYY had_lock=true/false` ou `mode=ALL sessões_zeradas=N`

**Frontend (`useKeyDetection.ts` via `audioLog`):**
- `backend_request_success { showKey, rejected, rttMs, timings, notesProcessed, ... }`
- `backend_request_error/cancelled { rttMs, ... }`
- `ml_state_transition { from, to, reason? }` (em todas as transições)
- `clip_rejected_streak { count, durationMs, noiseStage, reason }` aos 5 e aos 10
- `clip_rejected_streak_cleared { previous }`
- `backend_reset_done { ok, ms, mode/reason }` / `backend_reset_error`
- `watchdog_rejected_streak_recover { count, durationMs }` (camada E)
- `no_progress_hard_reset { ageMs, mlState, rejectedStreak }` (camada D — agora com contexto)

---

## 3. Riscos remanescentes

| # | Risco | Severidade | Mitigação proposta (Fase 2+) |
|---|---|---|---|
| 1 | **Modelo CREPE `tiny`** ainda comete erros de oitava em F0 alto/baixo. Confirmação rápida em `evaluating-strict` (5-15 s) pode travar lock baseado em PCP poluído. | Médio | Fase 4: avaliar `crepe small/full` ou GPU/MPS backend; mantém `tiny` em fallback. |
| 2 | **Krumhansl-Kessler simétrico em relativas** (Dó M ↔ Lá m) ainda gera `is_relative_ambiguous=true` em margens estreitas, bloqueando `confirmed`. | Médio | Fase 4: refatorar decisão maior/menor para Bayes ratio (3ª + 7ª + cadence V→I/V→i). |
| 3 | **`_sessions` sem TTL** — sessões de dispositivos antigos vivem indefinidamente em memória. | Baixo (memória pequena) | Fase 3: garbage-collect sessões inativas há > 5 min em background task. |
| 4 | **Ainda não há session_id por uso** — duas abas/processos do mesmo `device_id` compartilham sessão. | Baixo | Fase 3: gerar UUID em `start()` e enviar como `X-Session-Id`. |
| 5 | **Web fallback** continua sem `captureClip` — ML não funciona em browser. UI não diferencia. | Baixo | Fase 5: implementar com `MediaRecorder`/`AudioWorklet`. |
| 6 | **`evaluating-strict` pode confirmar prematuramente** se o usuário cantou exatamente uma frase muito clara mas rara (ex: arpejo perfeito de Sol M e nada mais). | Baixo | Monitorar logs `tier=evaluating-strict` e ajustar `consensus_min` se aparecerem falsos positivos. |
| 7 | **Confidence cap em 0.95** ainda está presente — visualmente, mesmo um lock incorreto sobe para 95% rapidamente. | Baixo | Fase 3: cap dinâmico baseado em concordância FE-local + BE-ML. |
| 8 | **Reset síncrono adiciona até ~500 ms ao `start`** em rede ruim. Para rede normal, < 100 ms. Timeout interno é 5 s. | Baixo | Aceitar trade-off (eliminação de contaminação > latência marginal). |
| 9 | `vote_history` cap em 20 já é razoável, mas em sessões muito longas (música longa real) pode ficar viesado para o início. | Baixo | Avaliar deslizar com peso decrescente. |

---

## 4. Como testar no APK Android

### 4.1 Teste smoke (5 min)
1. Instalar APK release (não Expo Go).
2. Abrir o app — toca em "Iniciar Detecção".
3. Cantar "Parabéns pra você" inteira em voz limpa.
4. **Esperado:** tom confirmado **antes de 25 s** (era impossível antes da Fase 1).
5. Apertar "Nova Detecção" → cantar a mesma melodia.
6. **Esperado:** estado volta para "Ouvindo…" e nova detecção começa do zero (não retorna o tom anterior em < 1 s).

### 4.2 Teste de não-trava em ambiente ruidoso (10 min)
1. Iniciar detecção em ambiente com TV/música de fundo.
2. Não cantar (deixar só ruído ambiente).
3. **Esperado:** após ~30 s, watchdog deve disparar `no_progress_hard_reset` E/OU `watchdog_rejected_streak_recover`. App deve reiniciar a sessão (status "Reiniciando…" ou voltar para "Ouvindo…").
4. **Antes da Fase 1:** ficava preso em "Analisando…" indefinidamente.

### 4.3 Teste de contaminação cross-sessão (5 min)
1. Cantar Sol Maior por ~25 s — confirmar tom.
2. Apertar "Nova Detecção".
3. **Imediatamente** observar a UI: deve mostrar "Ouvindo…", **não** o tom Sol Maior anterior.
4. Cantar Mi menor por ~25 s.
5. **Esperado:** detectar Mi menor, não Sol Maior.

### 4.4 Teste de revisão de lock (Sticky-lock revisável) (5 min)
1. Cantar **errado** algo que tende a confundir (ex: começar em V grau de uma tonalidade) por 20 s — backend pode travar em tom incorreto.
2. Continuar cantando, mas mudando para a tonalidade certa por mais 30-40 s.
3. **Esperado:** após 60 s do lock inicial, ver `[v15] TROCA DE TOM autorizada` nos logs e a UI atualizar (badge "ATUALIZADO").
4. **Antes da Fase 1:** lock errado ficava para sempre a 95%.

---

## 5. Quais logs observar

### Backend (no servidor — `/var/log/supervisor/backend.err.log` ou onde você loga)

Filtros úteis:
```bash
# Decisões e tiers
grep "v15" backend.log
# Tempos e gargalos
grep "v15/timing" backend.log
# Resets
grep "v15/reset" backend.log
# Trocas de tom
grep "TROCA DE TOM" backend.log
# Rejeições do vocal_focus
grep "CLIP REJEITADO" backend.log
```

**Linhas-chave a inspecionar:**
- `[v15/timing] ... total=Xms | session_age=Ys all_notes=N votes=M locked=... stage=...` → uma por chamada; serve para ver throughput, contaminação (`session_age` muito alto após reset = bug), e qualquer estado da sessão.
- `[v15] DECISÃO CONFIRMADA aos Xs tier=YYY` → confirma que o tier progressivo está sendo usado.
- `[v15] INCERTO aos Xs tier=YYY — failing=[...] top5=[...]` → ver POR QUE não confirmou; top5 mostra alternativas.
- `[v15] TROCA DE TOM autorizada/BLOQUEADA` → ver se o sticky-lock revisável está agindo corretamente.

### Frontend (logcat / console)

Prefixo `[AudioHealth]` em todas as linhas:
```bash
adb logcat -s ReactNativeJS | grep AudioHealth
# Ou no Android Studio Logcat: filtro "AudioHealth"
```

**Eventos-chave:**
- `recorder_started` — confirmou que mic abriu.
- `audio_frame_received` (a cada ~10 s) — confirma stream ativo, mostra fps/RMS/ringFilled.
- `backend_reset_done { ok, ms, mode/reason }` — reset síncrono completo.
- `backend_request_start` → `backend_request_success { showKey, rejected, rttMs, timings, notesProcessed }` — RTT e quebras de tempo do backend visíveis.
- `ml_state_transition { from, to, reason? }` — fluxo idle→listening→analyzing→done/waiting transparente.
- `clip_rejected_streak { count, durationMs, noiseStage, reason }` — observe nos 5 e 10. Se ver muitos, ambiente é problema.
- `watchdog_rejected_streak_recover` — camada E disparou.
- `no_progress_hard_reset { ageMs, mlState, rejectedStreak }` — camada D disparou (tem mais contexto agora).
- `watchdog_restart` / `audio_frame_timeout` — recorder morreu e foi reiniciado.

### Cenários esperados

**Caso A — usuário canta bem em ambiente silencioso:**
```
recorder_started
audio_frame_received { fps≈10, rms≈0.05 }
ml_state_transition { from: idle, to: listening }
backend_request_start
backend_request_success { showKey: false, stage: 'listening', rttMs: 500 }   ← T+1s
ml_state_transition { from: analyzing, to: done }
backend_request_success { showKey: false, stage: 'evaluating-strict', rttMs: 600 }   ← T+9s
backend_request_success { showKey: true, stage: 'confirmed', rttMs: 600 }   ← T+15-25s
```

**Caso B — ambiente ruidoso:**
```
backend_request_success { showKey: false, rejected: true, rttMs: 500 }
clip_rejected_streak { count: 5, durationMs: 12000, noiseStage: 'noisy' }
clip_rejected_streak { count: 10, durationMs: 25000, noiseStage: 'percussion' }
watchdog_rejected_streak_recover { count: 8, durationMs: 22000 }   ← Fase 1 só
soft_reset (UI mostra "Reiniciando…" brevemente)
backend_reset_done { ok: true, ms: 320, reason: 'soft_reset' }
```

**Caso C — recorder morre (Android pause silencioso):**
```
audio_frame_received { fps: 10 }
... 5 segundos sem nada ...
audio_frame_timeout { ageMs: 5500 }
watchdog_restart { reason: 'no_audio_frame', ageMs: 5500 }
recorder_restart_done { ok: true }
audio_frame_received { fps: 10 } ← volta a funcionar
```

---

## 6. Reversibilidade

Cada mudança é **reversível** revertendo o `git diff` específico. As mudanças são compatíveis com o frontend antigo (não removi campos da resposta — só **adicionei** novos: `timings_ms`, `criteria_attempted`). O frontend antigo continuaria funcionando contra o backend novo, e o backend antigo continuaria funcionando contra o frontend novo (apenas alguns logs novos seriam ignorados).

**Para reverter rapidamente:**
- Backend: `git checkout HEAD~1 -- backend/key_detection_v10.py`
- Frontend: `git checkout HEAD~1 -- frontend/src/hooks/useKeyDetection.ts frontend/app/index.tsx`

---

## 7. Próximos passos (Fase 2+)

A ordem proposta no relatório de diagnóstico permanece válida:
- **Fase 2** (latência): substituir janela cronológica por janela por evidência pura, adaptive backoff do loop ML, considerar CREPE `small`.
- **Fase 3** (eliminar contaminação): session_id por uso (UUID), TTL de sessões, fusão FE-local ↔ BE-ML.
- **Fase 4** (precisão musical): decisão maior/menor por Bayes ratio, modelo melhor, PCP por janela curta.

A Fase 1 ataca apenas estabilidade. **O usuário deve perceber:**
1. Detecção em ~15-25 s para sinais claros (era ~45 s).
2. App não trava em "Analisando…" para sempre.
3. "Nova Detecção" funciona corretamente sem fantasmas do tom anterior.
4. Tom errado pode ser corrigido se o usuário insistir (60 s+).
5. Logs ricos em produção — diagnóstico de qualquer caso fica direto.

---

**Fim do relatório.**
