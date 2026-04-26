# Tom Certo — Credenciais de Teste

## App Token (Ativação)
- **Código:** `TEST-DEV2026`
- **Descrição:** Token de desenvolvimento/teste (idempotente)
- **Device limit:** 10

## Painel Admin (HTML servido pelo FastAPI)
- **URL:** `https://tom-certo-v2.preview.emergentagent.com/api/admin-ui`
- **URL alternativa:** `/api/admin`
- **Chave Admin:** `tomcerto-admin-2026` (env var `ADMIN_KEY` no backend)

## API base
- **Backend:** `https://tom-certo-v2.preview.emergentagent.com` (prefixo `/api`)
- **Admin auth header:** `X-Admin-Key: tomcerto-admin-2026`
