# Test Credentials — Tom Certo v2

## Backend API
- **Preview (local):** `https://vocal-shield.preview.emergentagent.com`
- **Production (Railway):** `https://tomcerto.online`

## Expo
- **Account:** `apptomcertoapk`
- **Email:** `adsfernandoliborioo@gmail.com`
- **EXPO_TOKEN:** `d9YL956Vc3ItW2GqboE1xzXr7Gzg6_kciRMyZwls`
  - Usage: `EXPO_TOKEN=... eas update --branch production --message "..."`

## Test Token for activation
- **TEST-DEV2026** (used for dev testing)

## Admin UI
- **URL:** `/api/admin-ui` or `/api/admin`
- **Header:** `X-Admin-Key: <ADMIN_KEY>` (set in backend env)

## MongoDB
- Connection via `MONGO_URL` env var (see backend/.env)
- DB Name: see `DB_NAME` env var
- Collection used for wrong-key feedback: `key_feedback`
