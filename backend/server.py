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
from models import PlanType, TokenStatus, PLAN_DURATIONS, PLAN_PRICES, WebhookCaktoPayload, normalize_plan, get_plan_features
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
    customer_contact: Optional[str] = None  # WhatsApp ou email
    plan_type: Optional[str] = "essential"  # essential | professional
    device_limit: int = 1             # FASE 2: 1 dispositivo por token
    duration_minutes: Optional[int] = None   # legado — soma com duration_value abaixo
    duration_value: Optional[int] = None     # novo: 1, 30, 7, etc
    duration_unit: Optional[str] = None      # novo: 'minutes' | 'hours' | 'days' | 'months' | 'forever'
    notes: Optional[str] = None

class TokenUpdate(BaseModel):
    active: Optional[bool] = None
    customer_name: Optional[str] = None
    customer_contact: Optional[str] = None
    plan_type: Optional[str] = None
    device_limit: Optional[int] = None
    notes: Optional[str] = None
    # FASE 2: campos de reset de dispositivo (admin)
    device_id: Optional[str] = None
    reset_count: Optional[int] = None

# FASE 2: Request para troca de dispositivo
class DeviceSwapRequest(BaseModel):
    token: str
    new_device_id: str
    new_device_name: Optional[str] = None

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

    # ═══════════════════════════════════════════════════════════════════════
    # FASE 2: CONTROLE DE DISPOSITIVO ÚNICO
    # ═══════════════════════════════════════════════════════════════════════
    stored_device_id = token_doc.get("device_id")
    reset_count = token_doc.get("reset_count", 0)
    max_auto_resets = token_doc.get("max_auto_resets", 2)
    auto_reset_cooldown_days = token_doc.get("auto_reset_cooldown_days", 30)
    last_device_reset_at = token_doc.get("last_device_reset_at")
    
    # Se não tem dispositivo vinculado → vincula o atual (primeiro login)
    if not stored_device_id:
        now = datetime.now(timezone.utc)
        await db.tokens.update_one(
            {"_id": token_doc["_id"]},
            {"$set": {
                "device_id": device_id,
                "device_linked_at": now,
                "first_used_at": token_doc.get("first_used_at") or now,
                "last_used_at": now,
                "active_devices": [device_id],
            }}
        )
        logger.info(f"[Auth] Primeiro login - device vinculado: code={code[:4]}*** device={device_id[:8]}...")
    
    # Se o dispositivo é diferente do vinculado → BLOQUEAR
    elif stored_device_id != device_id:
        # Verifica se pode fazer auto-troca
        can_swap = False
        swap_blocked_reason = None
        
        if reset_count >= max_auto_resets:
            swap_blocked_reason = "swap_limit_reached"
        elif last_device_reset_at:
            cooldown_end = last_device_reset_at + timedelta(days=auto_reset_cooldown_days)
            if datetime.now(timezone.utc) < cooldown_end:
                days_remaining = (cooldown_end - datetime.now(timezone.utc)).days
                swap_blocked_reason = f"cooldown_active:{days_remaining}"
            else:
                can_swap = True
        else:
            can_swap = True
        
        return JSONResponse({
            "valid": False,
            "reason": "device_mismatch",
            "can_swap": can_swap,
            "swap_blocked_reason": swap_blocked_reason,
            "reset_count": reset_count,
            "max_auto_resets": max_auto_resets,
        }, status_code=200)
    
    # Dispositivo correto → atualiza last_used_at
    else:
        await db.tokens.update_one(
            {"_id": token_doc["_id"]},
            {"$set": {"last_used_at": datetime.now(timezone.utc)}}
        )

    token_id = str(token_doc["_id"])
    customer_name = token_doc.get("customer_name") or token_doc.get("nome_usuario")
    duration_minutes = token_doc.get("duration_minutes")
    expires_at_str = expires_at.isoformat() if isinstance(expires_at, datetime) else expires_at
    
    # Obter plano e features
    plano_raw = token_doc.get("plano", "essencial")
    plano = normalize_plan(plano_raw)
    features = get_plan_features(plano)

    session = create_session_token(token_id, device_id, customer_name, duration_minutes, expires_at_str)

    logger.info(f"[Auth] Token validado: code={code[:4]}*** device={device_id[:8]}... plano={plano}")
    return JSONResponse({
        "valid": True,
        "session": session,
        "token_id": token_id,
        "customer_name": customer_name,
        "duration_minutes": duration_minutes,
        "expires_at": expires_at_str,
        "plano": plano,
        "features": features,
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

    customer_name = token_doc.get("customer_name") or token_doc.get("nome_usuario")
    duration_minutes = token_doc.get("duration_minutes")
    expires_at = token_doc.get("expires_at")
    expires_at_str = expires_at.isoformat() if isinstance(expires_at, datetime) else expires_at
    
    # Obter plano e features
    plano_raw = token_doc.get("plano", "essencial")
    plano = normalize_plan(plano_raw)
    features = get_plan_features(plano)

    return JSONResponse({
        "valid": True,
        "customer_name": customer_name,
        "duration_minutes": duration_minutes,
        "expires_at": expires_at_str,
        "plano": plano,
        "features": features,
    })


# ═══════════════════════════════════════════════════════════════════════════
# FASE 2: TROCA DE DISPOSITIVO (Auto-swap pelo usuário)
# ═══════════════════════════════════════════════════════════════════════════
@api_router.post("/auth/swap-device")
async def swap_device(body: DeviceSwapRequest):
    """
    Permite ao usuário transferir o acesso para um novo dispositivo.
    Regras anti-fraude:
    - Máximo de 2 trocas automáticas durante a validade do token
    - Mínimo de 30 dias entre trocas
    """
    code = body.token.strip().upper()
    new_device_id = body.new_device_id.strip()
    new_device_name = body.new_device_name
    
    if not code or not new_device_id:
        return JSONResponse({"ok": False, "reason": "invalid_request"}, status_code=400)
    
    # Busca o token
    token_doc = await db.tokens.find_one({
        "$or": [{"token": code}, {"code": code}]
    })
    
    if not token_doc:
        return JSONResponse({"ok": False, "reason": "not_found"}, status_code=200)
    
    # Verifica se está ativo
    if not token_doc.get("active", True):
        return JSONResponse({"ok": False, "reason": "revoked"}, status_code=200)
    
    # Verifica expiração
    expires_at = token_doc.get("expires_at")
    if expires_at:
        exp_dt = expires_at if isinstance(expires_at, datetime) else datetime.fromisoformat(str(expires_at).replace('Z', '+00:00'))
        if datetime.now(timezone.utc) > exp_dt.replace(tzinfo=timezone.utc):
            return JSONResponse({"ok": False, "reason": "expired"}, status_code=200)
    
    # Verifica limites de troca
    reset_count = token_doc.get("reset_count", 0)
    max_auto_resets = token_doc.get("max_auto_resets", 2)
    auto_reset_cooldown_days = token_doc.get("auto_reset_cooldown_days", 30)
    last_device_reset_at = token_doc.get("last_device_reset_at")
    
    if reset_count >= max_auto_resets:
        return JSONResponse({
            "ok": False,
            "reason": "swap_limit_reached",
            "message": "Limite de troca atingido. Fale com o suporte para liberar seu acesso.",
        }, status_code=200)
    
    if last_device_reset_at:
        cooldown_end = last_device_reset_at + timedelta(days=auto_reset_cooldown_days)
        if datetime.now(timezone.utc) < cooldown_end:
            days_remaining = (cooldown_end - datetime.now(timezone.utc)).days
            return JSONResponse({
                "ok": False,
                "reason": "cooldown_active",
                "message": f"Você poderá trocar de dispositivo em {days_remaining} dias.",
                "days_remaining": days_remaining,
            }, status_code=200)
    
    # Realiza a troca
    now = datetime.now(timezone.utc)
    old_device_id = token_doc.get("device_id")
    
    await db.tokens.update_one(
        {"_id": token_doc["_id"]},
        {"$set": {
            "device_id": new_device_id,
            "device_name": new_device_name,
            "device_linked_at": now,
            "reset_count": reset_count + 1,
            "last_device_reset_at": now,
            "last_used_at": now,
            "active_devices": [new_device_id],
            "updated_at": now,
        }}
    )
    
    logger.info(f"[Auth] Device swap: code={code[:4]}*** old={old_device_id[:8] if old_device_id else 'none'}... new={new_device_id[:8]}... reset_count={reset_count + 1}")
    
    # Gera nova sessão para o novo dispositivo
    token_id = str(token_doc["_id"])
    customer_name = token_doc.get("customer_name") or token_doc.get("nome_usuario")
    duration_minutes = token_doc.get("duration_minutes")
    expires_at_str = expires_at.isoformat() if isinstance(expires_at, datetime) else expires_at
    
    session = create_session_token(token_id, new_device_id, customer_name, duration_minutes, expires_at_str)
    
    # Obter plano e features
    plano_raw = token_doc.get("plano", "essencial")
    plano = normalize_plan(plano_raw)
    features = get_plan_features(plano)
    
    return JSONResponse({
        "ok": True,
        "message": "Dispositivo transferido com sucesso!",
        "session": session,
        "customer_name": customer_name,
        "plano": plano,
        "features": features,
        "expires_at": expires_at_str,
        "reset_count": reset_count + 1,
        "max_auto_resets": max_auto_resets,
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

from key_detection_v10 import (
    analyze_audio_bytes_v10,
    reset_session,
    get_session as _get_kd_session,
    NOTE_NAMES_BR,
)


@api_router.post("/analyze-key/reset")
async def reset_key_session(request: Request):
    """Zera o acumulador de sessão — chamado quando usuário inicia nova análise."""
    device_id = request.headers.get('X-Device-Id', 'anon')
    reset_session(device_id)
    logger.info(f"[AnalyzeKey v10] sessão resetada dev={device_id[:8]}")
    return {'reset': True, 'device': device_id[:8], 'version': 'v10-definitivo'}


# ═══════════════════════════════════════════════════════════════════════════════
# FEEDBACK DO USUÁRIO (v3.17) — quando usuário marca "tom errado"
# ═══════════════════════════════════════════════════════════════════════════════
from feedback_service import (
    build_feedback_document,
    aggregate_error_stats,
    parse_key_name,
    NOTE_NAMES_BR as FB_NOTE_NAMES,
)
from admin_push import (
    upsert_admin_token,
    list_admin_tokens,
    deactivate_token as deactivate_push_token,
    notify_admins,
    format_feedback_notification,
    is_valid_expo_token,
)


class KeyFeedbackRequest(BaseModel):
    """Payload quando o usuário reporta 'tom errado'."""
    correct_key_name: str           # Ex: "Sol Maior", "Lá menor", "Lá# Maior"
    session_id: Optional[str] = None  # Passado pelo frontend, ou usa X-Device-Id
    user_comment: Optional[str] = None  # Ex: "estava cantando em Sol, detectou Si"


@api_router.post("/key-feedback/submit")
async def submit_key_feedback(payload: KeyFeedbackRequest, request: Request):
    """
    O usuário informa que o tom detectado está errado.
    Salvamos features (PCP, notes, candidates) para análise posterior.
    """
    device_id = request.headers.get('X-Device-Id', 'anon')
    session_id = payload.session_id or device_id
    
    # Validar tom correto informado
    parsed = parse_key_name(payload.correct_key_name)
    if parsed is None:
        raise HTTPException(400, f"Tom correto inválido: {payload.correct_key_name!r}. Use ex.: 'Sol Maior', 'Lá menor'.")
    
    # Pegar snapshot da última análise do usuário
    session = _get_kd_session(device_id)
    snapshot = session.get_feedback_snapshot()
    
    if snapshot is None:
        raise HTTPException(
            400,
            "Não há análise recente para esse dispositivo. Detecte um tom antes de reportar."
        )
    
    detected = snapshot['result']
    analysis_debug = detected.get('debug', {})
    notes_summary = snapshot.get('notes_summary', [])
    
    doc = build_feedback_document(
        session_id=session_id,
        device_id=device_id,
        detected={
            'key_name': detected.get('key_name'),
            'confidence': detected.get('confidence'),
        },
        correct_key_name=payload.correct_key_name,
        analysis_debug=analysis_debug,
        notes_summary=notes_summary,
    )
    
    if doc is None:
        raise HTTPException(500, "Falha ao montar documento de feedback.")
    
    if payload.user_comment:
        doc['user_comment'] = payload.user_comment[:500]  # limitar tamanho
    
    # Persistir no MongoDB
    await db.key_feedback.insert_one(doc)
    
    logger.info(
        f"[key-feedback] detected={detected.get('key_name')} correct={payload.correct_key_name} "
        f"→ type={doc['error_classification']['type']} causes={len(doc['possible_causes'])}"
    )
    
    # Disparar push notification para admin(s) — fire-and-forget, não bloqueia resposta.
    # Remove _id (ObjectId) antes para não impactar sua serialização.
    doc_for_notif = {k: v for k, v in doc.items() if k != '_id'}
    try:
        msg = format_feedback_notification(doc_for_notif)
        asyncio.create_task(notify_admins(
            db,
            title=msg['title'],
            body=msg['body'],
            data={
                'type': 'wrong_key_feedback',
                'error_type': doc['error_classification']['type'],
                'detected': doc['detected']['key_name'],
                'correct': doc['correct']['key_name'],
                'diff': doc['error_classification'].get('diff_semitones'),
            },
        ))
    except Exception as exc:
        logger.warning(f"[key-feedback] erro agendando push notification: {exc}")
    
    return {
        'success': True,
        'message': 'Obrigado! Vou analisar esse caso para melhorar a detecção.',
        'error_type': doc['error_classification']['type'],
        'possible_causes': doc['possible_causes'],
    }


@api_router.get("/key-feedback/stats")
async def key_feedback_stats(request: Request):
    """
    Estatísticas agregadas de feedback (tipos de erro, tons mais confundidos).
    Útil para decidir ajustes no algoritmo.
    Requer header X-Admin-Token se ADMIN_TOKEN está configurado.
    """
    admin_token_required = os.environ.get('ADMIN_TOKEN')
    if admin_token_required:
        provided = request.headers.get('X-Admin-Token', '')
        if provided != admin_token_required:
            raise HTTPException(401, "token admin necessário")
    
    cursor = db.key_feedback.find({}, {'_id': 0}).sort('timestamp', -1).limit(1000)
    docs = await cursor.to_list(length=1000)
    
    # Serializar datetime para string
    for d in docs:
        if 'timestamp' in d and hasattr(d['timestamp'], 'isoformat'):
            d['timestamp'] = d['timestamp'].isoformat()
    
    stats = aggregate_error_stats(docs)
    stats['recent_samples'] = docs[:20]  # 20 amostras mais recentes
    return stats


# ═══════════════════════════════════════════════════════════════════════════════
# ADMIN PUSH TOKENS — notificações para o dev quando eventos importantes ocorrem
# ═══════════════════════════════════════════════════════════════════════════════

class AdminPushTokenPayload(BaseModel):
    token: str
    device_id: str
    label: Optional[str] = None


@api_router.post("/admin/push-token")
async def register_admin_push_token(payload: AdminPushTokenPayload, request: Request):
    """Registra o Expo Push Token de um dispositivo admin.
    Protegido por X-Admin-Key (ADMIN_KEY env var).
    """
    verify_admin(request)
    if not is_valid_expo_token(payload.token):
        raise HTTPException(400, "Expo push token inválido (esperado formato 'ExponentPushToken[...]')")
    try:
        result = await upsert_admin_token(db, payload.token, payload.device_id, payload.label)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    return {'ok': True, **result}


@api_router.get("/admin/push-token")
async def list_admin_push_tokens(request: Request):
    verify_admin(request)
    tokens = await list_admin_tokens(db)
    # Serializar datetimes
    for t in tokens:
        for k in ('created_at', 'updated_at'):
            v = t.get(k)
            if hasattr(v, 'isoformat'):
                t[k] = v.isoformat()
    return {'tokens': tokens, 'count': len(tokens)}


@api_router.delete("/admin/push-token")
async def revoke_admin_push_token(request: Request, token: str):
    verify_admin(request)
    ok = await deactivate_push_token(db, token)
    return {'ok': ok}


@api_router.post("/admin/push-token/test")
async def test_admin_push(request: Request):
    """Dispara um push de teste para todos os tokens ativos."""
    verify_admin(request)
    result = await notify_admins(
        db,
        title="Tom Certo — teste de notificação",
        body="Se você recebeu isso, o push admin está funcionando! 🎵",
        data={'type': 'test'},
    )
    return result


@api_router.post("/analyze-key/diagnostic")
async def analyze_key_diagnostic(request: Request):
    """
    DIAGNÓSTICO — Mostra exatamente o que o CREPE detecta, nota a nota.
    Use para verificar se o áudio está chegando corretamente ao backend.
    Acesse: POST /api/analyze-key/diagnostic com body = WAV bytes
    """
    from key_detection_v10 import load_audio, extract_pitch, pitch_to_notes, NOTE_NAMES_BR, SAMPLE_RATE
    import numpy as np

    audio_bytes = await request.body()
    device_id = request.headers.get('X-Device-Id', 'diag')

    if not audio_bytes:
        return JSONResponse({"error": "sem audio"}, status_code=400)

    # 1. Carregar áudio
    audio, has_audio = load_audio(audio_bytes)
    duration_s = len(audio) / SAMPLE_RATE
    rms = float(np.sqrt(np.mean(audio ** 2)))

    # 2. Extrair pitch com CREPE
    f0, conf = extract_pitch(audio)
    valid_mask = ~np.isnan(f0)
    valid_frames = int(valid_mask.sum())
    total_frames = len(f0)

    # 3. Distribuição de pitch classes detectados
    pcp = {}
    if valid_frames > 0:
        midis = 69.0 + 12.0 * np.log2(f0[valid_mask] / 440.0)
        for m in midis:
            pc = int(round(m)) % 12
            pcp[NOTE_NAMES_BR[pc]] = pcp.get(NOTE_NAMES_BR[pc], 0) + 1
        # Ordenar por contagem
        pcp = dict(sorted(pcp.items(), key=lambda x: -x[1]))

    # 4. Converter em notas
    notes = pitch_to_notes(f0, conf)
    notes_detail = [
        {
            "nota": NOTE_NAMES_BR[n.pitch_class],
            "dur_ms": round(n.dur_ms),
            "conf": round(n.confidence, 2),
            "phrase_end": n.is_phrase_end,
        }
        for n in notes
    ]

    # 5. Confiança média dos frames válidos
    avg_conf = float(np.mean(conf[valid_mask])) if valid_frames > 0 else 0.0

    resultado = {
        "audio": {
            "bytes": len(audio_bytes),
            "duration_s": round(duration_s, 2),
            "rms": round(rms, 4),
            "has_audio": bool(has_audio),
        },
        "crepe": {
            "total_frames": int(total_frames),
            "valid_frames": int(valid_frames),
            "valid_pct": round(100 * valid_frames / max(total_frames, 1), 1),
            "avg_confidence": round(float(avg_conf), 3),
            "pitch_class_distribution": pcp,
        },
        "notes_extracted": int(len(notes)),
        "notes": notes_detail,
        "verdict": "audio_ok" if (has_audio and valid_frames > 20 and len(notes) >= 2) else "problema_no_audio",
    }

    logger.info(f"[DIAG] {device_id[:8]} | {duration_s:.1f}s | valid={valid_frames}/{total_frames} | notas={len(notes)} | pcp={pcp}")
    return JSONResponse(resultado)


@api_router.post("/analyze-key")
async def analyze_key(request: Request):
    """DETECÇÃO DE TONALIDADE v10 — VERSÃO DEFINITIVA"""
    audio_bytes = await request.body()
    device_id = request.headers.get('X-Device-Id', 'anon')
    logger.info(f"[AnalyzeKey v10] recebeu {len(audio_bytes)} bytes dev={device_id[:8]}")
    
    if not audio_bytes or len(audio_bytes) < 500:
        return JSONResponse({
            "success": False, "error": "audio_too_short",
            "message": "Áudio muito curto ou vazio."
        }, status_code=400)

    try:
        result = analyze_audio_bytes_v10(
            audio_bytes=audio_bytes,
            device_id=device_id,
        )
        
        if result.get('success'):
            locked_str = '🔒TRAVADO' if result.get('locked') else '⏳analisando'
            logger.info(
                f"[AnalyzeKey v10] ✓ {locked_str} key={result.get('key_name', '?')} "
                f"conf={result.get('confidence', 0):.2f} "
                f"analyses={result.get('analyses', 0)} "
                f"notes={result.get('clip_notes', 0)}"
            )
        else:
            logger.warning(f"[AnalyzeKey v10] ✗ error={result.get('error')}")

        return JSONResponse(result)
        
    except Exception as e:
        logger.error(f"[AnalyzeKey v10] Erro: {e}", exc_info=True)
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
                "id": "essencial",
                "name": "Essencial",
                "price": 9.90,
                "duration_days": 30,
                "badge": None,
                "checkout_url": "https://checkout.ticto.app/ODBC8F242",
            },
            {
                "id": "profissional",
                "name": "Profissional",
                "price": 19.90,
                "duration_days": 30,
                "badge": "MAIS ESCOLHIDO",
                "checkout_url": "https://checkout.ticto.app/OF743CFCB",
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
    
    # Normalizar plan_type
    plan_type = (body.plan_type or "essential").lower()
    if plan_type not in ("essential", "professional"):
        plan_type = "essential"
    
    # Mapear plan_type para plano interno
    plano = "essencial" if plan_type == "essential" else "profissional"
    
    doc = {
        "code": code,
        "token": code,  # compatibilidade
        "customer_name": body.customer_name,
        "nome_usuario": body.customer_name,  # compatibilidade
        "customer_contact": body.customer_contact,
        "plan_type": plan_type,
        "plano": plano,
        "device_limit": body.device_limit or 1,  # FASE 2: 1 dispositivo por padrão
        "max_devices": body.device_limit or 1,
        "active_devices": [],
        "active": True,
        "status": "ativo",
        "created_at": datetime.now(timezone.utc),
        "expires_at": None,
        "duration_minutes": duration_minutes,
        "notes": body.notes,
        # FASE 2: Campos de controle de dispositivo
        "device_id": None,
        "device_name": None,
        "device_linked_at": None,
        "reset_count": 0,
        "last_device_reset_at": None,
        "max_auto_resets": 2,  # Máximo de trocas automáticas durante validade
        "auto_reset_cooldown_days": 30,  # Mínimo 30 dias entre trocas
        "last_used_at": None,
        "first_used_at": None,
    }
    if duration_minutes:
        doc["expires_at"] = datetime.now(timezone.utc) + timedelta(minutes=duration_minutes)
        doc["duration_days"] = round(duration_minutes / 1440)

    result = await db.tokens.insert_one(doc)
    expires_at_iso = doc["expires_at"].isoformat() if doc["expires_at"] else None
    return JSONResponse({
        "ok": True,
        "token_id": str(result.inserted_id),
        "code": code,
        "customer_name": body.customer_name,
        "customer_contact": body.customer_contact,
        "plan_type": plan_type,
        "plano": plano,
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
        update["status"] = "ativo" if body.active else "cancelado"
    if body.customer_name is not None:
        update["customer_name"] = body.customer_name
        update["nome_usuario"] = body.customer_name
    if body.customer_contact is not None:
        update["customer_contact"] = body.customer_contact
    if body.plan_type is not None:
        plan_type = body.plan_type.lower()
        if plan_type in ("essential", "professional"):
            update["plan_type"] = plan_type
            update["plano"] = "essencial" if plan_type == "essential" else "profissional"
    if body.device_limit is not None:
        update["device_limit"] = body.device_limit
        update["max_devices"] = body.device_limit
    if body.notes is not None:
        update["notes"] = body.notes
    # FASE 2: Admin pode resetar dispositivo manualmente
    if body.device_id is not None:
        update["device_id"] = body.device_id if body.device_id else None
        if not body.device_id:
            # Reset completo
            update["device_name"] = None
            update["device_linked_at"] = None
    if body.reset_count is not None:
        update["reset_count"] = body.reset_count
    if not update:
        raise HTTPException(400, "Nada para atualizar")
    update["updated_at"] = datetime.now(timezone.utc)
    result = await db.tokens.update_one({"_id": oid}, {"$set": update})
    if result.matched_count == 0:
        raise HTTPException(404, "Token não encontrado")
    return JSONResponse({"ok": True})


# FASE 2: Reset de dispositivo pelo admin
@api_router.post("/admin/tokens/{token_id}/reset-device")
async def admin_reset_device(token_id: str, request: Request):
    """Admin pode resetar o dispositivo vinculado a qualquer momento."""
    verify_admin(request)
    try:
        oid = ObjectId(token_id)
    except Exception:
        raise HTTPException(400, "token_id inválido")
    
    result = await db.tokens.update_one(
        {"_id": oid},
        {"$set": {
            "device_id": None,
            "device_name": None,
            "device_linked_at": None,
            "active_devices": [],
            "updated_at": datetime.now(timezone.utc)
        }}
    )
    if result.matched_count == 0:
        raise HTTPException(404, "Token não encontrado")
    
    logger.info(f"[Admin] Device reset para token_id={token_id}")
    return JSONResponse({"ok": True, "message": "Dispositivo desvinculado com sucesso"})

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


# ─── Planos e Checkout URLs ─────────────────────────────────────────────
@api_router.get("/planos")
async def get_planos():
    """Retorna as URLs de checkout dos planos disponíveis."""
    return {
        "planos": [
            {
                "id": "essencial",
                "nome": "Essencial",
                "preco": "R$ 9,90",
                "preco_cents": 990,
                "duracao_dias": 30,
                "checkout_url": "https://checkout.ticto.app/ODBC8F242",
                "destaque": False,
                "features": {
                    "key_detection": True,
                    "harmonic_field": True,
                    "real_time_chord": False,
                    "smart_chords": False,
                },
                "features_list": [
                    "✔ Detecção de tom",
                    "✔ Campo harmônico completo",
                    "❌ Acordes em tempo real",
                ],
            },
            {
                "id": "profissional",
                "nome": "Profissional",
                "preco": "R$ 19,90",
                "preco_cents": 1990,
                "duracao_dias": 30,
                "checkout_url": "https://checkout.ticto.app/OF743CFCB",
                "destaque": True,
                "badge": "🔥 MAIS ESCOLHIDO",
                "features": {
                    "key_detection": True,
                    "harmonic_field": True,
                    "real_time_chord": True,
                    "smart_chords": True,
                },
                "features_list": [
                    "✔ Detecção de tom",
                    "✔ Campo harmônico completo",
                    "✔ Acordes em tempo real",
                    "✔ Diagramas de acordes",
                ],
            },
        ]
    }

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

# URL externa do APK mais recente (via variável de ambiente)
APK_EXTERNAL_URL = os.environ.get('APK_EXTERNAL_URL', os.environ.get('APK_DOWNLOAD_URL', 'https://tomcerto.online/download'))

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


@app.get("/download/pagina-vendas.zip")
async def download_landing_zip():
    """Serve o ZIP com o código-fonte estático da página de vendas."""
    zip_path = DOWNLOADS_DIR / "pagina-vendas.zip"
    if not zip_path.exists():
        raise HTTPException(404, "Arquivo não encontrado")
    return FileResponse(
        str(zip_path),
        media_type="application/zip",
        filename="tom-certo-pagina-vendas.zip",
    )


@app.get("/preview/landing", response_class=HTMLResponse)
@app.get("/api/preview/landing", response_class=HTMLResponse)
async def preview_landing_v2():
    """Preview temporário da landing page v2 (redesign premium)."""
    html_path = ROOT_DIR / "tom-certo-emergent-ready" / "standalone-html" / "v2.html"
    if not html_path.exists():
        raise HTTPException(404, "Preview não encontrado")
    return HTMLResponse(
        content=html_path.read_text(encoding="utf-8"),
        headers={
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "Pragma": "no-cache",
            "Expires": "0",
        },
    )


@app.get("/api/preview/asset/{name}")
async def preview_asset(name: str):
    """Serve assets da landing preview (logo, favicons)."""
    allowed = {"tom-certo-logo-clean.png", "favicon-256.png", "favicon.png", "favicon.ico"}
    if name not in allowed:
        raise HTTPException(404, "Asset não permitido")
    asset_path = ROOT_DIR / "tom-certo-emergent-ready" / "standalone-html" / name
    if not asset_path.exists():
        raise HTTPException(404, "Asset não encontrado")
    media = "image/x-icon" if name.endswith(".ico") else "image/png"
    return FileResponse(str(asset_path), media_type=media)

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

@app.get("/favicon.ico")
async def serve_favicon_ico():
    """Serve o favicon (multi-resolução ICO)."""
    fav = LANDING_DIR / "favicon.ico"
    if fav.exists():
        return FileResponse(str(fav), media_type="image/x-icon")
    fav2 = ROOT_DIR / "favicon.ico"
    if fav2.exists():
        return FileResponse(str(fav2), media_type="image/x-icon")
    raise HTTPException(404, "Favicon not found")

@app.get("/favicon.png")
async def serve_favicon_png():
    """Serve o favicon em PNG (1254x1254 — alta resolução)."""
    fav = LANDING_DIR / "favicon.png"
    if fav.exists():
        return FileResponse(str(fav), media_type="image/png")
    raise HTTPException(404, "Favicon not found")

@app.get("/favicon-256.png")
async def serve_favicon_256():
    """Serve o favicon em PNG 256x256 (otimizado para browsers)."""
    fav = LANDING_DIR / "favicon-256.png"
    if fav.exists():
        return FileResponse(str(fav), media_type="image/png")
    raise HTTPException(404, "Favicon not found")

@app.get("/apple-touch-icon.png")
async def serve_apple_touch_icon():
    """Apple touch icon (iOS adiciona à tela inicial)."""
    fav = LANDING_DIR / "favicon-256.png"
    if fav.exists():
        return FileResponse(str(fav), media_type="image/png")
    raise HTTPException(404, "Icon not found")

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
    """Página de download do APK com instruções de instalação"""
    return HTMLResponse("""
<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Tom Certo - Download</title>
    <link rel="icon" type="image/png" sizes="256x256" href="/favicon-256.png">
    <link rel="icon" type="image/x-icon" href="/favicon.ico">
    <link rel="apple-touch-icon" sizes="256x256" href="/favicon-256.png">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
            background: linear-gradient(180deg, #0a0a0a 0%, #141414 100%);
            min-height: 100vh;
            color: #fff;
            line-height: 1.6;
        }
        .container {
            max-width: 680px;
            margin: 0 auto;
            padding: 40px 20px 60px;
        }
        
        /* Header */
        .header {
            text-align: center;
            margin-bottom: 40px;
        }
        .logo {
            width: 72px;
            height: 72px;
            margin-bottom: 16px;
        }
        .app-name {
            font-size: 32px;
            font-weight: 700;
            margin-bottom: 6px;
        }
        .app-tagline {
            color: #FFB020;
            font-size: 15px;
            font-weight: 500;
        }
        .version-badge {
            display: inline-block;
            background: rgba(255,176,32,0.1);
            color: #FFB020;
            font-size: 11px;
            font-weight: 600;
            padding: 4px 10px;
            border-radius: 20px;
            margin-top: 12px;
        }
        
        /* Download Card */
        .download-card {
            background: linear-gradient(135deg, rgba(255,176,32,0.08) 0%, rgba(255,176,32,0.02) 100%);
            border: 1px solid rgba(255,176,32,0.2);
            border-radius: 16px;
            padding: 32px;
            text-align: center;
            margin-bottom: 32px;
        }
        .download-title {
            font-size: 20px;
            font-weight: 600;
            margin-bottom: 8px;
        }
        .download-subtitle {
            color: #888;
            font-size: 14px;
            margin-bottom: 24px;
        }
        .download-btn {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 10px;
            background: linear-gradient(135deg, #FFB020 0%, #E69B00 100%);
            color: #000;
            font-weight: 700;
            font-size: 16px;
            padding: 16px 40px;
            border-radius: 12px;
            text-decoration: none;
            transition: all 0.2s ease;
            box-shadow: 0 4px 20px rgba(255,176,32,0.25);
        }
        .download-btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 6px 28px rgba(255,176,32,0.35);
        }
        .download-btn svg {
            width: 20px;
            height: 20px;
        }
        .file-info {
            display: flex;
            justify-content: center;
            gap: 24px;
            margin-top: 20px;
            color: #666;
            font-size: 13px;
        }
        .file-info span {
            display: flex;
            align-items: center;
            gap: 6px;
        }
        
        /* Steps Section */
        .section {
            background: rgba(255,255,255,0.03);
            border: 1px solid rgba(255,255,255,0.06);
            border-radius: 16px;
            padding: 28px;
            margin-bottom: 24px;
        }
        .section-title {
            font-size: 16px;
            font-weight: 600;
            margin-bottom: 20px;
            display: flex;
            align-items: center;
            gap: 10px;
        }
        .section-title-icon {
            width: 28px;
            height: 28px;
            background: rgba(255,176,32,0.15);
            border-radius: 8px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 14px;
        }
        
        /* Steps */
        .steps {
            display: flex;
            flex-direction: column;
            gap: 16px;
        }
        .step {
            display: flex;
            gap: 14px;
            align-items: flex-start;
        }
        .step-number {
            width: 28px;
            height: 28px;
            background: rgba(255,176,32,0.12);
            border: 1px solid rgba(255,176,32,0.25);
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 13px;
            font-weight: 600;
            color: #FFB020;
            flex-shrink: 0;
        }
        .step-content h4 {
            font-size: 14px;
            font-weight: 600;
            margin-bottom: 4px;
            color: #fff;
        }
        .step-content p {
            font-size: 13px;
            color: #888;
            line-height: 1.5;
        }
        
        /* Security Section */
        .security-badges {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 12px;
        }
        .security-badge {
            background: rgba(16,185,129,0.08);
            border: 1px solid rgba(16,185,129,0.15);
            border-radius: 10px;
            padding: 14px;
            display: flex;
            align-items: center;
            gap: 10px;
        }
        .security-badge-icon {
            width: 32px;
            height: 32px;
            background: rgba(16,185,129,0.15);
            border-radius: 8px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 16px;
        }
        .security-badge-text {
            font-size: 12px;
            color: #888;
            line-height: 1.4;
        }
        .security-badge-text strong {
            display: block;
            color: #10B981;
            font-size: 13px;
            margin-bottom: 2px;
        }
        
        /* Activation Section */
        .activation-box {
            background: rgba(255,176,32,0.06);
            border: 1px dashed rgba(255,176,32,0.25);
            border-radius: 12px;
            padding: 20px;
            text-align: center;
        }
        .activation-box h4 {
            font-size: 14px;
            font-weight: 600;
            margin-bottom: 8px;
            color: #FFB020;
        }
        .activation-box p {
            font-size: 13px;
            color: #888;
            line-height: 1.6;
        }
        
        /* FAQ Section */
        .faq-item {
            border-bottom: 1px solid rgba(255,255,255,0.06);
            padding: 16px 0;
        }
        .faq-item:last-child {
            border-bottom: none;
            padding-bottom: 0;
        }
        .faq-item:first-child {
            padding-top: 0;
        }
        .faq-question {
            font-size: 14px;
            font-weight: 600;
            color: #fff;
            margin-bottom: 6px;
        }
        .faq-answer {
            font-size: 13px;
            color: #888;
            line-height: 1.6;
        }
        
        /* Footer */
        .footer {
            text-align: center;
            margin-top: 40px;
            padding-top: 24px;
            border-top: 1px solid rgba(255,255,255,0.06);
        }
        .footer-text {
            color: #555;
            font-size: 12px;
        }
        .footer-text a {
            color: #FFB020;
            text-decoration: none;
        }
        
        /* Responsive */
        @media (max-width: 500px) {
            .container { padding: 24px 16px 40px; }
            .app-name { font-size: 26px; }
            .download-card { padding: 24px 20px; }
            .download-btn { width: 100%; padding: 14px 24px; }
            .security-badges { grid-template-columns: 1fr; }
            .file-info { flex-direction: column; gap: 8px; }
        }
    </style>
</head>
<body>
    <div class="container">
        <!-- Header -->
        <div class="header">
            <img src="/tom-certo-logo-clean.png" alt="Tom Certo" class="logo">
            <h1 class="app-name">Tom Certo</h1>
            <p class="app-tagline">Detecção Inteligente de Tom Musical</p>
            <span class="version-badge">Versão 3.8.0 • Android</span>
        </div>
        
        <!-- Download Card -->
        <div class="download-card">
            <h2 class="download-title">Baixe o Aplicativo</h2>
            <p class="download-subtitle">Disponível para dispositivos Android 8.0 ou superior</p>
            <a href="/TomCerto.apk" class="download-btn" download>
                <svg viewBox="0 0 24 24" fill="currentColor">
                    <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>
                </svg>
                Baixar APK
            </a>
            <div class="file-info">
                <span>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M14,2H6A2,2 0 0,0 4,4V20A2,2 0 0,0 6,22H18A2,2 0 0,0 20,20V8L14,2M18,20H6V4H13V9H18V20Z"/>
                    </svg>
                    TomCerto.apk
                </span>
                <span>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M12,3A9,9 0 0,0 3,12A9,9 0 0,0 12,21A9,9 0 0,0 21,12A9,9 0 0,0 12,3M12,19A7,7 0 0,1 5,12A7,7 0 0,1 12,5A7,7 0 0,1 19,12A7,7 0 0,1 12,19Z"/>
                    </svg>
                    ~90 MB
                </span>
            </div>
        </div>
        
        <!-- Installation Steps -->
        <div class="section">
            <h3 class="section-title">
                <span class="section-title-icon">📲</span>
                Como Instalar
            </h3>
            <div class="steps">
                <div class="step">
                    <span class="step-number">1</span>
                    <div class="step-content">
                        <h4>Baixe o arquivo APK</h4>
                        <p>Clique no botão "Baixar APK" acima. O download começará automaticamente.</p>
                    </div>
                </div>
                <div class="step">
                    <span class="step-number">2</span>
                    <div class="step-content">
                        <h4>Permita a instalação</h4>
                        <p>Acesse <strong>Configurações → Segurança</strong> e ative "Fontes desconhecidas" ou "Instalar apps desconhecidos" para o navegador.</p>
                    </div>
                </div>
                <div class="step">
                    <span class="step-number">3</span>
                    <div class="step-content">
                        <h4>Instale o aplicativo</h4>
                        <p>Abra o arquivo baixado (geralmente na pasta Downloads) e toque em "Instalar".</p>
                    </div>
                </div>
                <div class="step">
                    <span class="step-number">4</span>
                    <div class="step-content">
                        <h4>Ative seu acesso</h4>
                        <p>Abra o app e insira o código de ativação que você recebeu por email após a compra.</p>
                    </div>
                </div>
            </div>
        </div>
        
        <!-- Security Section -->
        <div class="section">
            <h3 class="section-title">
                <span class="section-title-icon">🔒</span>
                Segurança Garantida
            </h3>
            <div class="security-badges">
                <div class="security-badge">
                    <span class="security-badge-icon">✓</span>
                    <div class="security-badge-text">
                        <strong>App Verificado</strong>
                        Código assinado digitalmente
                    </div>
                </div>
                <div class="security-badge">
                    <span class="security-badge-icon">🛡️</span>
                    <div class="security-badge-text">
                        <strong>Sem Vírus</strong>
                        Testado e aprovado
                    </div>
                </div>
                <div class="security-badge">
                    <span class="security-badge-icon">🔐</span>
                    <div class="security-badge-text">
                        <strong>Dados Protegidos</strong>
                        Conexão criptografada
                    </div>
                </div>
                <div class="security-badge">
                    <span class="security-badge-icon">📱</span>
                    <div class="security-badge-text">
                        <strong>Permissões Mínimas</strong>
                        Apenas microfone
                    </div>
                </div>
            </div>
        </div>
        
        <!-- Activation Info -->
        <div class="section">
            <h3 class="section-title">
                <span class="section-title-icon">🔑</span>
                Código de Ativação
            </h3>
            <div class="activation-box">
                <h4>Onde encontro meu código?</h4>
                <p>Após a confirmação do pagamento, você receberá um email com seu código de ativação único. Use esse código na primeira vez que abrir o app para liberar todas as funcionalidades.</p>
            </div>
        </div>
        
        <!-- FAQ -->
        <div class="section">
            <h3 class="section-title">
                <span class="section-title-icon">❓</span>
                Perguntas Frequentes
            </h3>
            <div class="faq-item">
                <p class="faq-question">O app funciona em iPhone/iOS?</p>
                <p class="faq-answer">No momento, o Tom Certo está disponível apenas para Android. A versão iOS está em desenvolvimento.</p>
            </div>
            <div class="faq-item">
                <p class="faq-question">É seguro instalar APK fora da Play Store?</p>
                <p class="faq-answer">Sim! Nosso APK é assinado digitalmente e verificado. A instalação fora da Play Store é comum para apps especializados e é totalmente segura quando feita de fontes confiáveis como nosso site oficial.</p>
            </div>
            <div class="faq-item">
                <p class="faq-question">Em quantos dispositivos posso usar?</p>
                <p class="faq-answer">Seu código de ativação permite usar o app em até 3 dispositivos simultaneamente.</p>
            </div>
            <div class="faq-item">
                <p class="faq-question">O app precisa de internet?</p>
                <p class="faq-answer">Sim, a detecção de tom utiliza nossa tecnologia de IA na nuvem para garantir máxima precisão. É necessária uma conexão estável para uso.</p>
            </div>
        </div>
        
        <!-- Footer -->
        <div class="footer">
            <p class="footer-text">
                Precisa de ajuda? Entre em contato pelo <a href="mailto:suporte@tomcerto.online">suporte@tomcerto.online</a>
            </p>
        </div>
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
