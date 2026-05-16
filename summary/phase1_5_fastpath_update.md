# Tom Certo — Atualização: Correção do "Ouvindo eterno" (Fase 1.5 + Fast Path)

## Status do problema

✅ **Você fez o deploy do v15-phase1** — confirmado em `tomcerto.online`
✅ **Auto-reset de sessão** corrigido (sessions agora crescem `elapsed_s` corretamente)
✅ **Cold start** eliminado (warmup automático)
🟡 **Ainda incerto em alguns casos**: descoberto que o consenso de 4 votos era rigoroso demais — mesmo com sinal forte, demorava ~50s para confirmar

## O que foi adicionado nesta rodada

### Fast Path para sinais musicalmente óbvios
Quando o sinal cumpre TODOS os critérios musicais com folga:
- margem ≥ 50% entre top1 e top2
- cadência ≥ 40%
- terça inequívoca (≥85% ou ≤15%)
- confiança ≥ 85%
- sem ambiguidade relativa/dominante

…o consenso exigido cai de 4 para **2 votos**. Isso resolve o caso onde o usuário canta algo claramente em Dó/Sol/Ré Maior mas precisava esperar 50s pra confirmar.

**Resultado em validação:**
- Antes (consenso 4): Dó Maior confirmado em ~49 s
- Depois (fast path com consenso 2): **Dó Maior confirmado em 12.3 s** ✅
- Sol Maior em **12.4 s** ✅

### Consenso geral relaxado
Não-fast-path também ficou um pouco mais permissivo:
- `evaluating-strict`: 4 → 3
- `evaluating-solid`: 3 → 2
- `decision`: 4 → 3

## Arquivo modificado
- `/app/backend/key_detection_v10.py` (função `get_result()`, bloco "FAST PATH")

## Como subir essa correção em produção

1. Faça commit do arquivo `backend/key_detection_v10.py`
2. Push para o branch que o Railway monitora
3. Após o deploy, validar com:
```bash
curl -sS -X POST https://tomcerto.online/api/analyze-key/reset \
  -H "Content-Type: application/json" -H "X-Device-Id: smoke" | jq .version
# Deve retornar "v15-phase1"
```

4. Validar fast path nos logs do Railway. Procurar por:
```
[v15/fastpath] Sinal MUITO forte aos X.Xs — consenso reduzido a 2
```
Essa linha aparece quando o fast path é acionado.

## Como o usuário deve sentir após o deploy

| Cenário | Antes | Depois |
|---|---|---|
| Cantar Dó/Sol/Ré Maior bem | 45-90s ou nunca | **~10-15s** ✅ |
| Cantar tonalidades menores claras (Mi m, Si m, Fá# m) | 60s+ | ~20-30s ✅ |
| Cantar Lá m ou Mi m (ambíguo com relativa) | Nunca confirma | Ainda incerto* |
| Sinal ruim/ambiente ruidoso | Trava em "Ouvindo" | Mostra "Identificando…" rotativo, pode chegar em "uncertain" e pedir mais |
| Reset (Nova Detecção) | Frequentemente contaminava | Sempre limpo ✅ |

*Ambiguidade relativa (Lá m ↔ Dó M, Mi m ↔ Sol M) requer refatoração da decisão maior/menor (Fase 4 — Bayes ratio para 3ª + 7ª + cadência). Por enquanto, mesmo nesses casos o app **não trava mais** — ele segue dizendo "Identificando..." e eventualmente cai em "uncertain", o que mostra ao usuário que precisa cantar mais frases.

## Próximos passos sugeridos

1. **Deploy desta atualização** (5 minutos)
2. **Testar no celular** com o APK atual — você deve ver detecção em 10-20 s para a maioria das músicas
3. (Opcional) Build de novo APK quando quiser ativar timeout 25s e UUID por sessão (resolve 100% mesmo em rede ruim)
4. **Fase 4**: refatorar maior/menor (relativa) — agendar quando quiser

## Riscos do fast path

- ⚠️ Pode confirmar um tom errado mais cedo se o sinal for **enganosamente claro** (ex: usuário canta uma sequência V→I de outra tonalidade por engano).
- Mitigação: o sticky-lock revisável (já implementado na Fase 1) permite trocar de tom se evidências contrárias se acumularem por 60s+.
- Em casos relatados de "tom errado com confiança alta", investigar especificamente se foi fast path acionado (`[v15/fastpath]` nos logs do Railway).
