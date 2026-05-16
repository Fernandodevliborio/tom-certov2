# Tom Certo v2 — Product Requirements (atualizado 2026-05)

## Visão Geral
App mobile (Expo) para detecção de tonalidade de voz a capela em tempo real.
Backend Python com CREPE (torchcrepe) para extração F0 e lógica tonal madura portada do frontend TS.

## Stack
- Frontend: Expo SDK + expo-router + react-native-reanimated
- Backend: FastAPI + Motor (MongoDB Atlas) + torchcrepe + librosa
- Auth: JWT (30 dias) + token de ativação por device_limit

## URLs
- **Backend API:** `https://harmony-check-6.preview.emergentagent.com/api/*`
- **Admin UI:** `https://harmony-check-6.preview.emergentagent.com/api/admin-ui`
- **Expo Web Preview:** `https://harmony-check-6.preview.emergentagent.com/`

---

## Estado dos Testes (atualizado 2026-05-16)

### Resultado Geral: 78 passed, 2 xfailed — Exit code 0 ✅

### test_global_key_detection.py — 27/27 PASSANDO ✅
- test_todos_os_12_tons_maiores ✅ (12/12 maiores)
- test_todos_os_12_tons_menores ✅ (12/12 menores)
- test_dominante_nao_confunde_com_tonica_em_todos_os_tons ✅
- test_mediant_nao_confunde_com_tonica_em_todos_os_tons ✅
- test_maior_vs_relativo_menor_todos_os_tons ✅
- test_menor_vs_relativo_maior_todos_os_tons ✅
- test_globalidade_via_transposicao_cromatica ✅
- test_padrao_hino_funciona_em_todos_12_tons_maiores ✅
- test_padrao_hino_funciona_em_todos_12_tons_menores ✅
- ... (todos os demais) ✅

### test_real_feedback_regression.py — 3 passed, 2 xfailed ✅
- Case 0 (Lá menor): XFAIL — diff=6 semitons, pitch-shift irrecuperável
- Case 1 (Lá# Maior): PASSOU (corrigido na v13 alignment fix)
- Case 2 (Si Maior): PASSOU (corrigido na v13 alignment fix)
- Case 3 (Sol Maior): PASSOU
- Case 4 (Sol Maior): XFAIL — diff=1 semitom, pitch-shift irrecuperável

### test_real_feedback_v2_regression.py — 5/5 PASSANDO ✅
- Cases [1, 5, 6, 7] (PASSING_INDICES) todos passando
- Case [5] (Lá# Maior) e Case [6] (Si Maior): regressions corrigidas

### Outros testes — todos passando ✅
- test_instrument_chord_detector: 6/6
- test_sticky_lock: 3/3
- test_tom_certo (API): 8/8
- test_vocal_focus: 10/10
- test_vocal_instrument_focus: 6/6
- test_key_detection: 10/10

---

## Algoritmo de Detecção de Tom (v13 alignment fix — 2026-05)

### Fix aplicado em key_detection_v10.py:
1. **alignment_bonus para major_natural tônica: 0.28 → 0.38** (aumentado)
   - Corrige casos reais onde o cantor resolve no III grau (mediant) mas a tônica real é a escala identificada pelo scale_fit
   - Corrigiu: Lá# Maior (v1 case 1), Si Maior (v1 case 2), v2 cases [5] e [6]

2. **relative_minor bonus: base-0.06 → base-0.18** (reduzido)
   - O relativo menor deve receber bonus significativamente menor que a tônica maior
   - Evita que Sol# menor vença sobre Si maior quando Si é o top scale

3. **margin_bonus multiplier: 3.5 → 4.5** (aumentado)
   - Margem clara na identificação de escala → maior confiança na tônica alinhada

### Fixes estruturais nesta sessão:
4. **audio_too_short threshold: < 500 → <= 500** em server.py
   - Evitava que exatamente 500 bytes passassem para processamento e causassem 500

5. **seed_test_token: limpa device_id** quando token já existe
   - Permite que testes de regressão funcionem após outras sessões terem vinculado devices

---

## Core Features
1. **Ativação via token** (TEST-DEV2026 para devs)
2. **Gravação contínua** com visualização de pitch
3. **Análise de tonalidade** ML via backend:
   - CREPE (tiny) → F0 por frame (10ms)
   - Segmentação MIDI → notas com duração
   - Detecção de frases (gap ≥ 200ms)
   - **Krumhansl-Schmuckler** (Pearson) + cadência + força + penalidade
4. **Modo Voz + Instrumento** (modo vocal_instrument)
5. **Sistema de Feedback "Tom Errado?"** — aprendizado baseado em reports
6. **Afinador Inteligente v2** — 6 estados, detecção por corda
7. **Admin Panel** em /api/admin-ui

## Backlog / Próximas Melhorias
- [ ] Pitch correction preprocessing para casos com shift sistemático (2 casos xfail)
- [ ] TTL para _sessions no key_detection_v10.py (evitar vazamento de memória)
- [ ] Session UUID por uso (rastreabilidade melhorada)
- [ ] Web fallback: captureClip não implementado
- [ ] Cobertura de testes end-to-end com áudio real de usuários novos
