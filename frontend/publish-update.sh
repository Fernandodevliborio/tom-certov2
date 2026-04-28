#!/bin/bash
# ==============================================
# SCRIPT DE PUBLICAÇÃO OTA - TOM CERTO
# ==============================================
# Uso: ./publish-update.sh "Mensagem do update"
# 
# IMPORTANTE: Canal preview está mapeado para branch production
# Isso significa que TODOS os APKs (preview e production) recebem
# os updates publicados no branch production.
# ==============================================

set -e

# Cores
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}╔═══════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║        TOM CERTO - PUBLICAÇÃO OTA                 ║${NC}"
echo -e "${BLUE}╚═══════════════════════════════════════════════════╝${NC}"
echo ""

# Verifica se há mensagem
if [ -z "$1" ]; then
    echo -e "${YELLOW}⚠ Uso: ./publish-update.sh \"Mensagem do update\"${NC}"
    echo ""
    read -p "Digite a mensagem do update: " MESSAGE
else
    MESSAGE="$1"
fi

if [ -z "$MESSAGE" ]; then
    echo -e "${RED}✗ Mensagem é obrigatória${NC}"
    exit 1
fi

echo -e "${BLUE}📦 Publicando update...${NC}"
echo -e "${BLUE}   Branch: production${NC}"
echo -e "${BLUE}   Mensagem: ${MESSAGE}${NC}"
echo ""

# Publica no branch production (que serve tanto canal preview quanto production)
npx eas-cli update --branch production --message "$MESSAGE" --non-interactive

echo ""
echo -e "${GREEN}╔═══════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║              ✓ UPDATE PUBLICADO!                  ║${NC}"
echo -e "${GREEN}╚═══════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${YELLOW}📱 Para receber no celular:${NC}"
echo "   1. Force close do app Tom Certo"
echo "   2. Abra o app e aguarde 15-20 segundos"
echo "   3. Feche e abra novamente"
echo ""
echo -e "${BLUE}ℹ Este update será recebido por TODOS os APKs (preview e production)${NC}"
echo ""
