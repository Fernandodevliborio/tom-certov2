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
APK_DOWNLOAD_URL = os.environ.get('APK_DOWNLOAD_URL', f'https://{DOMAIN}/download/AppTomCerto.apk')

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
        
        # Template do email
        html_content = f"""
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <style>
        body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; }}
        .header {{ background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; border-radius: 12px 12px 0 0; text-align: center; }}
        .header h1 {{ margin: 0; font-size: 24px; }}
        .header .emoji {{ font-size: 48px; margin-bottom: 10px; }}
        .content {{ background: #f8f9fa; padding: 30px; border-radius: 0 0 12px 12px; }}
        .token-box {{ background: #1a1a2e; color: #00ff88; padding: 20px; border-radius: 8px; text-align: center; margin: 20px 0; font-family: monospace; font-size: 24px; letter-spacing: 2px; }}
        .download-btn {{ display: inline-block; background: #22c55e; color: white; padding: 15px 30px; border-radius: 8px; text-decoration: none; font-weight: bold; margin: 20px 0; }}
        .download-btn:hover {{ background: #16a34a; }}
        .steps {{ background: white; padding: 20px; border-radius: 8px; margin: 20px 0; }}
        .steps ol {{ margin: 0; padding-left: 20px; }}
        .steps li {{ margin: 10px 0; }}
        .footer {{ text-align: center; color: #666; font-size: 12px; margin-top: 30px; }}
        .plan-badge {{ display: inline-block; background: #fbbf24; color: #000; padding: 5px 15px; border-radius: 20px; font-weight: bold; font-size: 14px; }}
    </style>
</head>
<body>
    <div class="header">
        <div class="emoji">🎵</div>
        <h1>Seu acesso ao Tom Certo foi liberado!</h1>
    </div>
    <div class="content">
        <p>Olá, <strong>{customer_name or 'Músico'}</strong>!</p>
        <p>Seu pagamento foi aprovado e seu acesso está ativo.</p>
        
        <p style="text-align: center;"><span class="plan-badge">Plano {plano.upper()}</span></p>
        
        <h3>📲 Baixar o app:</h3>
        <p style="text-align: center;">
            <a href="{APK_DOWNLOAD_URL}" class="download-btn">⬇️ Baixar AppTomCerto.apk</a>
        </p>
        
        <h3>🔐 Seu token de acesso:</h3>
        <div class="token-box">{token}</div>
        
        <div class="steps">
            <h4>Como usar:</h4>
            <ol>
                <li>Baixe o app clicando no botão acima</li>
                <li>Instale no seu celular Android</li>
                <li>Abra o app e insira o token</li>
                <li>Pronto! Acesso liberado 🎉</li>
            </ol>
        </div>
        
        <p style="color: #666; font-size: 14px;">
            ⚠️ <strong>Importante:</strong> Guarde este token com segurança. 
            Ele funciona em apenas 1 dispositivo.
        </p>
    </div>
    <div class="footer">
        <p>Tom Certo - Descubra o tom da sua voz</p>
        <p>Dúvidas? Responda este email.</p>
    </div>
</body>
</html>
        """
        
        text_content = f"""
Seu acesso ao Tom Certo foi liberado! 🎵

Olá, {customer_name or 'Músico'}!

Seu pagamento foi aprovado e seu acesso está ativo.
Plano: {plano.upper()}

📲 Baixar o app:
{APK_DOWNLOAD_URL}

🔐 Seu token de acesso:
{token}

Como usar:
1. Baixe o app pelo link acima
2. Instale no seu celular Android
3. Abra o app e insira o token
4. Pronto! Acesso liberado.

⚠️ Importante: Guarde este token com segurança. Ele funciona em apenas 1 dispositivo.

--
Tom Certo - Descubra o tom da sua voz
        """
        
        response = resend.Emails.send({
            "from": FROM_EMAIL,
            "to": [to_email],
            "subject": "🎵 Seu acesso ao Tom Certo foi liberado!",
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
