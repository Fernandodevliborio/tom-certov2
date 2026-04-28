# 📱 Tom Certo - Guia de Atualizações OTA

## ⚠️ REGRA DE OURO
**TODOS os builds e updates usam o canal `production`.**  
Isso garante que qualquer APK receba qualquer atualização.

---

## 🚀 Publicar Atualização OTA

### Opção 1: Script Automatizado (Recomendado)
```bash
cd /app/frontend
EXPO_TOKEN=seu_token ./publish-update.sh "Descrição da atualização"
```

### Opção 2: Comando Manual
```bash
cd /app/frontend
EXPO_TOKEN=seu_token npx eas-cli update --channel production --message "Descrição"
```

---

## 🔨 Gerar Novo Build APK

### APK para teste interno:
```bash
EXPO_TOKEN=seu_token npx eas-cli build --platform android --profile preview
```

### APK para produção:
```bash
EXPO_TOKEN=seu_token npx eas-cli build --platform android --profile production-apk
```

### App Bundle para Play Store:
```bash
EXPO_TOKEN=seu_token npx eas-cli build --platform android --profile production
```

---

## ✅ Configuração Atual (eas.json)

| Profile        | Canal       | Formato     |
|----------------|-------------|-------------|
| development    | production  | APK (debug) |
| preview        | production  | APK         |
| production     | production  | AAB         |
| production-apk | production  | APK         |

**Todos os profiles usam o canal `production`!**

---

## 📲 Como o Usuário Recebe a Atualização

1. **Fechar completamente** o app (não apenas minimizar)
2. **Abrir o app** e aguardar 10-15 segundos na tela inicial
3. **Fechar e abrir novamente** - a atualização será aplicada

---

## 🔍 Verificar Status

### Ver builds existentes:
```bash
EXPO_TOKEN=seu_token npx eas-cli build:list --platform android --limit 5
```

### Ver updates publicados:
```bash
EXPO_TOKEN=seu_token npx eas-cli update:list --branch production --limit 5
```

---

## ❌ O QUE NÃO FAZER

1. **NUNCA** publique updates em canais diferentes de `production`
2. **NUNCA** mude o `channel` no eas.json sem necessidade
3. **NUNCA** use `--channel preview` ou `--channel development` no comando de update

---

## 🆘 Solução de Problemas

### Updates não chegam no celular:
1. Verifique se o APK foi buildado com canal `production`
2. Verifique se o update foi publicado no canal `production`
3. O usuário precisa fechar e abrir o app 2x

### Erro de Hermes (ARM64):
O script `publish-update.sh` já configura automaticamente o wrapper necessário.

---

## 📊 Dashboard EAS
https://expo.dev/accounts/fernandosliborio/projects/tom-certo-v2

---

*Última atualização: Abril 2026*
