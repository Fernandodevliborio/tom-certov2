from fastapi import FastAPI, APIRouter, Request, HTTPException, Depends, BackgroundTasks
from fastapi.responses import JSONResponse, HTMLResponse, FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from starlette.middleware.gzip import GZipMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import os
import logging
import uuid
import jwt
import bcrypt
import asyncio
from datetime import datetime, timedelta, timezone
from pathlib import Path
from pydantic import BaseModel, Field
from typing import List, Optional, Any
from bson import ObjectId

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

# Imports dos serviços de token e email
from models import PlanType, TokenStatus, PLAN_DURATIONS, PLAN_PRICES, WebhookCaktoPayload
from token_service import create_token as create_new_token, cancel_token, validate_token as validate_token_service, expire_old_tokens
from email_service import send_welcome_email, send_cancellation_email

# ─── MongoDB ────────────────────────────────────────────────────────────
mongo_url = os.environ['MONGO_URL']
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ.get('DB_NAME', 'tom_certo_db')]

# ─── App ────────────────────────────────────────────────────────────────
app = FastAPI(title="Tom Certo API")
api_router = APIRouter(prefix="/api")

# GZIP Compression - reduz tamanho das respostas em ~70%
app.add_middleware(GZipMiddleware, minimum_size=500)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# ─── JWT Config ─────────────────────────────────────────────────────────
JWT_SECRET = os.environ.get('JWT_SECRET', 'tom-certo-secret-key-2024-change-in-prod')
JWT_ALGORITHM = 'HS256'
SESSION_DURATION_HOURS = 24 * 30  # 30 days

# ─── Modelos ────────────────────────────────────────────────────────────
class ValidateRequest(BaseModel):
    token: str
    device_id: str

class RevalidateRequest(BaseModel):
    session: str
    device_id: str

class TokenCreate(BaseModel):
    code: Optional[str] = None        # opcional: se vazio, auto-gera
    customer_name: Optional[str] = None
    device_limit: int = 3
    duration_minutes: Optional[int] = None   # legado — soma com duration_value abaixo
    duration_value: Optional[int] = None     # novo: 1, 30, 7, etc
    duration_unit: Optional[str] = None      # novo: 'minutes' | 'hours' | 'days' | 'months' | 'forever'
    notes: Optional[str] = None

class TokenUpdate(BaseModel):
    active: Optional[bool] = None
    customer_name: Optional[str] = None
    device_limit: Optional[int] = None
    notes: Optional[str] = None

# ─── Admin Auth (Username + Password + JWT) ─────────────────────────────
ADMIN_KEY = os.environ.get('ADMIN_KEY', 'tomcerto-admin-2026')  # legacy fallback
ADMIN_USERNAME = os.environ.get('ADMIN_USERNAME', 'Admin01')
ADMIN_PASSWORD = os.environ.get('ADMIN_PASSWORD', 'adminfernando')
ADMIN_JWT_DURATION_HOURS = 24 * 7  # 7 dias logado

def create_admin_jwt(username: str) -> str:
    payload = {
        'role': 'admin',
        'username': username,
        'iat': datetime.now(timezone.utc),
        'exp': datetime.now(timezone.utc) + timedelta(hours=ADMIN_JWT_DURATION_HOURS),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)

def _decode_admin_jwt(token: str) -> Optional[dict]:
    try:
        data = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        if data.get('role') == 'admin':
            return data
    except Exception:
        return None
    return None

def verify_admin(request: Request):
    """Aceita 3 modos de autenticação (em ordem de preferência):
    1) Authorization: Bearer <jwt>     (login com usuário/senha — recomendado)
    2) X-Admin-Key: <key>              (legacy, mantido para compatibilidade)
    3) ?admin_key= na querystring      (legacy)
    """
    # 1) JWT Bearer
    auth = request.headers.get('Authorization', '')
    if auth.startswith('Bearer '):
        token = auth[7:].strip()
        data = _decode_admin_jwt(token)
        if data:
            return
    # 2) X-Admin-Key
    key = request.headers.get('X-Admin-Key') or request.query_params.get('admin_key')
    if key and key == ADMIN_KEY:
        return
    raise HTTPException(401, "Não autenticado")

# ─── Helpers JWT ────────────────────────────────────────────────────────
def create_session_token(token_id: str, device_id: str, customer_name: Optional[str] = None,
                          duration_minutes: Optional[int] = None, expires_at: Optional[str] = None) -> str:
    exp = datetime.now(timezone.utc) + timedelta(hours=SESSION_DURATION_HOURS)
    payload = {
        'sub': token_id,
        'device_id': device_id,
        'customer_name': customer_name,
        'duration_minutes': duration_minutes,
        'expires_at': expires_at,
        'iat': datetime.now(timezone.utc),
        'exp': exp,
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)

def decode_session_token(session: str) -> Optional[dict]:
    try:
        return jwt.decode(session, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    except jwt.ExpiredSignatureError:
        return None
    except Exception:
        return None

# ─── /api root ──────────────────────────────────────────────────────────
@api_router.get("/")
async def root():
    return {"message": "Tom Certo API v2", "status": "ok"}

# ─── Auth: Validate Token ───────────────────────────────────────────────
@api_router.post("/auth/validate")
async def validate_token(body: ValidateRequest):
    code = body.token.strip().upper()
    device_id = body.device_id.strip()

    if not code or not device_id:
        return JSONResponse({"valid": False, "reason": "invalid_request"}, status_code=400)

    # Busca por token ou code (compatibilidade)
    token_doc = await db.tokens.find_one({
        "$or": [
            {"token": code},
            {"code": code}
        ]
    })
    
    if not token_doc:
        return JSONResponse({"valid": False, "reason": "not_found"}, status_code=200)

    # Verifica status de cancelamento
    status = token_doc.get("status", "ativo")
    if status in ("cancelado", "cancelled"):
        return JSONResponse({"valid": False, "reason": "cancelled"}, status_code=200)

    if not token_doc.get("active", True):
        return JSONResponse({"valid": False, "reason": "revoked"}, status_code=200)

    # Verificação de expiração
    expires_at = token_doc.get("expires_at")
    if expires_at:
        if isinstance(expires_at, str):
            try:
                exp_dt = datetime.fromisoformat(expires_at.replace('Z', '+00:00'))
                if datetime.now(timezone.utc) > exp_dt:
                    return JSONResponse({"valid": False, "reason": "expired"}, status_code=200)
            except Exception:
                pass
        elif isinstance(expires_at, datetime):
            if datetime.now(timezone.utc) > expires_at.replace(tzinfo=timezone.utc):
                return JSONResponse({"valid": False, "reason": "expired"}, status_code=200)

    # Verificação de dispositivo
    active_devices: list = token_doc.get("active_devices", [])
    device_limit: int = token_doc.get("device_limit", 3)

    if device_id not in active_devices:
        if len(active_devices) >= device_limit:
            return JSONResponse({"valid": False, "reason": "device_limit"}, status_code=200)
        active_devices.append(device_id)
        await db.tokens.update_one(
            {"_id": token_doc["_id"]},
            {"$set": {"active_devices": active_devices, "last_used_at": datetime.now(timezone.utc)}}
        )

    token_id = str(token_doc["_id"])
    customer_name = token_doc.get("customer_name")
    duration_minutes = token_doc.get("duration_minutes")
    expires_at_str = expires_at.isoformat() if isinstance(expires_at, datetime) else expires_at

    session = create_session_token(token_id, device_id, customer_name, duration_minutes, expires_at_str)

    logger.info(f"[Auth] Token validado: code={code[:4]}*** device={device_id[:8]}...")
    return JSONResponse({
        "valid": True,
        "session": session,
        "token_id": token_id,
        "customer_name": customer_name,
        "duration_minutes": duration_minutes,
        "expires_at": expires_at_str,
    })

# ─── Auth: Revalidate Session ───────────────────────────────────────────
@api_router.post("/auth/revalidate")
async def revalidate_session(body: RevalidateRequest):
    payload = decode_session_token(body.session)
    if not payload:
        return JSONResponse({"valid": False, "reason": "session_expired"}, status_code=200)

    token_id = payload.get("sub")
    session_device = payload.get("device_id")

    if session_device != body.device_id:
        return JSONResponse({"valid": False, "reason": "device_mismatch"}, status_code=200)

    try:
        token_doc = await db.tokens.find_one({"_id": ObjectId(token_id)})
    except Exception:
        return JSONResponse({"valid": False, "reason": "session_invalid"}, status_code=200)

    if not token_doc:
        return JSONResponse({"valid": False, "reason": "not_found"}, status_code=200)

    if not token_doc.get("active", True):
        return JSONResponse({"valid": False, "reason": "revoked"}, status_code=200)

    customer_name = token_doc.get("customer_name")
    duration_minutes = token_doc.get("duration_minutes")
    expires_at = token_doc.get("expires_at")
    expires_at_str = expires_at.isoformat() if isinstance(expires_at, datetime) else expires_at

    return JSONResponse({
        "valid": True,
        "customer_name": customer_name,
        "duration_minutes": duration_minutes,
        "expires_at": expires_at_str,
    })

# ═══════════════════════════════════════════════════════════════════════════
# ML Key Detection v8 — TRIBUNAL DE EVIDÊNCIAS TONAL
# ═══════════════════════════════════════════════════════════════════════════
# Nova arquitetura com 3 jurados independentes:
# - Krumhansl-Aarden (30%): Correlação estatística
# - Cadências (35%): Padrões V→I, IV→I, II→V→I
# - Gravidade (35%): Notas longas, fins de frase, repetição
#
# A decisão de MAIOR vs MENOR é feita APÓS definir a tônica,
# usando a presença/ausência da 3ª.
# ═══════════════════════════════════════════════════════════════════════════

from key_detection_v9 import (
    analyze_audio_bytes_v9,
    reset_session_v9,
    NOTE_NAMES_BR,
)


@api_router.post("/analyze-key/reset")
async def reset_session(request: Request):
    """Zera o acumulador de sessão — chamado quando usuário inicia nova análise."""
    device_id = request.headers.get('X-Device-Id', 'anon')
    reset_session_v9(device_id)
    logger.info(f"[AnalyzeKey v9] sessão resetada dev={device_id[:8]}")
    return {'reset': True, 'device': device_id[:8], 'version': 'tribunal-v9'}


@api_router.post("/analyze-key")
async def analyze_key(request: Request):
    """
    TRIBUNAL DE EVIDÊNCIAS TONAL v9 — CORREÇÃO CRÍTICA
    
    Mudanças v9:
    - Correção do bug V↔I (G# detectado como C#)
    - Penalização anti-dominante
    - Lock mais rápido (10-30s)
    - Decay mais rápido no acumulador
    - Maior peso para fins de frase
    """
    audio_bytes = await request.body()
    device_id = request.headers.get('X-Device-Id', 'anon')
    logger.info(f"[AnalyzeKey v9] recebeu {len(audio_bytes)} bytes dev={device_id[:8]}")
    
    if not audio_bytes or len(audio_bytes) < 500:
        return JSONResponse({
            "success": False, "error": "audio_too_short",
            "message": "Áudio muito curto ou vazio."
        }, status_code=400)

    try:
        result = analyze_audio_bytes_v9(
            audio_bytes=audio_bytes,
            device_id=device_id,
            use_accumulator=True,
        )
        
        # Logging v9
        if result.get('success'):
            cadences = result.get('cadences_found', [])
            cadence_str = ', '.join(f"{c['type']}→{c['to']}" for c in cadences) if cadences else 'nenhuma'
            
            tops = result.get('top_candidates', [])[:3]
            tops_str = ' | '.join(f"{t['name']}({t.get('score', 0):.3f})" for t in tops)
            
            locked_str = '🔒TRAVADO' if result.get('locked') else '⏳pendente'
            
            logger.info(
                f"[AnalyzeKey v9] ✓ {locked_str} key={result.get('key_name', '?')} "
                f"conf={result.get('confidence', 0):.2f} "
                f"analyses={result.get('analyses', 0)}"
            )
            logger.info(f"[AnalyzeKey v9]   cadências: {cadence_str}")
            logger.info(f"[AnalyzeKey v9]   top3: {tops_str}")
        else:
            logger.warning(
                f"[AnalyzeKey v9] ✗ error={result.get('error')}"
            )

        return JSONResponse(result)
        
    except Exception as e:
        logger.error(f"[AnalyzeKey v9] Erro: {e}", exc_info=True)
        return JSONResponse({
            "success": False,
            "error": "internal_error",
            "message": str(e),
        }, status_code=500)


# ═══════════════════════════════════════════════════════════════════════════
# WEBHOOK CAKTO — Recebe eventos de pagamento
# ═══════════════════════════════════════════════════════════════════════════

# Credenciais Cakto (para validação opcional)
CAKTO_API_ID = os.environ.get('CAKTO_API_ID', '')
CAKTO_API_TOKEN = os.environ.get('CAKTO_API_TOKEN', '')

def _parse_plan(plan_str: Optional[str]) -> PlanType:
    """Converte string do plano para enum."""
    if not plan_str:
        return PlanType.MENSAL
    plan_lower = plan_str.lower().strip()
    if 'trimestral' in plan_lower or '90' in plan_lower or '3' in plan_lower:
        return PlanType.TRIMESTRAL
    if 'semestral' in plan_lower or '180' in plan_lower or '6' in plan_lower:
        return PlanType.SEMESTRAL
    return PlanType.MENSAL


@api_router.post("/webhook/cakto")
async def webhook_cakto(request: Request, background_tasks: BackgroundTasks):
    """
    Webhook para receber eventos da Cakto.
    
    Eventos suportados:
    - pagamento_aprovado: Cria token e envia email
    - pagamento_cancelado, reembolso, chargeback: Cancela token
    """
    try:
        payload = await request.json()
        logger.info(f"[Webhook Cakto] Recebido: {payload}")
        
        # Validação opcional do token da Cakto (se enviado no header)
        auth_header = request.headers.get('Authorization', '')
        if CAKTO_API_TOKEN and auth_header:
            expected = f"Bearer {CAKTO_API_TOKEN}"
            if auth_header != expected:
                logger.warning(f"[Webhook Cakto] Token inválido")
                # Não bloqueia, apenas loga (para compatibilidade)
        
        event = payload.get('event', '').lower()
        customer_name = payload.get('customer_name') or payload.get('nome') or payload.get('name') or payload.get('buyer', {}).get('name')
        customer_email = payload.get('customer_email') or payload.get('email') or payload.get('buyer', {}).get('email')
        plan_str = payload.get('plan') or payload.get('plano') or payload.get('product_name') or payload.get('product', {}).get('name')
        transaction_id = payload.get('transaction_id') or payload.get('id') or payload.get('order_id') or payload.get('sale_id')
        
        # Evento: Pagamento Aprovado
        if event in ('pagamento_aprovado', 'payment_approved', 'approved', 'completed', 'paid', 'sale_approved'):
            plano = _parse_plan(plan_str)
            
            # Cria o token
            token, expires_at = await create_new_token(
                db=db,
                plano=plano,
                nome_usuario=customer_name,
                email_compra=customer_email,
                transaction_id=transaction_id,
            )
            
            # Envia email em background
            if customer_email:
                background_tasks.add_task(
                    send_welcome_email,
                    to_email=customer_email,
                    customer_name=customer_name or "Cliente",
                    token=token,
                    plano=plano.value,
                )
            
            logger.info(f"[Webhook Cakto] ✓ Token criado: {token[:4]}*** para {customer_email}")
            
            return JSONResponse({
                "success": True,
                "event": event,
                "token_created": True,
                "token_preview": f"{token[:4]}****",
                "plano": plano.value,
                "expires_at": expires_at.isoformat(),
            })
        
        # Eventos: Cancelamento / Reembolso / Chargeback
        elif event in ('pagamento_cancelado', 'reembolso', 'chargeback', 'refund', 'cancelled', 'refunded', 'disputed'):
            reason = "reembolso" if event in ('reembolso', 'refund', 'refunded') else \
                     "chargeback" if event in ('chargeback', 'disputed') else "cancelado"
            
            # Cancela o token
            cancelled = await cancel_token(
                db=db,
                email=customer_email,
                transaction_id=transaction_id,
                reason=reason,
            )
            
            # Envia email de cancelamento em background
            if customer_email and cancelled:
                background_tasks.add_task(
                    send_cancellation_email,
                    to_email=customer_email,
                    customer_name=customer_name or "Cliente",
                    reason=reason,
                )
            
            logger.info(f"[Webhook Cakto] ✓ Token cancelado: email={customer_email} reason={reason}")
            
            return JSONResponse({
                "success": True,
                "event": event,
                "token_cancelled": cancelled,
                "reason": reason,
            })
        
        else:
            logger.warning(f"[Webhook Cakto] Evento desconhecido: {event}")
            return JSONResponse({
                "success": True,
                "event": event,
                "message": "Evento ignorado (não reconhecido)",
            })
            
    except Exception as e:
        logger.error(f"[Webhook Cakto] Erro: {e}", exc_info=True)
        return JSONResponse({
            "success": False,
            "error": str(e),
        }, status_code=500)


# ═══════════════════════════════════════════════════════════════════════════
# WEBHOOK TICTO — Integração de Pagamentos
# ═══════════════════════════════════════════════════════════════════════════

TICTO_WEBHOOK_TOKEN = os.environ.get('TICTO_WEBHOOK_TOKEN', '')


@api_router.post("/webhook/ticto")
async def webhook_ticto(request: Request, background_tasks: BackgroundTasks):
    """
    Webhook para receber eventos da Ticto (plataforma de pagamentos).
    
    Documentação Ticto: https://help.ticto.com.br/sou-produtor/tictools-integracoes/webhook
    
    Eventos suportados (versão 2.0):
    - sale_approved / Venda Realizada: Pagamento aprovado → Cria token
    - refund / Reembolso: Devolução → Cancela token
    - chargeback: Contestação → Cancela token
    - waiting_payment: Aguardando pagamento (ignorado)
    - abandoned_cart: Carrinho abandonado (ignorado)
    """
    try:
        payload = await request.json()
        logger.info(f"[Webhook Ticto] Recebido: {payload}")
        
        # Validação do token (opcional mas recomendado)
        auth_header = request.headers.get('Authorization', '') or request.headers.get('X-Ticto-Token', '')
        if TICTO_WEBHOOK_TOKEN:
            token_from_header = auth_header.replace('Bearer ', '').strip()
            if token_from_header and token_from_header != TICTO_WEBHOOK_TOKEN:
                logger.warning(f"[Webhook Ticto] Token inválido no header")
                # Não bloqueia para compatibilidade
        
        # Ticto v2.0 usa estrutura diferente
        # Pode vir como payload direto ou dentro de "data"
        data = payload.get('data', payload)
        
        # Extrair evento (Ticto usa "event" ou "status")
        event = (
            payload.get('event') or 
            payload.get('status') or 
            data.get('event') or 
            data.get('status') or 
            ''
        ).lower().strip()
        
        # Extrair dados do comprador
        buyer = data.get('buyer') or data.get('customer') or data.get('comprador') or {}
        customer_name = (
            buyer.get('name') or 
            buyer.get('nome') or 
            data.get('customer_name') or 
            data.get('nome') or 
            ''
        )
        customer_email = (
            buyer.get('email') or 
            data.get('customer_email') or 
            data.get('email') or 
            ''
        ).lower().strip()
        
        # Extrair dados do produto/plano
        product = data.get('product') or data.get('produto') or data.get('offer') or {}
        plan_str = (
            product.get('name') or 
            product.get('nome') or 
            data.get('product_name') or 
            data.get('plano') or 
            'mensal'
        )
        
        # Extrair ID da transação
        transaction_id = (
            data.get('transaction_id') or 
            data.get('sale_id') or 
            data.get('order_id') or 
            data.get('id') or 
            payload.get('id') or 
            ''
        )
        
        logger.info(f"[Webhook Ticto] Parsed: event={event} email={customer_email} product={plan_str} tx={transaction_id}")
        
        # ═══ EVENTO: Venda Aprovada ═══
        if event in ('sale_approved', 'venda_realizada', 'approved', 'paid', 'completed', 'pagamento_aprovado'):
            if not customer_email:
                logger.warning(f"[Webhook Ticto] Venda sem email!")
                return JSONResponse({
                    "success": False,
                    "error": "missing_email",
                    "message": "Email do comprador não encontrado no payload",
                }, status_code=400)
            
            plano = _parse_plan(plan_str)
            
            # Cria o token
            token, expires_at = await create_new_token(
                db=db,
                plano=plano,
                nome_usuario=customer_name,
                email_compra=customer_email,
                transaction_id=str(transaction_id),
            )
            
            # Envia email em background
            if customer_email:
                background_tasks.add_task(
                    send_welcome_email,
                    to_email=customer_email,
                    customer_name=customer_name or "Cliente",
                    token=token,
                    plano=plano.value,
                )
            
            logger.info(f"[Webhook Ticto] ✓ VENDA APROVADA: Token {token[:4]}*** criado para {customer_email}")
            
            return JSONResponse({
                "success": True,
                "event": event,
                "action": "token_created",
                "token_preview": f"{token[:4]}****",
                "plano": plano.value,
                "expires_at": expires_at.isoformat(),
                "email": customer_email,
            })
        
        # ═══ EVENTO: Reembolso ═══
        elif event in ('refund', 'refunded', 'reembolso', 'reembolsado'):
            cancelled = await cancel_token(
                db=db,
                email=customer_email,
                transaction_id=str(transaction_id) if transaction_id else None,
                reason="reembolso",
            )
            
            if customer_email and cancelled:
                background_tasks.add_task(
                    send_cancellation_email,
                    to_email=customer_email,
                    customer_name=customer_name or "Cliente",
                    reason="reembolso",
                )
            
            logger.info(f"[Webhook Ticto] ✓ REEMBOLSO: Token cancelado para {customer_email}")
            
            return JSONResponse({
                "success": True,
                "event": event,
                "action": "token_cancelled",
                "reason": "reembolso",
                "cancelled": cancelled,
            })
        
        # ═══ EVENTO: Chargeback ═══
        elif event in ('chargeback', 'disputed', 'contestacao'):
            cancelled = await cancel_token(
                db=db,
                email=customer_email,
                transaction_id=str(transaction_id) if transaction_id else None,
                reason="chargeback",
            )
            
            if customer_email and cancelled:
                background_tasks.add_task(
                    send_cancellation_email,
                    to_email=customer_email,
                    customer_name=customer_name or "Cliente",
                    reason="chargeback",
                )
            
            logger.info(f"[Webhook Ticto] ✓ CHARGEBACK: Token cancelado para {customer_email}")
            
            return JSONResponse({
                "success": True,
                "event": event,
                "action": "token_cancelled",
                "reason": "chargeback",
                "cancelled": cancelled,
            })
        
        # ═══ EVENTOS IGNORADOS (apenas loga) ═══
        elif event in ('waiting_payment', 'aguardando_pagamento', 'pending', 'pix_generated', 'pix_gerado', 
                       'boleto_printed', 'boleto_impresso', 'abandoned_cart', 'carrinho_abandonado',
                       'pix_expired', 'pix_expirado', 'boleto_overdue', 'boleto_atrasado'):
            logger.info(f"[Webhook Ticto] Evento '{event}' recebido e ignorado (não requer ação)")
            return JSONResponse({
                "success": True,
                "event": event,
                "action": "ignored",
                "message": f"Evento '{event}' não requer ação",
            })
        
        # ═══ EVENTO DESCONHECIDO ═══
        else:
            logger.warning(f"[Webhook Ticto] Evento desconhecido: '{event}'")
            return JSONResponse({
                "success": True,
                "event": event or "unknown",
                "action": "ignored",
                "message": "Evento não reconhecido",
            })
            
    except Exception as e:
        logger.error(f"[Webhook Ticto] Erro: {e}", exc_info=True)
        return JSONResponse({
            "success": False,
            "error": str(e),
        }, status_code=500)


# ═══════════════════════════════════════════════════════════════════════════
# JOB DE EXPIRAÇÃO AUTOMÁTICA
# ═══════════════════════════════════════════════════════════════════════════

_expiration_task = None

async def _expiration_loop():
    """Loop que roda a cada hora para expirar tokens antigos."""
    while True:
        try:
            await asyncio.sleep(3600)  # 1 hora
            expired_count = await expire_old_tokens(db)
            if expired_count > 0:
                logger.info(f"[Expiration Job] Expirados: {expired_count} tokens")
        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.error(f"[Expiration Job] Erro: {e}")


@app.on_event("startup")
async def start_expiration_job():
    """Inicia o job de expiração no startup."""
    global _expiration_task
    _expiration_task = asyncio.create_task(_expiration_loop())
    logger.info("[Expiration Job] Iniciado")
    
    # Executa uma vez imediatamente
    try:
        expired = await expire_old_tokens(db)
        if expired > 0:
            logger.info(f"[Expiration Job] Expirados no startup: {expired} tokens")
    except Exception as e:
        logger.error(f"[Expiration Job] Erro no startup: {e}")


# ═══════════════════════════════════════════════════════════════════════════
# ENDPOINTS DE PLANOS (para exibir no frontend/landing)
# ═══════════════════════════════════════════════════════════════════════════

@api_router.get("/plans")
async def get_plans():
    """Retorna os planos disponíveis."""
    return JSONResponse({
        "plans": [
            {
                "id": "mensal",
                "name": "Mensal",
                "price": PLAN_PRICES[PlanType.MENSAL],
                "duration_days": PLAN_DURATIONS[PlanType.MENSAL],
                "badge": None,
            },
            {
                "id": "trimestral",
                "name": "Trimestral",
                "price": PLAN_PRICES[PlanType.TRIMESTRAL],
                "duration_days": PLAN_DURATIONS[PlanType.TRIMESTRAL],
                "badge": "MAIS ESCOLHIDO",
            },
            {
                "id": "semestral",
                "name": "Semestral",
                "price": PLAN_PRICES[PlanType.SEMESTRAL],
                "duration_days": PLAN_DURATIONS[PlanType.SEMESTRAL],
                "badge": "MAIOR ECONOMIA",
            },
        ]
    })


def _generate_code() -> str:
    """Gera um código único no formato TC-XXXX-XXXX (4 + 4 hex)."""
    import secrets
    a = secrets.token_hex(2).upper()
    b = secrets.token_hex(2).upper()
    return f"TC-{a}-{b}"

def _compute_duration_minutes(body: TokenCreate) -> Optional[int]:
    """Converte (duration_value, duration_unit) em minutos. Mantém duration_minutes se já vier preenchido."""
    if body.duration_minutes:
        return body.duration_minutes
    if body.duration_unit == 'forever' or body.duration_unit is None:
        return None
    if not body.duration_value or body.duration_value <= 0:
        return None
    unit = (body.duration_unit or 'days').lower()
    v = body.duration_value
    if unit in ('minute', 'minutes', 'min'):
        return v
    if unit in ('hour', 'hours', 'h'):
        return v * 60
    if unit in ('day', 'days', 'd'):
        return v * 60 * 24
    if unit in ('month', 'months', 'mo'):
        return v * 60 * 24 * 30
    if unit in ('year', 'years', 'y'):
        return v * 60 * 24 * 365
    return None


# ─── Admin: Criar Token (PROTEGIDO via X-Admin-Key) ────────────────────
@api_router.post("/admin/tokens")
async def create_token(body: TokenCreate, request: Request):
    verify_admin(request)
    code = (body.code or '').strip().upper()
    if not code:
        # auto-gera código único
        for _ in range(10):
            code = _generate_code()
            if not await db.tokens.find_one({"code": code}):
                break
        else:
            raise HTTPException(500, "Falha ao gerar código único")
    else:
        exists = await db.tokens.find_one({"code": code})
        if exists:
            raise HTTPException(409, "Token já existe com esse código")

    duration_minutes = _compute_duration_minutes(body)
    doc = {
        "code": code,
        "customer_name": body.customer_name,
        "device_limit": body.device_limit,
        "active_devices": [],
        "active": True,
        "created_at": datetime.now(timezone.utc),
        "expires_at": None,
        "duration_minutes": duration_minutes,
        "notes": body.notes,
    }
    if duration_minutes:
        doc["expires_at"] = datetime.now(timezone.utc) + timedelta(minutes=duration_minutes)

    result = await db.tokens.insert_one(doc)
    expires_at_iso = doc["expires_at"].isoformat() if doc["expires_at"] else None
    return JSONResponse({
        "ok": True,
        "token_id": str(result.inserted_id),
        "code": code,
        "customer_name": body.customer_name,
        "expires_at": expires_at_iso,
        "duration_minutes": duration_minutes,
    })

@api_router.get("/admin/tokens")
async def list_tokens(request: Request):
    verify_admin(request)
    tokens = await db.tokens.find().sort("created_at", -1).to_list(500)
    for t in tokens:
        t["_id"] = str(t["_id"])
        for k, v in list(t.items()):
            if isinstance(v, datetime):
                t[k] = v.isoformat()
    total = len(tokens)
    active_count = sum(1 for t in tokens if t.get("active", True))
    return JSONResponse({"tokens": tokens, "total": total, "active": active_count})

@api_router.patch("/admin/tokens/{token_id}")
async def update_token(token_id: str, body: TokenUpdate, request: Request):
    verify_admin(request)
    try:
        oid = ObjectId(token_id)
    except Exception:
        raise HTTPException(400, "token_id inválido")
    update = {}
    if body.active is not None:
        update["active"] = body.active
    if body.customer_name is not None:
        update["customer_name"] = body.customer_name
    if body.device_limit is not None:
        update["device_limit"] = body.device_limit
    if body.notes is not None:
        update["notes"] = body.notes
    if not update:
        raise HTTPException(400, "Nada para atualizar")
    update["updated_at"] = datetime.now(timezone.utc)
    result = await db.tokens.update_one({"_id": oid}, {"$set": update})
    if result.matched_count == 0:
        raise HTTPException(404, "Token não encontrado")
    return JSONResponse({"ok": True})

@api_router.post("/admin/tokens/{token_id}/clear-devices")
async def clear_devices(token_id: str, request: Request):
    verify_admin(request)
    try:
        oid = ObjectId(token_id)
    except Exception:
        raise HTTPException(400, "token_id inválido")
    result = await db.tokens.update_one(
        {"_id": oid},
        {"$set": {"active_devices": [], "updated_at": datetime.now(timezone.utc)}}
    )
    if result.matched_count == 0:
        raise HTTPException(404, "Token não encontrado")
    return JSONResponse({"ok": True})

@api_router.delete("/admin/tokens/{token_id}")
async def delete_token(token_id: str, request: Request):
    verify_admin(request)
    try:
        oid = ObjectId(token_id)
    except Exception:
        raise HTTPException(400, "token_id inválido")
    result = await db.tokens.delete_one({"_id": oid})
    if result.deleted_count == 0:
        raise HTTPException(404, "Token não encontrado")
    return JSONResponse({"ok": True})

@api_router.get("/admin/stats")
async def admin_stats(request: Request):
    verify_admin(request)
    total = await db.tokens.count_documents({})
    active = await db.tokens.count_documents({"active": True})
    revoked = await db.tokens.count_documents({"active": False})
    return JSONResponse({"total": total, "active": active, "revoked": revoked})

# ─── Seed: Token de Teste ───────────────────────────────────────────────
@api_router.post("/admin/seed-test-token")
async def seed_test_token():
    """Cria o token TEST-DEV2026 para testes (idempotente)."""
    code = "TEST-DEV2026"
    exists = await db.tokens.find_one({"code": code})
    if exists:
        return JSONResponse({"ok": True, "already_exists": True, "code": code})
    doc = {
        "code": code,
        "customer_name": "Dev/Tester",
        "device_limit": 10,
        "active_devices": [],
        "active": True,
        "created_at": datetime.now(timezone.utc),
        "expires_at": None,
        "duration_minutes": None,
        "notes": "Token de desenvolvimento/teste",
    }
    result = await db.tokens.insert_one(doc)
    return JSONResponse({"ok": True, "already_exists": False, "code": code, "token_id": str(result.inserted_id)})

# ─── Admin Login ────────────────────────────────────────────────────────
class AdminLogin(BaseModel):
    username: str
    password: str

@api_router.post("/admin/login")
async def admin_login(body: AdminLogin):
    if body.username != ADMIN_USERNAME or body.password != ADMIN_PASSWORD:
        # Pequeno delay para mitigar timing attack
        import asyncio as _asyncio
        await _asyncio.sleep(0.4)
        raise HTTPException(401, "Usuário ou senha inválidos")
    token = create_admin_jwt(body.username)
    return {
        "ok": True,
        "token": token,
        "username": body.username,
        "expires_in_hours": ADMIN_JWT_DURATION_HOURS,
    }

@api_router.get("/admin/me")
async def admin_me(request: Request, _=Depends(verify_admin)):
    """Retorna info do admin logado (útil para frontend validar JWT)."""
    auth = request.headers.get('Authorization', '')
    if auth.startswith('Bearer '):
        data = _decode_admin_jwt(auth[7:].strip())
        if data:
            return {"username": data.get('username'), "role": data.get('role')}
    return {"username": "legacy", "role": "admin"}

# ─── Health ─────────────────────────────────────────────────────────────
@api_router.get("/health")
async def health():
    return {"status": "ok", "timestamp": datetime.now(timezone.utc).isoformat()}

# ─── Admin UI (HTML Panel) ──────────────────────────────────────────────
ADMIN_HTML_PATH = ROOT_DIR / "admin_ui.html"
LOGO_PATH = ROOT_DIR.parent / "frontend" / "assets" / "images" / "logo.png"

@api_router.get("/admin-logo")
async def admin_logo():
    """Serve a logo dourada do app para uso no painel HTML."""
    if LOGO_PATH.exists():
        from fastapi.responses import FileResponse
        return FileResponse(str(LOGO_PATH), media_type="image/png")
    return JSONResponse({"error": "logo not found"}, status_code=404)

@api_router.get("/admin-ui", response_class=HTMLResponse)
async def admin_ui():
    """Serve o painel HTML de administração."""
    if not ADMIN_HTML_PATH.exists():
        return HTMLResponse("<h1>admin_ui.html não encontrado</h1>", status_code=500)
    return HTMLResponse(ADMIN_HTML_PATH.read_text(encoding="utf-8"))

@api_router.get("/admin", response_class=HTMLResponse)
async def admin_redirect_to_ui():
    """Alias legível para o painel."""
    if not ADMIN_HTML_PATH.exists():
        return HTMLResponse("<h1>admin_ui.html não encontrado</h1>", status_code=500)
    return HTMLResponse(ADMIN_HTML_PATH.read_text(encoding="utf-8"))

# ─── Include router ─────────────────────────────────────────────────────
app.include_router(api_router)

# ─── Download do APK ─────────────────────────────────────────────────────
DOWNLOADS_DIR = ROOT_DIR / "downloads"

# URL externa do APK mais recente
APK_EXTERNAL_URL = "https://customer-assets.emergentagent.com/job_credentials-deploy-1/artifacts/o2k0a39r_apptomcerto.apk"

@app.get("/download/apk")
async def download_apk():
    """Rota para download do APK do Tom Certo - redireciona para o APK externo."""
    from fastapi.responses import RedirectResponse
    return RedirectResponse(url=APK_EXTERNAL_URL, status_code=302)

@app.get("/download/AppTomCerto.apk")
async def download_apk_direct():
    """Rota alternativa para download do APK - redireciona para o APK externo."""
    from fastapi.responses import RedirectResponse
    return RedirectResponse(url=APK_EXTERNAL_URL, status_code=302)

# ─── Landing Page Estática ────────────────────────────────────────────────
LANDING_DIR = ROOT_DIR / "tom-certo-emergent-ready" / "standalone-html"

@app.get("/tom-certo.css")
async def serve_landing_css():
    """Serve o CSS da landing page."""
    css_path = LANDING_DIR / "tom-certo.css"
    if css_path.exists():
        return FileResponse(str(css_path), media_type="text/css")
    raise HTTPException(404, "CSS not found")

@app.get("/tom-certo-logo-clean.png")
async def serve_landing_logo():
    """Serve o logo da landing page."""
    logo_path = LANDING_DIR / "tom-certo-logo-clean.png"
    if logo_path.exists():
        return FileResponse(str(logo_path), media_type="image/png")
    raise HTTPException(404, "Logo not found")

@app.get("/", response_class=HTMLResponse)
async def root_page():
    """Serve a landing page principal."""
    index_path = LANDING_DIR / "index.html"
    if index_path.exists():
        return HTMLResponse(index_path.read_text(encoding="utf-8"))
    # Fallback se não existir
    return HTMLResponse("""
    <!DOCTYPE html>
    <html>
    <head>
        <title>Tom Certo API</title>
        <style>
            body { font-family: system-ui; background: #0A0A0A; color: #fff; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
            .container { text-align: center; }
            h1 { color: #FFB800; font-size: 2.5rem; margin-bottom: 0.5rem; }
            p { color: #9CA3AF; margin-bottom: 2rem; }
            a { color: #FFB800; text-decoration: none; padding: 12px 24px; border: 1px solid #FFB800; border-radius: 8px; }
            a:hover { background: #FFB800; color: #000; }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>Tom Certo</h1>
            <p>API Server v2</p>
            <a href="/api/admin">Painel Admin</a>
        </div>
    </body>
    </html>
    """)

# ─── Download do APK ────────────────────────────────────────────────────
@app.get("/download", response_class=HTMLResponse)
async def download_page():
    """Página de download do APK com credenciais"""
    return HTMLResponse("""
<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Tom Certo - Download</title>
    <link rel="stylesheet" href="/tom-certo.css">
    <style>
        body {
            background: linear-gradient(180deg, #0a0a0a 0%, #1a1a1a 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
        }
        .download-card {
            background: rgba(20,20,20,0.95);
            border: 1px solid rgba(255,176,32,0.2);
            border-radius: 24px;
            padding: 40px;
            max-width: 420px;
            width: 100%;
            text-align: center;
            box-shadow: 0 20px 60px rgba(0,0,0,0.5);
        }
        .logo-img {
            width: 100px;
            height: 100px;
            margin-bottom: 20px;
        }
        h1 {
            color: #fff;
            font-size: 28px;
            margin-bottom: 8px;
        }
        .version {
            color: #FFB020;
            font-size: 14px;
            margin-bottom: 24px;
        }
        .download-btn {
            display: inline-flex;
            align-items: center;
            gap: 10px;
            background: linear-gradient(135deg, #FFB020 0%, #FF9500 100%);
            color: #000;
            font-weight: 700;
            font-size: 16px;
            padding: 16px 32px;
            border-radius: 12px;
            text-decoration: none;
            transition: transform 0.2s, box-shadow 0.2s;
            margin-bottom: 32px;
        }
        .download-btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 8px 24px rgba(255,176,32,0.3);
        }
        .download-btn svg {
            width: 20px;
            height: 20px;
        }
        .credentials {
            background: rgba(255,176,32,0.08);
            border: 1px solid rgba(255,176,32,0.2);
            border-radius: 12px;
            padding: 20px;
            text-align: left;
        }
        .credentials h3 {
            color: #FFB020;
            font-size: 12px;
            text-transform: uppercase;
            letter-spacing: 1.5px;
            margin-bottom: 16px;
        }
        .cred-item {
            margin-bottom: 12px;
        }
        .cred-item:last-child {
            margin-bottom: 0;
        }
        .cred-label {
            color: #888;
            font-size: 11px;
            text-transform: uppercase;
            letter-spacing: 1px;
            margin-bottom: 4px;
        }
        .cred-value {
            color: #fff;
            font-family: monospace;
            font-size: 15px;
            background: rgba(0,0,0,0.3);
            padding: 8px 12px;
            border-radius: 6px;
            user-select: all;
        }
        .info {
            color: #666;
            font-size: 12px;
            margin-top: 24px;
            line-height: 1.6;
        }
    </style>
</head>
<body>
    <div class="download-card">
        <img src="/tom-certo-logo-clean.png" alt="Tom Certo" class="logo-img">
        <h1>Tom Certo</h1>
        <p class="version">v3.6.3 • Detecção Inteligente de Tom</p>
        
        <a href="/TomCerto.apk" class="download-btn" download>
            <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>
            </svg>
            Baixar APK (Android)
        </a>
        
        <div class="credentials">
            <h3>🔑 Credenciais de Acesso</h3>
            <div class="cred-item">
                <div class="cred-label">Código de Ativação</div>
                <div class="cred-value">TC-DDA7-FB9E</div>
            </div>
        </div>
        
        <p class="info">
            Após instalar, abra o app e insira o código acima para ativar.<br>
            O código permite até 3 dispositivos simultâneos.
        </p>
    </div>
</body>
</html>
    """)

@app.get("/TomCerto.apk")
async def download_apk():
    """Download direto do APK"""
    apk_path = ROOT_DIR / "static" / "TomCerto.apk"
    if not apk_path.exists():
        raise HTTPException(status_code=404, detail="APK não encontrado")
    return FileResponse(
        path=apk_path,
        filename="TomCerto.apk",
        media_type="application/vnd.android.package-archive"
    )

@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()
    logger.info("MongoDB client fechado.")
