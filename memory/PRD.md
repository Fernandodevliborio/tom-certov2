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
- **Backend API:** `https://backend-verify-16.preview.emergentagent.com/api/*`
- **Admin UI:** `https://backend-verify-16.preview.emergentagent.com/api/admin-ui`
- **Expo Web Preview:** `https://backend-verify-16.preview.emergentagent.com/`

## Stack
- Frontend: Expo SDK + expo-router + react-native-reanimated
- Backend: FastAPI + Motor (MongoDB) + torchcrepe + librosa
- Auth: JWT (30 dias) + token de ativação por device_limit

## Algoritmo de Detecção de Tom (v6 — definitivo)
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
- ✅ **Landing Page** — refatorada de 3 → 2 planos (Essencial e Profissional) em `/app/backend/tom-certo-emergent-ready/standalone-html/index.html`
- ✅ **Railway + MongoDB Setup** — variáveis de ambiente configuradas (ver `/app/RAILWAY_SETUP_GUIDE.md`)
- ✅ **Branding & Copy refinement (Feb 2026)**:
  - Removida promessa "Teste grátis" da landing → "Escolha seu plano e comece agora."
  - Frase "Pagamento seguro..." centralizada com `mt-16`, fonte 13px, cor #666 (75% opacidade)
  - Favicon Tom Certo (logo dourado em fundo preto) servido em `/favicon.ico`, `/favicon.png`, `/favicon-256.png`, `/apple-touch-icon.png`
  - Tags `<link rel="icon">` adicionadas em landing, admin UI e página de download
  - Email de credenciais com URL de download corrigida para `https://tomcerto.online/download`
