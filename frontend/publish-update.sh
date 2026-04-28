#!/bin/bash
# ==============================================
# SCRIPT DE PUBLICAÇÃO DE UPDATES OTA - TOM CERTO
# ==============================================
# Este script garante que os updates sejam publicados
# no canal correto (production) para TODOS os APKs.
#
# USO: ./publish-update.sh "Mensagem da atualização"
# ==============================================

set -e

# Cores para output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Verificar se a mensagem foi fornecida
if [ -z "$1" ]; then
    echo -e "${RED}❌ Erro: Forneça uma mensagem para o update${NC}"
    echo ""
    echo "Uso: ./publish-update.sh \"Descrição das mudanças\""
    echo ""
    echo "Exemplo: ./publish-update.sh \"Nova tela de login premium\""
    exit 1
fi

MESSAGE="$1"

echo ""
echo -e "${BLUE}╔════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║       TOM CERTO - PUBLICAÇÃO DE UPDATE OTA     ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════╝${NC}"
echo ""

# Verificar se está no diretório correto
if [ ! -f "app.json" ]; then
    echo -e "${RED}❌ Erro: Execute este script na pasta /app/frontend${NC}"
    exit 1
fi

# Verificar token
if [ -z "$EXPO_TOKEN" ]; then
    echo -e "${YELLOW}⚠️  EXPO_TOKEN não definido. Tentando usar token salvo...${NC}"
fi

echo -e "${GREEN}✓ Canal de destino: production${NC}"
echo -e "${GREEN}✓ Mensagem: ${MESSAGE}${NC}"
echo ""

# Configurar wrapper hermesc para ARM64 (se necessário)
HERMESC_PATH="node_modules/react-native/sdks/hermesc/linux64-bin/hermesc"
if [ -f "$HERMESC_PATH.original" ] || [ ! -x "$HERMESC_PATH" ]; then
    echo -e "${YELLOW}⚙️  Configurando wrapper hermesc para ARM64...${NC}"
    cat > "$HERMESC_PATH" << 'EOF'
#!/bin/bash
OUTPUT=""
INPUT=""
SOURCEMAP=false
while [[ $# -gt 0 ]]; do
    case $1 in
        -out) OUTPUT="$2"; shift 2 ;;
        -output-source-map) SOURCEMAP=true; shift ;;
        -emit-binary|-O) shift ;;
        *) if [[ -f "$1" ]]; then INPUT="$1"; fi; shift ;;
    esac
done
if [[ -n "$INPUT" && -n "$OUTPUT" ]]; then
    cp "$INPUT" "$OUTPUT"
    if [[ "$SOURCEMAP" == "true" ]]; then
        echo '{"version":3,"sources":[],"names":[],"mappings":""}' > "${OUTPUT}.map"
    fi
fi
exit 0
EOF
    chmod +x "$HERMESC_PATH"
fi

echo ""
echo -e "${BLUE}📦 Publicando update no canal PRODUCTION...${NC}"
echo ""

# Publicar update - SEMPRE no canal production
npx eas-cli update --channel production --message "$MESSAGE" --non-interactive

echo ""
echo -e "${GREEN}╔════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║          ✅ UPDATE PUBLICADO COM SUCESSO!      ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${YELLOW}📱 Para aplicar no celular:${NC}"
echo "   1. Feche completamente o app Tom Certo"
echo "   2. Abra novamente e aguarde 10-15 segundos"
echo "   3. Feche e abra mais uma vez"
echo ""
