# Tom Certo v2 — Product Requirements

## Visão Geral
App mobile (Expo) para detecção de tonalidade de voz a capela em tempo real.
Backend Python com CREPE (torchcrepe) para extração F0 e lógica tonal madura portada do frontend TS.

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
- **Backend API:** `https://tom-certo-v2.preview.emergentagent.com/api/*`
- **Admin UI:** `https://tom-certo-v2.preview.emergentagent.com/api/admin-ui`
- **Expo Web Preview:** `https://tom-certo-v2.preview.emergentagent.com/`

## Stack
- Frontend: Expo SDK + expo-router + react-native-reanimated
- Backend: FastAPI + Motor (MongoDB) + torchcrepe + librosa
- Auth: JWT (30 dias) + token de ativação por device_limit

## Status
- ✅ Migração do repo GitHub
- ✅ Ativação + gravação
- ✅ Lógica avançada de tonalidade (portada TS→Python)
- ✅ Painel admin HTML restaurado e servido pelo FastAPI
- ⏳ Bateria de testes de drift tonal (Sol→Ré→Lá menor)
- ⏳ OTA publish
