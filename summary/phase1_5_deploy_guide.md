# Tom Certo — Fase 1.5 + Fase 2 + Fase 3 (Resolução do bug "Ouvindo eterno")

## Resumo executivo

A investigação do print do usuário identificou que **o servidor de produção `tomcerto.online`** já tinha a Fase 1 deployada, mas **dois bugs adicionais** mantinham o app preso em "Ouvindo...":

1. **Cold start de 17s no servidor** (CREPE carregando do zero a cada boot)
2. **Auto-reset de inatividade muito agressivo (10s)** — gaps de cold start ≥ 10s ressetavam a sessão a cada análise, mantendo `elapsed_s=0` para sempre.
3. **Timeout do APK de 12s** — frontend abortava antes do server responder.

## O que foi corrigido (Fase 1.5/2/3 — backend)

### 1. Warmup automático do CREPE no startup
- `backend/server.py` chama `warmup_models()` num thread de background ao iniciar
- Primeira chamada após boot agora leva **0.9s** (era 17s)
- Log: `[Warmup] CREPE pronto: {'crepe_ms': 944, 'librosa_ms': 98, 'total_ms': 1042}`

### 2. Auto-reset por inatividade: 10s → 120s
- `backend/key_detection_v10.py:809` — só reseta se a sessão ficar realmente abandonada (>2 minutos)
- **Antes**: gap de 12s entre análises ressetava sessão constantemente → `elapsed_s` sempre 0 → app preso em "listening"
- **Depois**: mesmo com gaps de 60s, sessão progride normalmente

### 3. Session ID por uso (UUID)
- Backend aceita header `X-Session-Id` opcional
- Cada `start()` no app gera novo UUID → backend cria sessão totalmente isolada
- Retrocompatível: frontends antigos sem X-Session-Id usam chave `device::mode` como antes

### 4. Garbage Collector de sessões (TTL 10 min)
- Background task a cada 60s remove sessões inativas > 10 min
- Log: `[v15/gc] Removidas N sessões expiradas`

### 5. Endpoint de diagnóstico `/api/analyze-key/session-info`
- GET retorna estado interno da sessão (start_time, locked, vote_history, analysis_count, etc.)
- Headers: `X-Device-Id` (obrig.), `X-Detection-Mode`, `X-Session-Id` (opc.)
- Útil para diagnosticar travas em produção sem precisar de logs

## O que foi atualizado no frontend (próximo APK)

### 1. Timeout do APK: 12s → 25s
- `frontend/src/utils/mlKeyAnalyzer.ts:249` — tempo máximo para análise individual
- Tolera cold starts mesmo se ocorrerem
- Sem isso, o APK abortava antes da resposta chegar

### 2. `X-Session-Id` enviado em cada chamada
- `frontend/src/hooks/useKeyDetection.ts` gera UUID a cada `start()`, `hardReset()`, `softReset()`
- Log: `session_id_generated { sessionId, reason: start/hard_reset/soft_reset }`

## Como deployar (sua ação)

### Backend (Railway / hosting de tomcerto.online)
1. Faça commit das mudanças em:
   - `backend/key_detection_v10.py`
   - `backend/server.py`
2. Push para o branch que o Railway monitora (geralmente `main`)
3. Confirme o deploy nos logs Railway com:
   ```
   curl -sS https://tomcerto.online/api/analyze-key/reset \
     -H "Content-Type: application/json" -H "X-Device-Id: test" \
     | jq .version
   # Deve mostrar: "v15-phase1"
   ```
4. Confirme o warmup nos logs do Railway: deve aparecer
   `[Warmup] CREPE pronto: {...}` em ~3-5 s após cada boot.

### Frontend (APK)
⚠️ As mudanças do frontend **só ficam ativas com novo APK**. Você precisa:
1. `cd frontend && eas build --platform android --profile production`
2. Distribuir o APK aos usuários

**SEM o novo APK**: o servidor já corrige 90% do problema (warmup + auto-reset 120s), o usuário verá a detecção funcionar mesmo no APK velho. O timeout de 12s ainda pode causar ocasionais retries, mas como o server agora responde em ~1-3s (warm), isso não é mais um bloqueador.

## Como validar (depois do deploy de produção)

### Teste 1: Verificar warmup
```bash
curl -sS https://tomcerto.online/api/analyze-key/reset \
  -H "Content-Type: application/json" -H "X-Device-Id: smoke-test"
# Resposta deve mostrar: "version": "v15-phase1"
```

### Teste 2: Verificar performance pós-warmup
Use o WAV de teste (anexo) e dispare 3 análises consecutivas:
```bash
for i in 1 2 3; do
  time curl -sS -X POST https://tomcerto.online/api/analyze-key \
    -H "Content-Type: audio/wav" -H "X-Device-Id: smoke-test-$i" \
    --data-binary @test_melody.wav | jq '{stage, elapsed_s, timings_ms}'
  sleep 2
done
```
Esperado: `total_ms` < 2000 em todas as chamadas (era >17000 antes).

### Teste 3: Verificar session-info (no app)
Você pode fazer um botão "Diagnóstico" no app que chame:
```
GET /api/analyze-key/session-info
Header: X-Device-Id: <id>
```
Retorna estado completo da sessão atual.

### Teste 4: No celular (APK antigo após deploy backend)
1. Abrir Tom Certo
2. Iniciar Detecção
3. Cantar "Parabéns pra Você"
4. **Esperado**: tom confirmado em 15-30 segundos
5. **Antes**: ficaria em "Ouvindo..." para sempre

## Riscos e limitações

- ⚠️ **Cold starts ainda existem em servidores que dormem** (Railway free tier). O warmup é disparado UMA vez por boot. Se o servidor dormir após inatividade, o próximo request paga o cold start. Mitigação: usar plano pago do Railway com instância sempre ativa, OU pingar `/api/health` a cada 5min externamente.
- ⚠️ **APKs antigos têm timeout 12s** — usuários em rede 3G/4G ruim podem ainda ver timeouts pontuais, mas como o backend está bem mais rápido, é raro.
- ⚠️ **O Phase 2 ainda não inclui adaptive backoff completo nem CREPE small/full** — backend ainda usa `tiny`. Precisão musical das 24 tonalidades melhorará nas Fases 4-5.

## Próximos passos sugeridos

1. **Deploy do backend AGORA** → resolve trava do usuário sem novo APK
2. **Validar com o usuário** se o problema sumiu (ele pode testar imediatamente após o deploy)
3. **Build do APK novo** para garantir os 100% (timeout 25s + session_id) — em paralelo
4. **Fase 4** (precisão musical): refatorar decisão maior/menor (Bayes ratio) e avaliar CREPE small
