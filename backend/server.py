from fastapi import FastAPI, APIRouter, Request, HTTPException, Depends
from fastapi.responses import JSONResponse, HTMLResponse
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import os
import logging
import uuid
import jwt
import bcrypt
from datetime import datetime, timedelta, timezone
from pathlib import Path
from pydantic import BaseModel, Field
from typing import List, Optional, Any
from bson import ObjectId

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

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
    code: str
    customer_name: Optional[str] = None
    device_limit: int = 3
    duration_minutes: Optional[int] = None
    notes: Optional[str] = None

class TokenUpdate(BaseModel):
    active: Optional[bool] = None
    customer_name: Optional[str] = None
    device_limit: Optional[int] = None
    notes: Optional[str] = None

# ─── Admin Key ──────────────────────────────────────────────────────────
ADMIN_KEY = os.environ.get('ADMIN_KEY', 'tomcerto-admin-2026')

def verify_admin(request: Request):
    key = request.headers.get('X-Admin-Key') or request.query_params.get('admin_key')
    if key != ADMIN_KEY:
        raise HTTPException(401, "Admin key inválida")

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

# ─── Analyze Key (CREPE + TonicAnchor v2) ──────────────────────────────
@api_router.post("/analyze-key")
async def analyze_key(request: Request):
    """
    Recebe bytes de áudio (WAV 16kHz mono) e retorna tonalidade detectada.
    Pipeline: CREPE → notas MIDI → frases → Krumhansl + TonicAnchor + guard
    """
    audio_bytes = await request.body()
    logger.info(f"[AnalyzeKey] recebeu {len(audio_bytes)} bytes")
    # 1000 bytes = ~30ms. Agora aceita clips menores (1.5s mínimo = 48000 bytes)
    if not audio_bytes or len(audio_bytes) < 500:
        logger.warning(f"[AnalyzeKey] REJEITADO: áudio vazio ({len(audio_bytes)} bytes)")
        return JSONResponse({
            "success": False,
            "error": "audio_too_short",
            "message": "Áudio muito curto ou vazio."
        }, status_code=400)

    try:
        from key_detection import analyze_audio_bytes
        result = analyze_audio_bytes(audio_bytes)
        if result.get('success'):
            # Top 5 PCs por histograma e por gravity
            hist = result.get('histogram', [])
            grav = result.get('gravity', [])
            note_names = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B']
            if hist and len(hist) == 12:
                hist_sorted = sorted(range(12), key=lambda i: hist[i], reverse=True)
                hist_str = ' '.join(f"{note_names[i]}={hist[i]:.2f}" for i in hist_sorted[:5])
            else:
                hist_str = 'n/a'
            if grav and len(grav) == 12:
                grav_sorted = sorted(range(12), key=lambda i: grav[i], reverse=True)
                grav_str = ' '.join(f"{note_names[i]}={grav[i]:.2f}" for i in grav_sorted[:5])
            else:
                grav_str = 'n/a'
            tops = result.get('top_candidates', [])[:3]
            tops_str = ' | '.join(f"{t['key']}({t['score']:.3f})" for t in tops)
            logger.info(
                f"[AnalyzeKey] ✓ key={result.get('key_name', '?')} "
                f"conf={result.get('confidence', 0):.2f} "
                f"notes={result.get('notes_count', '?')} "
                f"phrases={result.get('phrases_count', '?')} "
                f"duration={result.get('duration_s', '?')}s "
                f"flags={result.get('flags', [])}"
            )
            logger.info(f"[AnalyzeKey]   hist top5: {hist_str}")
            logger.info(f"[AnalyzeKey]   grav top5: {grav_str}")
            logger.info(f"[AnalyzeKey]   top3 keys: {tops_str}")
        else:
            logger.warning(
                f"[AnalyzeKey] ✗ error={result.get('error', '?')} "
                f"duration={result.get('duration_s', '?')}s "
                f"f0_valid={result.get('valid_f0_frames', '?')}"
            )
        return JSONResponse(result)
    except Exception as e:
        logger.error(f"[AnalyzeKey] Erro: {e}", exc_info=True)
        return JSONResponse({
            "success": False,
            "error": "internal_error",
            "message": str(e),
        }, status_code=500)

# ─── Admin: Criar Token (sem auth — proteger em produção) ──────────────
@api_router.post("/admin/tokens")
async def create_token(body: TokenCreate):
    code = body.code.strip().upper()
    if not code:
        raise HTTPException(400, "code is required")
    exists = await db.tokens.find_one({"code": code})
    if exists:
        raise HTTPException(409, "Token already exists")
    doc = {
        "code": code,
        "customer_name": body.customer_name,
        "device_limit": body.device_limit,
        "active_devices": [],
        "active": True,
        "created_at": datetime.now(timezone.utc),
        "expires_at": None,
        "duration_minutes": body.duration_minutes,
        "notes": body.notes,
    }
    if body.duration_minutes:
        doc["expires_at"] = datetime.now(timezone.utc) + timedelta(minutes=body.duration_minutes)

    result = await db.tokens.insert_one(doc)
    doc["_id"] = str(result.inserted_id)
    return JSONResponse({"ok": True, "token_id": str(result.inserted_id), "code": code})

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

@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()
    logger.info("MongoDB client fechado.")
