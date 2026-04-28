"""Serviço de envio de emails usando Resend"""
import os
import logging
from typing import Optional
from dotenv import load_dotenv
from pathlib import Path

# Carrega variáveis do .env
load_dotenv(Path(__file__).parent / '.env')

logger = logging.getLogger(__name__)

# API Key do Resend
RESEND_API_KEY = os.environ.get('RESEND_API_KEY', '')

# Domínio principal
DOMAIN = os.environ.get('DOMAIN', 'tomcerto.online')

# URL base para download do APK
APK_DOWNLOAD_URL = os.environ.get('APK_DOWNLOAD_URL', 'https://tomcerto.online/download/apk')

# Email remetente
FROM_EMAIL = os.environ.get('FROM_EMAIL', f'Tom Certo <contato@{DOMAIN}>')


async def send_welcome_email(
    to_email: str,
    customer_name: str,
    token: str,
    plano: str
) -> bool:
    """
    Envia email de boas-vindas com o token e link de download.
    
    Args:
        to_email: Email do destinatário
        customer_name: Nome do cliente
        token: Token de acesso gerado
        plano: Nome do plano (mensal, trimestral, semestral)
    
    Returns:
        True se enviado com sucesso, False caso contrário
    """
    if not RESEND_API_KEY:
        logger.warning("[Email] RESEND_API_KEY não configurada. Email não enviado.")
        logger.info(f"[Email] MOCK - Enviaria email para {to_email}:")
        logger.info(f"[Email] MOCK - Token: {token}")
        logger.info(f"[Email] MOCK - Plano: {plano}")
        return False
    
    try:
        import resend
        resend.api_key = RESEND_API_KEY
        
        # Calcula prazo de validade
        plano_lower = plano.lower() if plano else 'mensal'
        if 'semestral' in plano_lower or '6' in plano_lower:
            prazo_validade = "6 meses"
            dias = 180
        elif 'trimestral' in plano_lower or '3' in plano_lower:
            prazo_validade = "3 meses"
            dias = 90
        else:
            prazo_validade = "1 mês"
            dias = 30
        
        # Template do email - Estilo simples e profissional
        html_content = f"""
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; font-size: 16px; line-height: 1.6; color: #333333; background-color: #ffffff; margin: 0; padding: 0;">
    <table cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width: 600px; margin: 0 auto; padding: 40px 20px;">
        <tr>
            <td>
                <h1 style="font-size: 22px; font-weight: 600; color: #111111; margin: 0 0 24px 0;">
                    Acesso ao Tom Certo
                </h1>
                
                <p style="margin: 0 0 24px 0; color: #333333;">
                    Olá{', ' + customer_name if customer_name else ''}, seu acesso ao aplicativo Tom Certo foi liberado.
                </p>
                
                <p style="margin: 0 0 8px 0; color: #333333; font-weight: 600;">
                    Credenciais de acesso:
                </p>
                <p style="margin: 0 0 8px 0; color: #333333;">
                    Token: <strong style="font-family: monospace; font-size: 18px; color: #111111;">{token}</strong>
                </p>
                <p style="margin: 0 0 24px 0; color: #333333;">
                    Plano: <strong>{plano.capitalize() if plano else 'Mensal'}</strong> (válido por {prazo_validade})
                </p>
                
                <p style="margin: 0 0 8px 0; color: #333333; font-weight: 600;">
                    Link para baixar o aplicativo:
                </p>
                <p style="margin: 0 0 24px 0;">
                    <a href="{APK_DOWNLOAD_URL}" style="color: #0066cc; text-decoration: underline;">{APK_DOWNLOAD_URL}</a>
                </p>
                
                <p style="margin: 0 0 8px 0; color: #333333; font-weight: 600;">
                    Instruções:
                </p>
                <ol style="margin: 0 0 32px 0; padding-left: 20px; color: #333333;">
                    <li style="margin-bottom: 8px;">Baixe o aplicativo pelo link acima.</li>
                    <li style="margin-bottom: 8px;">Abra o app Tom Certo.</li>
                    <li style="margin-bottom: 8px;">Insira o token para ativar seu acesso.</li>
                </ol>
                
                <hr style="border: none; border-top: 1px solid #e5e5e5; margin: 32px 0;">
                
                <p style="margin: 0; color: #888888; font-size: 13px;">
                    Este é um email automático. Não responda esta mensagem.
                </p>
            </td>
        </tr>
    </table>
</body>
</html>
        """
        
        text_content = f"""
Acesso ao Tom Certo

Olá{', ' + customer_name if customer_name else ''}, seu acesso ao aplicativo Tom Certo foi liberado.

Credenciais de acesso:
Token: {token}

Link para baixar o aplicativo:
{APK_DOWNLOAD_URL}

Instruções:
1. Baixe o aplicativo pelo link acima.
2. Abra o app Tom Certo.
3. Insira o token para ativar seu acesso.

---
Este é um email automático. Não responda esta mensagem.
        """
        
        response = resend.Emails.send({
            "from": FROM_EMAIL,
            "to": [to_email],
            "subject": "Acesso ao Tom Certo",
            "html": html_content,
            "text": text_content,
        })
        
        logger.info(f"[Email] ✓ Enviado para {to_email} - ID: {response.get('id', 'N/A')}")
        return True
        
    except Exception as e:
        logger.error(f"[Email] ✗ Erro ao enviar para {to_email}: {str(e)}")
        return False


async def send_cancellation_email(
    to_email: str,
    customer_name: str,
    reason: str = "cancelamento"
) -> bool:
    """
    Envia email informando cancelamento/reembolso.
    """
    if not RESEND_API_KEY:
        logger.warning("[Email] RESEND_API_KEY não configurada.")
        return False
    
    try:
        import resend
        resend.api_key = RESEND_API_KEY
        
        html_content = f"""
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
</head>
<body style="font-family: sans-serif; padding: 20px;">
    <h2>Acesso ao Tom Certo encerrado</h2>
    <p>Olá, {customer_name or 'Cliente'},</p>
    <p>Seu acesso ao Tom Certo foi encerrado devido a: <strong>{reason}</strong>.</p>
    <p>Se você acredita que isso é um erro, entre em contato conosco.</p>
    <p>Atenciosamente,<br>Equipe Tom Certo</p>
</body>
</html>
        """
        
        response = resend.Emails.send({
            "from": FROM_EMAIL,
            "to": [to_email],
            "subject": "Tom Certo - Acesso encerrado",
            "html": html_content,
        })
        
        logger.info(f"[Email] ✓ Cancelamento enviado para {to_email}")
        return True
        
    except Exception as e:
        logger.error(f"[Email] ✗ Erro ao enviar cancelamento: {str(e)}")
        return False
