# Tom Certo v2 — Deploy no Railway + MongoDB Atlas

## Pré-requisitos
- Conta no [Railway](https://railway.app) ✅
- Conta no [MongoDB Atlas](https://cloud.mongodb.com) ✅
- Conta no [GitHub](https://github.com)

---

## 1º Passo — MongoDB Atlas (banco de dados permanente)

1. Acesse https://cloud.mongodb.com e crie um novo **Cluster gratuito** (M0, 512MB)
2. Em **Database Access** → crie um usuário:
   - Username: `tomcerto`
   - Password: gere uma senha forte e **anote**
3. Em **Network Access** → **Add IP Address** → "Allow Access from Anywhere" (`0.0.0.0/0`)
   - O Railway usa IPs dinâmicos, então precisa liberar geral
4. Em **Database** → **Connect** → **Drivers** → copie a connection string:
   ```
   mongodb+srv://tomcerto:<password>@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority
   ```
5. Substitua `<password>` pela senha real e **anote a string completa** — você vai usar no Railway

## 2º Passo — Push para GitHub

No Emergent, clique no botão **"Save to GitHub"** no topo:
- Conecte sua conta GitHub se ainda não estiver conectada
- Crie/escolha um repositório (ex: `tom-certo-v2`)
- Branch: `main`
- Confirme o push

O Emergent já vai pular os arquivos `.env` por causa do `.gitignore` correto.

## 3º Passo — Deploy no Railway

1. Acesse https://railway.app/dashboard
2. **+ New Project** → **Deploy from GitHub repo**
3. Autorize o Railway no seu GitHub (se ainda não autorizou)
4. Selecione o repositório `tom-certo-v2`
5. Railway vai detectar Python automaticamente. Aguarde o primeiro deploy começar.

### 3.1 Configurar variáveis de ambiente

No painel do Railway, abra o serviço e vá em **Variables** → **+ New Variable**.

Adicione:

| Nome | Valor |
|---|---|
| `MONGO_URL` | A connection string do Atlas (passo 1.5) |
| `DB_NAME` | `tom_certo_db` |
| `JWT_SECRET` | Gere com `openssl rand -hex 32` (32+ chars aleatórios) |
| `ADMIN_KEY` | A senha do seu painel admin (escolha algo forte) |

### 3.2 Gerar domínio público

- Vá em **Settings** → **Networking** → **Generate Domain**
- Você vai receber um domínio tipo `tomcerto-backend.up.railway.app`
- **Anote esse domínio** — é o link permanente do seu backend!

### 3.3 (Opcional) Domínio próprio

- Em **Settings** → **Custom Domain** → adicione `api.tomcerto.com.br` (por exemplo)
- Configure o CNAME no seu provedor de DNS apontando para o domínio Railway
- Railway emite SSL automaticamente

### 3.4 Verificar deploy

Acesse no navegador:
- `https://SEU-DOMINIO.up.railway.app/api/health` → deve retornar `{"status":"ok",...}`
- `https://SEU-DOMINIO.up.railway.app/api/admin` → painel admin permanente! 🎉

## 4º Passo — Atualizar o app Expo (mobile)

1. No `frontend/.env`, mude `EXPO_PUBLIC_BACKEND_URL` para o domínio Railway:
   ```
   EXPO_PUBLIC_BACKEND_URL="https://tomcerto-backend.up.railway.app"
   ```
2. Publique novo OTA via EAS:
   ```bash
   cd frontend
   EXPO_TOKEN="..." npx eas-cli update --branch preview --message "backend Railway"
   ```
3. Reabra o app no celular → vai puxar a versão que aponta pro Railway

## 5º Passo — Recriar token TEST-DEV2026 no novo banco

Apenas uma vez após o deploy, para popular o banco vazio:
```bash
curl -X POST https://SEU-DOMINIO.up.railway.app/api/admin/seed-test-token
```

Ou acesse o painel `/api/admin` com sua `ADMIN_KEY` e crie tokens manualmente.

---

## ⚠️ Custos estimados

- **MongoDB Atlas Free Tier**: grátis para sempre (até 512MB — milhares de tokens cabem)
- **Railway**: $5/mês de crédito grátis no plano hobby; um backend pequeno como esse consome ~$3-5/mês
- Total inicial: ~$5/mês em produção real

## 🔄 Workflow após deploy

- **Mudanças pequenas**: edite no Emergent → clique em "Save to GitHub" → Railway faz auto-deploy
- **Para não gastar créditos do Emergent**: clone localmente, edite no VS Code, `git push` direto
- App mobile: continua via EAS OTA, só muda a URL do backend no `.env`

## ✅ Checklist final

- [ ] Atlas: cluster criado, IP liberado, connection string em mãos
- [ ] GitHub: código enviado (sem `.env`!)
- [ ] Railway: projeto criado, variáveis configuradas, domínio gerado
- [ ] Health check `/api/health` retornando OK
- [ ] Admin panel `/api/admin` acessível com sua `ADMIN_KEY`
- [ ] App mobile atualizado com a nova URL
- [ ] Token de teste recriado
