# OTA Deploy — Tom Certo v2.0.0

Guia rápido para publicar a UX "Analisando X/4" via OTA, sem regerar APK.

## ✅ Pré-requisitos

- Node.js instalado no seu computador
- Acesso à conta Expo `apptomcertoapk` (mesma que gerou o APK em produção)

## 🚀 Comando único (copy/paste)

Abra terminal na pasta `frontend/` do projeto **localmente** (após `git pull` ou Save to GitHub):

```bash
cd frontend
npx eas-cli@latest update --channel production --message "v2.0.1 - UX Analisando X/4 + correções de detecção de tom"
```

Na primeira vez vai pedir login:
- **Username**: `apptomcertoapk`
- **Password**: a senha da sua conta Expo

## 📋 O que esse comando faz

1. Compila o JavaScript do app com as alterações novas (`mlKeyAnalyzer.ts`, `index.tsx`)
2. Faz upload para os servidores Expo
3. Disponibiliza no canal `production` com `runtimeVersion: 2.0.0`
4. **Apps já instalados pelos usuários recebem a atualização automaticamente** ao abrir o app pela próxima vez (cache `fallbackToCacheTimeout: 30000` = espera até 30s pelo update)

## 🔍 Verificação após publicar

1. Acesse https://expo.dev/accounts/apptomcertoapk/projects/tom-certo-v2/updates
2. Você deve ver a nova update aparecer com a mensagem
3. No celular: feche o app totalmente, espere 5s, abra de novo. A atualização baixa em background; pode pedir mais 1 abertura para entrar em vigor

## 🎯 O que o usuário vai ver após receber o OTA

- Toca o botão "Detectar" → card "ANALISANDO 1/4" com barra dourada 25%
- Aos 10s → "ANALISANDO 2/4" com barra 50%
- Aos 15s → "ANALISANDO 3/4" com barra 75%
- Aos 20s → barra desaparece, tom detectado em verde

## ⚠️ Se quiser desfazer

```bash
npx eas-cli@latest update:republish --channel production
```
Depois selecione a versão anterior na lista.

## 💡 Próxima vez (mais rápido)

Defina um EAS Token persistente:
1. https://expo.dev/accounts/apptomcertoapk/settings/access-tokens
2. Crie token com permissão "Updates"
3. Salve em `~/.bashrc`: `export EXPO_TOKEN=seu_token_aqui`
4. Aí o comando fica direto, sem login interativo
