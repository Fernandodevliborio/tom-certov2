# SOLUÇÃO DEFINITIVA — Tom Certo APK "Ouvindo eterno"

## Diagnóstico final (causa raiz)

O APK v3.17.0 que o usuário tem instalado foi buildado **antes de 26/Abril/2026**, quando o `eas.json` apontava `EXPO_PUBLIC_BACKEND_URL` para:
```
https://harmony-check-6.preview.emergentagent.com
```

**Essa URL está MORTA hoje (retorna 404 page not found).**

Resultado: o APK envia request → recebe 404 → `setMlResult` nunca é chamado → `mlResult` permanece `null` → UI mostra os textos default ("OUVINDO", "Ouvindo...", "Identificando a tonalidade...", "Cante ou toque por alguns segundos") **eternamente**, sem nem mostrar o contador 1/30s, 2/30s, 3/30s.

O backend (Railway prod) está **PERFEITO**:
- v15-phase1 deployed ✅
- Warmup automático ativo (cold start 0.9s) ✅
- Fast Path detecta Dó Maior em **8.4 segundos** ✅
- Session GC + Auto-reset 120s ✅

## A solução: OTA Update (sem precisar reinstalar APK)

Como o app tem `expo-updates` habilitado (`app.json` confirma `updates.enabled: true`, `runtimeVersion: 2.0.0`), o **JS bundle pode ser atualizado remotamente sem novo APK**. Próxima vez que o usuário abrir o app, ele baixa o bundle novo e passa a chamar a URL correta.

### Comando (você roda no terminal da máquina onde tem `eas-cli` configurado)

```bash
cd /app/frontend

# Garantir que está logado no EAS
eas whoami
# Se não estiver: eas login

# Verificar configuração do projeto
eas update:configure

# Disparar o OTA
eas update --branch production --message "Fix: backend URL fallback + Phase 1 frontend"
```

### O que esse comando faz

1. Lê o `eas.json` atual → identifica `EXPO_PUBLIC_BACKEND_URL = https://tom-certov2-production.up.railway.app` (correta, viva)
2. Embute essa URL no novo JS bundle
3. Sobe o bundle para `https://u.expo.dev/aed3cb23-58bc-49d6-af3d-4fc5ed19a04f` (configurado no app.json)
4. Todos os APKs com `runtimeVersion: 2.0.0` recebem o update na próxima abertura

### Defesa extra adicionada nesta rodada

Mesmo se o `EXPO_PUBLIC_BACKEND_URL` voltar a estar errado no futuro, o código agora tem **fallback automático em cadeia**:
1. URL primária (do build env)
2. `https://tomcerto.online`
3. `https://tom-certov2-production.up.railway.app`

Se a primeira falhar com 404/5xx/network error, tenta a próxima automaticamente. Implementado em:
- `frontend/src/utils/mlKeyAnalyzer.ts` (analyzeKeyML + resetKeyAnalysisSession)
- `frontend/src/auth/AuthContext.tsx` (chain disponível para auth se precisar)

Validado em sandbox:
- URL primária boa → usa ela ✅
- URL primária morta (404) → fallback automático para tomcerto.online ✅
- DNS inválido → fallback ✅

## Validação após o OTA Update

### 1. O usuário precisa reabrir o app
Quando ele abrir, o app:
- Faz check de updates contra `u.expo.dev`
- Baixa o bundle novo (alguns MB, leva 1-3s em wifi)
- Reinicia automaticamente com o bundle novo

Se quiser ser explícito, pode forçar uma reabertura completa (fechar o app pelo gerenciador de tarefas, abrir de novo).

### 2. Como saber se o OTA chegou

No app, **vai aparecer o contador** "0/30s", "1/30s", "2/30s", "3/30s"... — coisa que não aparecia antes. Em **~10-15s** ele deve confirmar tom.

### 3. Monitoramento server-side

Você pode verificar se requests estão chegando rodando esta URL no navegador (depois de fazer um deploy MENOR com active-sessions endpoint que já está no código):
```
https://tom-certov2-production.up.railway.app/api/analyze-key/session-info
```
Mas para esse endpoint funcionar como listagem, eu preciso que você faça um **segundo deploy** (do `server.py` atualizado). Que inclui também o endpoint `/api/analyze-key/active-sessions` para você poder ver todas as sessões ativas.

## Plano de execução em ordem

**Recomendação:**

1. **FAÇA O OTA UPDATE PRIMEIRO** (sem novo deploy backend) — resolve 95% do problema:
   ```bash
   cd /app/frontend && eas update --branch production --message "Fase 1 + URL fallback"
   ```
2. Peça ao usuário pra reabrir o app e testar. Se já funcionar, **sucesso**.
3. (Opcional) Deploy do backend com os novos endpoints debug (`active-sessions`, `ping`) para monitoramento futuro.
4. (Opcional, para versão definitiva) **Build de APK novo** com `eas build --platform android --profile production-apk`. Isso elimina a necessidade do OTA no futuro.

## Riscos do OTA

- ⚠️ Se o `runtimeVersion` do APK 3.17.0 for diferente de 2.0.0 (improvável mas possível), o OTA não chega. Solução: build novo APK.
- ⚠️ Se o usuário desinstalou `expo-updates`, o OTA não funciona. Solução: build novo APK.
- ⚠️ Se o usuário está sem internet ao abrir o app, o OTA não baixa (mas tenta de novo no próximo open).

## Arquivos modificados nesta rodada (frontend)

- `frontend/src/utils/mlKeyAnalyzer.ts` — fallback chain automático
- `frontend/src/auth/AuthContext.tsx` — fallback chain disponível (cabeçalho)
- `frontend/src/hooks/useKeyDetection.ts` — UUID por sessão (Fase 3)
- `frontend/app/index.tsx` — boot reset aguarda deviceId

Todos já testados via `tsc --noEmit` sem erros.

## Por que o problema parecia ter mudado

Você relatou: "antes começava uma contagem de segundos, agora nem isso".

Hipótese: **o APK SEMPRE chamou a URL morta**, mas antes, o backend velho retornava algum erro mais "esperado" (talvez ainda algum endpoint sobrava ativo, ou o caminho de erro do frontend rodava `setMlResult` mesmo em falha parcial). Após o deploy do backend novo (v15-phase1) na URL **correta** (`tom-certov2-production.up.railway.app`), o backend antigo na URL **errada** (`tom-certo-v2.preview.emergentagent.com`) sumiu de vez (Emergent provavelmente derrubou a instância antiga), e agora retorna 404 puro. O frontend trata 404 como `success: false`, então mlResult fica null e a UI fica nos defaults eternos. Era essa a "mudança" que você sentiu.
