from fastapi import FastAPI, APIRouter, Request, HTTPException, Depends, BackgroundTasks
from fastapi.responses import JSONResponse, HTMLResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
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

    token_doc = await db.tokens.find_one({"code": code})
    if not token_doc:
        return JSONResponse({"valid": False, "reason": "not_found"}, status_code=200)

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

# ─── Analyze Key (CREPE + Krumhansl-Aarden + acumulador de sessão) ─────
# Acumulador de PCP por device — ATIVO durante uma sessão, zerado pelo
# endpoint /reset (chamado pelo frontend quando usuário clica START).
# Cada análise sucessiva soma o PCP atual, deixando a detecção mais
# estável a cada clipe (sem precisar esperar consenso entre clipes).
import numpy as _np
from collections import defaultdict as _dd
_pcp_session: dict = _dd(lambda: {'pcp': _np.zeros(12), 'count': 0})


@api_router.post("/analyze-key/reset")
async def reset_session(request: Request):
    """Zera o acumulador de PCP — chamado quando usuário inicia nova sessão."""
    device_id = request.headers.get('X-Device-Id', 'anon')
    if device_id in _pcp_session:
        _pcp_session.pop(device_id, None)
    logger.info(f"[AnalyzeKey] sessão resetada dev={device_id[:8]}")
    return {'reset': True, 'device': device_id[:8]}


@api_router.post("/analyze-key")
async def analyze_key(request: Request):
    """
    Pipeline: CREPE → notas → PCP do clipe → SOMA no acumulador da sessão →
    Krumhansl-Schmuckler com Aarden-Essen sobre o PCP acumulado.

    O acumulador zera quando frontend chama /analyze-key/reset (no START).
    """
    audio_bytes = await request.body()
    device_id = request.headers.get('X-Device-Id', 'anon')
    logger.info(f"[AnalyzeKey] recebeu {len(audio_bytes)} bytes dev={device_id[:8]}")
    if not audio_bytes or len(audio_bytes) < 500:
        return JSONResponse({
            "success": False, "error": "audio_too_short",
            "message": "Áudio muito curto ou vazio."
        }, status_code=400)

    try:
        from key_detection import (
            load_audio_from_bytes, extract_f0_with_crepe, f0_to_midi,
            segment_notes, detect_phrases,
            compute_weighted_histogram, absorb_detuning,
            compute_tonic_gravity, detect_key_from_notes,
            SAMPLE_RATE as _SR,
        )

        audio = load_audio_from_bytes(audio_bytes, target_sr=_SR)
        duration_s = float(len(audio) / _SR)
        if duration_s < 1.5:
            return JSONResponse({
                'success': False, 'error': 'audio_too_short',
                'message': f'Áudio muito curto ({duration_s:.1f}s).',
                'duration_s': duration_s,
            })

        f0_hz, conf_arr = extract_f0_with_crepe(audio, _SR)
        midi = f0_to_midi(f0_hz)
        notes = segment_notes(midi, conf_arr)
        phrases = detect_phrases(notes)

        if not notes:
            return JSONResponse({
                'success': False, 'error': 'no_valid_pitch',
                'message': 'Nenhuma nota detectada no áudio.',
                'duration_s': duration_s,
            })

        # ── Acumulador de PCP da SESSÃO ──
        # Calcula PCP do clipe atual (com suavização 12% nos vizinhos),
        # SOMA no acumulador da sessão deste device.
        # Detecção é feita sobre o PCP TOTAL acumulado — fica mais estável
        # a cada clipe sucessivo. Reseta com /analyze-key/reset.
        SMOOTH = 0.12
        clip_pcp = _np.zeros(12, dtype=_np.float64)
        for n in notes:
            w = n['dur_ms'] * n.get('rms_conf', 1.0)
            pc = n['pitch_class']
            clip_pcp[pc]              += w * (1 - 2 * SMOOTH)
            clip_pcp[(pc - 1) % 12]   += w * SMOOTH
            clip_pcp[(pc + 1) % 12]   += w * SMOOTH

        sess = _pcp_session[device_id]
        sess['pcp'] = sess['pcp'] + clip_pcp
        sess['count'] += 1

        # Detecção sobre PCP ACUMULADO (não só o do clipe)
        from key_detection import detect_key_theory_first
        result = detect_key_theory_first(notes, phrases, pcp_override=sess['pcp'])
        result['success'] = True
        result['duration_s'] = duration_s
        result['notes_count'] = len(notes)
        result['phrases_count'] = len(phrases)
        result['session_clips'] = int(sess['count'])
        result['method'] = f'krumhansl-aarden+session-accum(N={int(sess["count"])})'

        # Logging detalhado do novo algoritmo Krumhansl-Aarden
        hist = result.get('histogram', [])
        note_names = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B']
        hist_sorted = sorted(range(12), key=lambda i: hist[i], reverse=True) if len(hist) == 12 else []
        hist_str = ' '.join(f"{note_names[i]}={hist[i]:.0f}" for i in hist_sorted[:5]) if hist_sorted else 'n/a'
        tops = result.get('top_candidates', [])[:3]
        tops_str = ' | '.join(
            f"{t['key']}(corr={t['correlation']:.3f})"
            for t in tops
        )
        diag = result.get('diag', {})
        logger.info(
            f"[AnalyzeKey] ✓ key={result.get('key_name', '?')} "
            f"conf={result.get('confidence', 0):.2f} "
            f"notes={len(notes)} phrases={len(phrases)} "
            f"flags={result.get('flags', [])}"
        )
        logger.info(f"[AnalyzeKey]   PCP top5: {hist_str}")
        logger.info(
            f"[AnalyzeKey]   top3: {tops_str}  "
            f"score_margin={diag.get('score_margin', 0):.3f} "
            f"corr_margin={diag.get('corr_margin', 0):.3f}"
        )

        return JSONResponse(result)
    except Exception as e:
        logger.error(f"[AnalyzeKey] Erro: {e}", exc_info=True)
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
LANDING_HTML_PATH = ROOT_DIR / "landing.html"
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

# ─── Arquivos estáticos da landing page (CSS, JS) ────────────────────────
LANDING_DIR = ROOT_DIR / "landing"
if LANDING_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(LANDING_DIR / "static")), name="static")

# ─── Favicon ─────────────────────────────────────────────────────────────
FAVICON_PATH = LANDING_DIR / "favicon.ico"

@app.get("/favicon.ico")
async def favicon():
    """Serve o favicon."""
    if FAVICON_PATH.exists():
        return FileResponse(str(FAVICON_PATH), media_type="image/x-icon")
    return JSONResponse({"error": "favicon not found"}, status_code=404)

# ─── Landing page — serve no root "/" e em "/landing" ───────────────────
LANDING_INDEX = LANDING_DIR / "index.html"

@app.get("/", response_class=HTMLResponse)
async def landing_root():
    """Página de vendas do Tom Certo (root)."""
    if LANDING_INDEX.exists():
        return HTMLResponse(LANDING_INDEX.read_text(encoding="utf-8"))
    # Fallback para landing.html antigo
    if LANDING_HTML_PATH.exists():
        return HTMLResponse(LANDING_HTML_PATH.read_text(encoding="utf-8"))
    return HTMLResponse("<h1>Landing page não encontrada</h1>", status_code=500)

@app.get("/landing", response_class=HTMLResponse)
async def landing_page():
    """Página de vendas do Tom Certo."""
    if LANDING_INDEX.exists():
        return HTMLResponse(LANDING_INDEX.read_text(encoding="utf-8"))
    if LANDING_HTML_PATH.exists():
        return HTMLResponse(LANDING_HTML_PATH.read_text(encoding="utf-8"))
    return HTMLResponse("<h1>Landing page não encontrada</h1>", status_code=500)

@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()
    logger.info("MongoDB client fechado.")
