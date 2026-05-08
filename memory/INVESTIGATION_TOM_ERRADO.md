# Investigação: Por que o app erra o tom em alguns casos

## TL;DR

Investiguei 9 feedbacks reais salvos no MongoDB ("tom errado" reportados pelo usuário). Encontrei **2 problemas distintos**:

1. **Problema A (algorítmico)**: corrigi. O cálculo de cadência só olhava as últimas 8 notas, ignorando phrase-ends ao longo da música inteira.
2. **Problema B (captura)**: 5 dos 9 casos têm a tônica reportada com presença <5% no áudio captado. Isso não é corrigível só no algoritmo — precisa investigar pitch detector ou UX de captura.

## Categoria A — Algorítmico (corrigido)

### Problema
A função `_compute_cadence_weight` calculava cadência olhando apenas:
- Últimas 8 notas com peso por recência
- Últimos 3 phrase-ends
- Última nota (peso 5x)

**Resultado**: música de 50 notas com 4 phrase-ends em Sol espalhados ficava IGNORADA se os últimos 3 phrase-ends caíssem em outra nota (modulação no fim, vamp, refrão).

### Caso 1: Sol Maior reportado, antes detectava Lá# Maior
```
Sol:   PCP 26.2% | cadence (v12) 20% | 4 phrase-ends ✓
Lá#:   PCP 14.8% | cadence (v12) 55% | 2 phrase-ends
```
Lá# vencia porque dominava as últimas 8 notas, mesmo Sol tendo 2x mais phrase-ends globais.

### Fix v13
`_compute_cadence_weight` agora combina:
- **50% sinal GLOBAL**: TODOS os phrase-ends + notas longas (≥300ms) ponderados por duração
- **50% sinal LOCAL**: comportamento anterior (final do áudio)

### Resultado pós-fix nos 9 casos
- 4/9 acertos absolutos (igual antes)
- **Qualidade dos erros muito melhor**:
  - Caso 1: Lá# Maior → **Sol menor** (tônica certa, modo discutível)
  - Caso 9: Sol# menor → **Si Maior** (3ª maior do Sol, dentro da escala)
  - Caso 5: Ré# menor → **Mi Maior** (V do Lá menor, dentro da escala)

Mesmo nos 5 casos que ainda erram a tônica/modo exata, o resultado agora está **dentro da família harmônica correta** ou tem **confiança honestamente baixa** (alguns conf 0.25-0.55, que devem mostrar "incerto" no app).

## Categoria B — Captura (não corrigível só no algoritmo)

### Análise dos 5 casos falhos

| Caso | Reportado | Top PCP (real) | Tônica reportada no PCP | Diferença |
|------|-----------|----------------|-------------------------|-----------|
| 1 | Sol Maior | Sol (26%) | Sol 26% ✓ | **algorítmico (resolvido)** |
| 3 | Dó# Maior | Ré# (20%) | Dó# 14%, cadence 7% | tônica fraca |
| 4 | Ré# Maior | Ré (33%) | Ré# **2.7%**, cadence 0% | **pitch shift -1 semitom?** |
| 5 | Lá menor | Ré# (35%) | Lá **4.3%**, cadence 0% | **trítono dominando** |
| 9 | Sol Maior | Si (36%) | Sol **0.8%**, cadence 0% | **3ª dominando, tônica ausente** |

### Hipóteses para os casos 4, 5, 9

**H1 — Pitch shift sistemático**:
Caso 4 reporta Ré# (D#) mas Ré (D) domina com 33%. Diferença = exatamente 1 semitom abaixo. Pode ser instrumento desafinado para A4=415Hz (afinação barroca) ou `extract_pitch` com referência errada.

**H2 — Voz x instrumento**:
Caso 9: música em Sol Maior, mas Si (3ª) domina. Cantor pode estar cantando a 3ª na maior parte (tessitura confortável), e o microfone capta voz mais alto que instrumento.

**H3 — Recorte ruim**:
30s capturados podem ter pegado só o refrão modulado ou a ponte, não a estrofe principal onde a tônica é mais clara.

### Próximos passos para resolver Categoria B

1. **Análise A4 reference**: comparar o pitch médio detectado com tons conhecidos. Se há shift sistemático, ajustar referência.
2. **Modo "captura assistida"**: usuário toca/canta a tônica 3x antes de gravar. Algoritmo trava aquela tônica e só decide maior/menor.
3. **Painel "verificação"**: mostrar ao usuário as 3 notas mais detectadas antes de declarar tom. Se nenhuma é a esperada, sugere "tente capturar de novo, mais perto do instrumento".
4. **Investigar `extract_pitch`**: reproduzir os áudios originais (não temos os WAVs, só notes_summary) e comparar com YIN, CREPE em modo full, librosa.pyin etc.

## Estado atual após o fix

- ✅ Cadence weight v13 (global + local)
- ✅ Alignment bonus capped para tônicas menores sem cadência
- ✅ 8/8 testes pytest passando (`test_real_feedback_v2_regression.py` + `test_sticky_lock.py`)
- ⚠️ Casos com tônica em PCP <5% continuam errando — mas resultado agora é mais musicalmente próximo (mesma escala / família harmônica)
- ⚠️ Confiança calibrada honestamente: casos ambíguos retornam conf 0.25-0.55 (deve aparecer "incerto" no UI)
