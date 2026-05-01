# Tom Certo v2 — Guia Completo de Configuração Railway + MongoDB

## ANÁLISE DO PROJETO

- **Backend**: Python 3.11 + FastAPI — via Railway (Dockerfile)
- **Mobile**: React Native + Expo (EAS/OTA)
- **Banco**: MongoDB Atlas
- **Email**: Resend
- **Pagamentos**: Cakto + Ticto (webhooks)
- **Domínio**: tomcerto.online

---

## SEÇÃO A — PASSO A PASSO COMPLETO

### Passo 1 — Confirmar MongoDB Atlas em funcionamento

1. Acesse https://cloud.mongodb.com
2. Verifique que o cluster `Cluster0` está ativo (status verde)
3. Em **Database Access** → confirme que o usuário `tomcerto` existe e tem a senha correta
4. Em **Network Access** → confirme que `0.0.0.0/0` está liberado (necessário para Railway IPs dinâmicos)
5. Teste a connection string manualmente (próxima seção)

### Passo 2 — Configurar variáveis no Railway

1. Acesse https://railway.app/dashboard
2. Abra o projeto **tom-certov2** (ou o nome que aparece linkado ao seu GitHub)
3. Clique no serviço de backend
4. Vá em **Variables** (aba lateral)
5. Adicione **cada variável da Seção B** abaixo (uma por vez ou usando o editor Raw)

### Passo 3 — Verificar o deploy

Após adicionar as variáveis, o Railway faz redeploy automático. Aguarde ~2-3 min e teste:

```
https://tom-certov2-production.up.railway.app/api/health
```

Resposta esperada: `{"status":"ok","timestamp":"..."}`

### Passo 4 — Testar autenticação admin

```
curl -X POST https://tom-certov2-production.up.railway.app/api/admin/login \
  -H "Content-Type: application/json" \
  -d '{"username":"Admin01","password":"adminfernando"}'
```

Resposta esperada: `{"token":"eyJ..."}`

### Passo 5 — Acessar painel admin

```
https://tom-certov2-production.up.railway.app/api/admin
```

Use a ADMIN_KEY ou o login com usuário/senha configurados.

### Passo 6 — Validar webhooks

- **Cakto**: Configure o webhook URL para `https://tom-certov2-production.up.railway.app/api/webhook/cakto`
- **Ticto**: Configure o webhook URL para `https://tom-certov2-production.up.railway.app/api/webhook/ticto`

---

## SEÇÃO B — LISTA COMPLETA DE VARIÁVEIS DE AMBIENTE

Essas são TODAS as variáveis obrigatórias para o projeto funcionar:

| Variável | Valor | Obrigatório? |
|---|---|---|
| `MONGO_URL` | `mongodb+srv://tomcerto:<SENHA>@cluster0.dwqxpqx.mongodb.net/tom_certo_db?retryWrites=true&w=majority&appName=Cluster0` | ✅ CRÍTICO |
| `DB_NAME` | `tom_certo_db` | ✅ |
| `JWT_SECRET` | String aleatória 64+ chars | ✅ CRÍTICO |
| `ADMIN_KEY` | Senha do painel admin legado | ✅ |
| `ADMIN_USERNAME` | Nome de usuário admin | ✅ |
| `ADMIN_PASSWORD` | Senha do admin | ✅ |
| `DOMAIN` | `tomcerto.online` | ✅ |
| `RESEND_API_KEY` | Chave da API do Resend | ✅ Email |
| `FROM_EMAIL` | `Tom Certo <no-reply@tomcerto.online>` | ✅ Email |
| `APK_DOWNLOAD_URL` | `https://tomcerto.online/download/apk` | ✅ |
| `CAKTO_API_ID` | ID da API Cakto | ✅ Pagamentos |
| `CAKTO_API_TOKEN` | Token da API Cakto | ✅ Pagamentos |
| `CAKTO_WEBHOOK_SECRET` | Secret do webhook Cakto | ✅ Pagamentos |
| `TICTO_WEBHOOK_TOKEN` | Token do webhook Ticto | ✅ Pagamentos |

### Formato Raw para copiar no Railway (editor de variáveis em lote):

```
MONGO_URL=mongodb+srv://tomcerto:<SENHA>@cluster0.dwqxpqx.mongodb.net/tom_certo_db?retryWrites=true&w=majority&appName=Cluster0
DB_NAME=tom_certo_db
JWT_SECRET=b0f1074045c7f7c54e8dada98e0f13d81d832cc01c58b550eb499223121a60e1e885392ee774491e570b273f943ce3d0
ADMIN_KEY=tomcerto-admin-2026
ADMIN_USERNAME=Admin01
ADMIN_PASSWORD=adminfernando
DOMAIN=tomcerto.online
RESEND_API_KEY=re_XtEhuDDK_4kGT1B8z6oggbgBQyx9NSz6J
FROM_EMAIL=Tom Certo <no-reply@tomcerto.online>
APK_DOWNLOAD_URL=https://tomcerto.online/download/apk
CAKTO_API_ID=HCci8XGfjZ6NY6lUxD1LASkUf6359PMQcDujXfAL
CAKTO_API_TOKEN=tkYlJqWfntNgk06P1M8pf7eN7VlVbSLp6ZoIVe1tdwKLSdOQoZ0n23utre44iCnUeela7M0aNPFBfR8rDSWlXgeE28NxcEhEYITJgby1dGiLd4WL0P7ONCTX06R95RuU
CAKTO_WEBHOOK_SECRET=8d66030c-6d78-433b-beb7-3a78465c4a82
TICTO_WEBHOOK_TOKEN=nUwkIigeBg3PmpPBIYazPSROvI1FvJghpg6ovpnaaUOPD66pCExSIG0N1d0PymOl1KPXPR1tGXj8LZiI6sTlNPiHR59FO5OjR2Zj
```

> ⚠️ Substitua `<SENHA>` pela senha real do MongoDB Atlas antes de usar.

---

## SEÇÃO C — ONDE CONFIGURAR CADA VARIÁVEL NO RAILWAY

### Como abrir o editor de variáveis no Railway:

```
Railway Dashboard → [Seu Projeto] → [Serviço do Backend] → Variables (aba no topo)
```

### Opção 1 — Adicionar uma por vez:
- Clique em **"+ New Variable"**
- Digite o nome e o valor
- Repita para cada variável

### Opção 2 — Editor Raw (mais rápido):
- Clique em **"RAW Editor"** (botão no canto superior direito da aba Variables)
- Cole o bloco de variáveis da Seção B
- Clique em **"Update Variables"**
- Railway reinicia automaticamente o serviço

### ⚠️ ATENÇÃO: Variável PORT
- O Railway define `$PORT` automaticamente — **NÃO adicione `PORT` manualmente**
- O `Dockerfile` já usa `${PORT:-8001}` corretamente

---

## SEÇÃO D — TESTES OBRIGATÓRIOS PARA VALIDAR FUNCIONAMENTO

### D1 — Health Check (Backend online)
```bash
curl https://tom-certov2-production.up.railway.app/api/health
```
✅ Esperado: `{"status":"ok","timestamp":"2025-..."}`

### D2 — Conexão MongoDB (implícita no health check)
Se o health retornar OK, o MongoDB está conectado. Para confirmar explicitamente:
```bash
curl https://tom-certov2-production.up.railway.app/api/admin/stats \
  -H "X-Admin-Key: tomcerto-admin-2026"
```
✅ Esperado: JSON com estatísticas (total de tokens, etc.)

### D3 — Autenticação Admin (Login com JWT)
```bash
curl -X POST https://tom-certov2-production.up.railway.app/api/admin/login \
  -H "Content-Type: application/json" \
  -d '{"username":"Admin01","password":"adminfernando"}'
```
✅ Esperado: `{"token":"eyJ..."}`

### D4 — Painel Admin (via browser)
Acesse: `https://tom-certov2-production.up.railway.app/api/admin`
✅ Esperado: Interface HTML do painel admin carrega

### D5 — Validação de Token (App mobile)
```bash
curl -X POST https://tom-certov2-production.up.railway.app/api/auth/validate \
  -H "Content-Type: application/json" \
  -d '{"token":"TEST-0001","device_id":"test-device-123"}'
```
✅ Esperado: `{"valid":true,...}` (se o token TEST-0001 existir)

### D6 — Criar token de teste (seed)
```bash
curl -X POST https://tom-certov2-production.up.railway.app/api/admin/seed-test-token
```
✅ Esperado: `{"message":"Token de teste criado",...}`

### D7 — Testar envio de email (Resend)
```bash
curl -X POST https://tom-certov2-production.up.railway.app/api/admin/test-email \
  -H "X-Admin-Key: tomcerto-admin-2026" \
  -H "Content-Type: application/json" \
  -d '{"email":"seu@email.com"}'
```
✅ Esperado: Email recebido na caixa de entrada

### D8 — Testar webhook Cakto (simulação)
```bash
curl -X POST https://tom-certov2-production.up.railway.app/api/webhook/cakto \
  -H "Content-Type: application/json" \
  -H "X-Cakto-Signature: test" \
  -d '{"event":"pagamento_aprovado","transaction_id":"TEST-001","customer_name":"Teste","customer_email":"teste@exemplo.com","plan":"mensal"}'
```
✅ Esperado: `{"status":"processed",...}`

---

## SEÇÃO E — CHECKLIST FINAL DE VERIFICAÇÃO

### Infraestrutura
- [ ] MongoDB Atlas: cluster ativo, usuário com permissão de leitura/escrita, IP 0.0.0.0/0 liberado
- [ ] Railway: projeto linkado ao GitHub, variáveis configuradas, deploy verde
- [ ] Health check `/api/health` retornando `{"status":"ok"}`
- [ ] Domínio `tom-certov2-production.up.railway.app` acessível

### Backend
- [ ] Login admin funcionando (JWT gerado)
- [ ] Painel `/api/admin` acessível
- [ ] Tokens podem ser criados via admin
- [ ] Tokens podem ser validados via `/api/auth/validate`
- [ ] Stats do MongoDB retornando corretamente

### Integrações
- [ ] Resend: email de boas-vindas enviado com sucesso
- [ ] Cakto webhook: URL configurada no painel Cakto apontando para Railway
- [ ] Ticto webhook: URL configurada no painel Ticto apontando para Railway

### App Mobile
- [ ] APK atual usa `https://tom-certov2-production.up.railway.app` como backend
- [ ] Login com token funciona no app
- [ ] OTA updates configurados (Expo Project ID: `aed3cb23-58bc-49d6-af3d-4fc5ed19a04f`)

---

## SEÇÃO F — PONTOS DE FALHA E COMO EVITAR

### F1 — MONGO_URL com senha errada
**Sintoma**: Backend não inicia, erro `ServerSelectionTimeoutError`
**Solução**: Confirme a senha no Atlas → Database Access → Edit User → Show Password
**Dica**: A senha no Atlas não pode ter caracteres especiais como `@`, `#`, `%` sem codificação URL. Use letras e números.

### F2 — IP não liberado no MongoDB Atlas
**Sintoma**: Backend sobe mas não consegue conectar ao banco
**Solução**: Atlas → Network Access → Add IP Address → `0.0.0.0/0`

### F3 — URL do APK hardcoded (ATENÇÃO!)
**Problema encontrado**: A linha 1292 do `server.py` tem uma URL hardcoded:
```python
APK_EXTERNAL_URL = "https://customer-assets.emergentagent.com/job_credentials-deploy-1/artifacts/o2k0a39r_apptomcerto.apk"
```
Esta URL aponta para o ambiente Emergent anterior e pode parar de funcionar.
**Solução recomendada**: Adicionar variável `APK_EXTERNAL_URL` no Railway com a URL real do APK atual (ex: link do Google Drive, S3, ou EAS Build).

### F4 — JWT_SECRET diferente entre deploys
**Sintoma**: Tokens de sessão expiram sem motivo
**Solução**: Usar sempre o mesmo `JWT_SECRET` em todos os deploys. NUNCA mudar após usuários terem sessões ativas.

### F5 — Webhook Cakto/Ticto com URL errada
**Sintoma**: Pagamentos aprovados mas tokens não são criados
**Solução**: Verificar nos painéis da Cakto e Ticto se os webhooks apontam para:
- Cakto: `https://tom-certov2-production.up.railway.app/api/webhook/cakto`
- Ticto: `https://tom-certov2-production.up.railway.app/api/webhook/ticto`

### F6 — FROM_EMAIL com domínio não verificado no Resend
**Sintoma**: Emails não chegam, erro 403 no Resend
**Solução**: No painel do Resend (resend.com/domains), confirme que `tomcerto.online` está verificado (DNS configurado)

### F7 — App mobile com URL do backend errada
**Sintoma**: App não consegue validar tokens
**Local da configuração**: `frontend/app.json` → `extra.backendUrl`
**Valor correto**: `https://tom-certov2-production.up.railway.app`
**Atualização sem rebuild**: Publicar novo OTA via EAS Update

### F8 — Expo/EAS vinculado à conta Expo anterior
**Sintoma**: OTA updates não chegam ao app
**Verificação**: A conta Expo `apptomcertoapk` (dono do projeto EAS `aed3cb23-58bc-49d6-af3d-4fc5ed19a04f`) deve estar acessível
**Solução**: Logar na conta `apptomcertoapk` no Expo e continuar publicando OTAs normalmente

---

## ENDEREÇOS IMPORTANTES

| Serviço | URL |
|---|---|
| Backend Railway | `https://tom-certov2-production.up.railway.app` |
| Health Check | `https://tom-certov2-production.up.railway.app/api/health` |
| Painel Admin | `https://tom-certov2-production.up.railway.app/api/admin` |
| Webhook Cakto | `https://tom-certov2-production.up.railway.app/api/webhook/cakto` |
| Webhook Ticto | `https://tom-certov2-production.up.railway.app/api/webhook/ticto` |
| Download APK | `https://tom-certov2-production.up.railway.app/download/apk` |
| MongoDB Atlas | `https://cloud.mongodb.com` |
| Resend | `https://resend.com` |
| EAS Dashboard | `https://expo.dev/accounts/apptomcertoapk/projects/tom-certo-v2` |
