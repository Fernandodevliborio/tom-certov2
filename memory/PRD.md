# Tom Certo v2 — PRD

## Visão Geral
App de detecção de tonalidade musical a cappella para iOS/Android.
Pipeline: Voz ao vivo → YIN/CREPE → Notas MIDI → Frases → Tonalidade.

## Arquitetura
- **Frontend**: Expo + React Native (TypeScript)
- **Backend**: FastAPI + Python
- **ML**: torchcrepe (CREPE) + librosa
- **DB**: MongoDB

## O que foi implementado (2026-04-23)

### Backend
- `key_detection.py` — Pipeline v2 completo:
  - `extract_f0_with_crepe()` — CREPE torchcrepe (99% precisão de pitch)
  - `compute_tonic_gravity()` — TonicAnchor (gravidade tonal global) ✅ NOVO
  - `alignment_boost()` — Multiplicador baseado em alinhamento tonal ✅ NOVO
  - `is_diatonic_degree_of()` — Guard anti-grau-diatônico ✅ NOVO
  - `is_relative_pair()` + `relative_tiebreak_score()` — Tiebreaker de relativos ✅ NOVO
  - `detect_key_from_notes()` — Orchestração completa v2 ✅ NOVO
  - `analyze_audio_bytes()` — Função pública principal
- `server.py` — FastAPI completo com:
  - Token auth (JWT): `/api/auth/validate`, `/api/auth/revalidate`
  - `/api/analyze-key` — Recebe WAV → retorna tonalidade (CREPE + TonicAnchor)
  - `/api/admin/tokens` (CRUD)
  - `/api/admin/seed-test-token` — Token de teste TEST-DEV2026

### Frontend (React Native / Expo)
- `src/audio/yin.ts` — YIN pitch detection (tempo real, web + native)
- `src/audio/usePitchEngine.ts` — Engine nativa (@siteed/audio-studio)
- `src/audio/usePitchEngine.web.ts` — Engine web (Web Audio API + YIN)
- `src/auth/AuthContext.tsx` — Context de autenticação (validate + revalidate)
- `src/auth/ActivationScreen.tsx` — Tela de ativação de token
- `src/auth/storage.ts` — SecureStore wrapper
- `src/auth/deviceId.ts` — Device ID estável
- `src/utils/phraseKeyDetector.ts` — Detector por frases (segmentação de notas)
- `src/utils/tonicAnchor.ts` — Âncora de tônica (gravidade tonal)
- `src/utils/tonalScorer.ts` — Scoring tonal com Krumhansl + cadência + força
- `src/utils/keyDetector.ts` — Detector heurístico de tonalidade
- `src/utils/mlKeyAnalyzer.ts` — Client do backend (envia WAV, recebe tonalidade)
- `src/utils/noteUtils.ts` — Utilitários de notas (BR + INTL)
- `src/components/AudioVisualizer.tsx` — Visualizador de amplitude animado
- `src/hooks/useKeyDetection.ts` — Hook principal de detecção (YIN + ML backend)
- `app/_layout.tsx` — Root layout com AuthGate
- `app/index.tsx` — Tela principal (Initial + Active screens)

## Pacotes instalados
### Python
- torch 2.11.0+cpu, torchaudio, torchcrepe 0.0.24, librosa 0.11.0, soundfile 0.13.1, PyJWT, bcrypt

### JavaScript
- @siteed/audio-studio@3.0.3, expo-application, expo-secure-store
- expo-linear-gradient@15.0.8, expo-updates@29.0.16
- @expo-google-fonts/manrope, @expo-google-fonts/outfit

## Token de Teste
- `TEST-DEV2026` (Device Limit: 10, sem expiração)

## Backlog P0/P1/P2

### P0 — Crítico
- [ ] Testar CREPE em áudio real no dispositivo Android/iOS
- [ ] Verificar latência total (captura 10s + análise CREPE)
- [ ] Validar casos problemáticos: Sol Maior → Ré Maior → Lá menor

### P1 — Importante
- [ ] Adicionar tela de resultado ML com visualização de confiança e top candidatos
- [ ] Proteger endpoints `/api/admin/*` com autenticação
- [ ] Cache de modelos CREPE (evitar reload a cada requisição)
- [ ] Otimizar tamanho do áudio WAV enviado (compressão)
- [ ] Adicionar logo real do Tom Certo (substituir Ionicons placeholder)

### P2 — Nice to have
- [ ] Histórico de sessões de detecção no MongoDB
- [ ] Dashboard admin web para gestão de tokens
- [ ] Analytics de uso por token/device
- [ ] Modo offline com modelo CREPE tiny embarcado

## Próximos passos sugeridos
1. Testar em dispositivo físico (Android/iOS) com áudio real
2. Implementar cache de modelo CREPE para menor latência
3. Adicionar tela de resultado ML mais rica (campo harmônico com confiança)
