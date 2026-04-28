"""Serviço de gerenciamento de tokens"""
import secrets
import string
import logging
from datetime import datetime, timedelta, timezone
from typing import Optional, Tuple
from motor.motor_asyncio import AsyncIOMotorDatabase

from models import PlanType, TokenStatus, PLAN_DURATIONS, TokenDocument

logger = logging.getLogger(__name__)


def generate_token(length: int = 8) -> str:
    """
    Gera um token único de acesso.
    Formato: XXXX-XXXX (letras maiúsculas e números, sem caracteres ambíguos)
    """
    # Remove caracteres ambíguos (0, O, I, L, 1)
    chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
    part1 = ''.join(secrets.choice(chars) for _ in range(4))
    part2 = ''.join(secrets.choice(chars) for _ in range(4))
    return f"{part1}-{part2}"


async def create_token(
    db: AsyncIOMotorDatabase,
    plano: PlanType,
    nome_usuario: Optional[str] = None,
    email_compra: Optional[str] = None,
    transaction_id: Optional[str] = None,
) -> Tuple[str, datetime]:
    """
    Cria um novo token no banco de dados.
    
    Args:
        db: Conexão com o MongoDB
        plano: Tipo do plano (mensal, trimestral, semestral)
        nome_usuario: Nome do comprador
        email_compra: Email do comprador
        transaction_id: ID da transação de pagamento
    
    Returns:
        Tuple com (token, expires_at)
    
    Raises:
        ValueError: Se já existe token para essa transaction_id
    """
    # PROTEÇÃO CONTRA DUPLICIDADE: Verifica se já existe token para essa transação
    if transaction_id:
        existing = await db.tokens.find_one({"transaction_id": transaction_id})
        if existing:
            logger.warning(f"[Token] ⚠ Duplicidade detectada: transaction_id={transaction_id}")
            # Retorna o token existente ao invés de criar novo
            return existing["token"], existing["expires_at"]
    
    # Gera token único
    token = generate_token()
    
    # Verifica se já existe (muito improvável, mas por segurança)
    while await db.tokens.find_one({"token": token}):
        token = generate_token()
    
    # Calcula data de expiração
    now = datetime.now(timezone.utc)
    duration_days = PLAN_DURATIONS.get(plano, 30)
    expires_at = now + timedelta(days=duration_days)
    
    # Documento do token
    doc = {
        "token": token,
        "code": token,  # Compatibilidade com sistema antigo
        "nome_usuario": nome_usuario,
        "customer_name": nome_usuario,  # Compatibilidade
        "email_compra": email_compra,
        "plano": plano.value,
        "status": TokenStatus.ATIVO.value,
        "created_at": now,
        "expires_at": expires_at,
        "first_used_at": None,
        "device_id": None,
        "max_devices": 1,
        "device_limit": 1,  # Compatibilidade
        "active": True,
        "active_devices": [],
        "transaction_id": transaction_id,
        "origin": "cakto",  # Origem da compra
        "notes": f"Compra via Cakto - {plano.value}",
    }
    
    await db.tokens.insert_one(doc)
    logger.info(f"[Token] ✓ Criado: {token[:4]}*** plano={plano.value} expires={expires_at.isoformat()} transaction_id={transaction_id}")
    
    return token, expires_at


async def cancel_token(
    db: AsyncIOMotorDatabase,
    token: Optional[str] = None,
    email: Optional[str] = None,
    transaction_id: Optional[str] = None,
    reason: str = "cancelado"
) -> bool:
    """
    Cancela um token (por reembolso, chargeback, etc).
    Pode buscar por token, email ou transaction_id.
    """
    query = {}
    if token:
        query["token"] = token.upper()
    elif email:
        query["email_compra"] = email
    elif transaction_id:
        query["transaction_id"] = transaction_id
    else:
        return False
    
    result = await db.tokens.update_many(
        query,
        {
            "$set": {
                "status": TokenStatus.CANCELADO.value,
                "active": False,
                "cancelled_at": datetime.now(timezone.utc),
                "cancel_reason": reason,
            }
        }
    )
    
    if result.modified_count > 0:
        logger.info(f"[Token] ✓ Cancelado: query={query} reason={reason}")
        return True
    
    logger.warning(f"[Token] ✗ Não encontrado para cancelar: query={query}")
    return False


async def validate_token(
    db: AsyncIOMotorDatabase,
    token: str,
    device_id: str
) -> dict:
    """
    Valida um token e vincula ao dispositivo se válido.
    
    Returns:
        dict com {valid, reason, ...}
    """
    token = token.strip().upper()
    device_id = device_id.strip()
    
    if not token or not device_id:
        return {"valid": False, "reason": "invalid_request"}
    
    # Busca por token ou code (compatibilidade)
    token_doc = await db.tokens.find_one({
        "$or": [
            {"token": token},
            {"code": token}
        ]
    })
    
    if not token_doc:
        return {"valid": False, "reason": "not_found"}
    
    # Verifica status
    status = token_doc.get("status", "ativo")
    if status == TokenStatus.CANCELADO.value:
        return {"valid": False, "reason": "cancelled"}
    
    if not token_doc.get("active", True):
        return {"valid": False, "reason": "revoked"}
    
    # Verifica expiração
    expires_at = token_doc.get("expires_at")
    now = datetime.now(timezone.utc)
    
    if expires_at:
        if isinstance(expires_at, datetime):
            exp_dt = expires_at.replace(tzinfo=timezone.utc) if expires_at.tzinfo is None else expires_at
        else:
            try:
                exp_dt = datetime.fromisoformat(str(expires_at).replace('Z', '+00:00'))
            except:
                exp_dt = now + timedelta(days=365)  # fallback
        
        if now > exp_dt:
            # Atualiza status para expirado
            await db.tokens.update_one(
                {"_id": token_doc["_id"]},
                {"$set": {"status": TokenStatus.EXPIRADO.value}}
            )
            return {"valid": False, "reason": "expired"}
    
    # Verifica dispositivo
    active_devices = token_doc.get("active_devices", [])
    max_devices = token_doc.get("max_devices", 1) or token_doc.get("device_limit", 1)
    
    if device_id not in active_devices:
        if len(active_devices) >= max_devices:
            return {"valid": False, "reason": "device_limit"}
        
        # Vincula dispositivo
        active_devices.append(device_id)
        update_data = {
            "active_devices": active_devices,
            "device_id": device_id,
            "last_used_at": now,
        }
        
        # Marca primeiro uso
        if not token_doc.get("first_used_at"):
            update_data["first_used_at"] = now
        
        await db.tokens.update_one(
            {"_id": token_doc["_id"]},
            {"$set": update_data}
        )
    
    # Calcula dias restantes
    days_remaining = None
    if expires_at:
        if isinstance(expires_at, datetime):
            exp_dt = expires_at.replace(tzinfo=timezone.utc) if expires_at.tzinfo is None else expires_at
            days_remaining = max(0, (exp_dt - now).days)
    
    return {
        "valid": True,
        "token_id": str(token_doc["_id"]),
        "customer_name": token_doc.get("nome_usuario") or token_doc.get("customer_name"),
        "plano": token_doc.get("plano"),
        "expires_at": expires_at.isoformat() if isinstance(expires_at, datetime) else expires_at,
        "days_remaining": days_remaining,
    }


async def expire_old_tokens(db: AsyncIOMotorDatabase) -> int:
    """
    Job para expirar tokens antigos.
    Deve ser chamado periodicamente (ex: a cada hora).
    
    Returns:
        Número de tokens expirados
    """
    now = datetime.now(timezone.utc)
    
    result = await db.tokens.update_many(
        {
            "status": TokenStatus.ATIVO.value,
            "expires_at": {"$lt": now}
        },
        {
            "$set": {
                "status": TokenStatus.EXPIRADO.value,
                "active": False,
            }
        }
    )
    
    if result.modified_count > 0:
        logger.info(f"[Token] ✓ Expirados automaticamente: {result.modified_count} tokens")
    
    return result.modified_count
