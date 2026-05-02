"""
admin_push.py — Envia push notifications para o dev/admin quando eventos
importantes acontecem (novo feedback de "tom errado", crashes, etc).

Usa a API pública gratuita do Expo Push: https://exp.host/--/api/v2/push/send
Não requer SDK nem API key; apenas o Expo Push Token do dispositivo admin.

Persistência:
  - Collection MongoDB: admin_push_tokens
  - Documento: { token: str, device_id: str, label: str, created_at: datetime, active: bool }

Fluxo de registro:
  POST /api/admin/push-token  (header: X-Admin-Key)
    body: { token: "ExponentPushToken[xxx]", device_id: "...", label: "Fernando iPhone" }
  → insere/atualiza documento com active=True

Fluxo de notificação:
  notify_admins(db, title, body, data)
  → dispara uma chamada HTTP para cada token ativo em admin_push_tokens
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import httpx

logger = logging.getLogger(__name__)

EXPO_PUSH_ENDPOINT = "https://exp.host/--/api/v2/push/send"
COLLECTION_NAME = "admin_push_tokens"

# Timeout curto para não segurar a resposta do endpoint de feedback
PUSH_TIMEOUT_SECONDS = 5.0


def is_valid_expo_token(token: str) -> bool:
    """Valida formato do Expo Push Token."""
    if not token or not isinstance(token, str):
        return False
    return token.startswith("ExponentPushToken[") and token.endswith("]")


async def upsert_admin_token(
    db,
    token: str,
    device_id: str,
    label: Optional[str] = None,
) -> Dict[str, Any]:
    """Cadastra (ou reativa) um token admin."""
    if not is_valid_expo_token(token):
        raise ValueError(f"Expo push token inválido: {token[:40]}")
    
    now = datetime.now(timezone.utc)
    await db[COLLECTION_NAME].update_one(
        {"token": token},
        {
            "$set": {
                "token": token,
                "device_id": device_id,
                "label": label or "",
                "updated_at": now,
                "active": True,
            },
            "$setOnInsert": {"created_at": now},
        },
        upsert=True,
    )
    count = await db[COLLECTION_NAME].count_documents({"active": True})
    return {"ok": True, "active_tokens": count}


async def list_admin_tokens(db) -> List[Dict[str, Any]]:
    cursor = db[COLLECTION_NAME].find({"active": True}, {"_id": 0})
    out = []
    async for doc in cursor:
        out.append(doc)
    return out


async def deactivate_token(db, token: str) -> bool:
    r = await db[COLLECTION_NAME].update_one(
        {"token": token}, {"$set": {"active": False}}
    )
    return r.modified_count > 0


async def _send_to_expo(messages: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Envia batch para o Expo Push API."""
    try:
        async with httpx.AsyncClient(timeout=PUSH_TIMEOUT_SECONDS) as client:
            resp = await client.post(
                EXPO_PUSH_ENDPOINT,
                json=messages,
                headers={
                    "accept": "application/json",
                    "accept-encoding": "gzip, deflate",
                    "content-type": "application/json",
                },
            )
            return {"status": resp.status_code, "body": resp.json()}
    except Exception as exc:
        logger.warning(f"[push] erro enviando ao Expo: {exc}")
        return {"status": 0, "error": str(exc)}


async def notify_admins(
    db,
    title: str,
    body: str,
    data: Optional[Dict[str, Any]] = None,
    priority: str = "high",
) -> Dict[str, Any]:
    """
    Dispara push notification para TODOS os admin tokens ativos.
    Seguro contra falhas: loga e continua mesmo se um token falhar.
    """
    tokens_docs = await list_admin_tokens(db)
    if not tokens_docs:
        logger.info("[push] nenhum admin token ativo — pulando notificação")
        return {"sent": 0, "reason": "no_active_tokens"}
    
    messages = [
        {
            "to": t["token"],
            "title": title,
            "body": body,
            "sound": "default",
            "priority": priority,
            "data": data or {},
        }
        for t in tokens_docs
    ]
    result = await _send_to_expo(messages)
    logger.info(
        f"[push] notificação enviada a {len(messages)} token(s): "
        f"status={result.get('status')}"
    )
    return {"sent": len(messages), "expo_response": result}


def notify_admins_fire_and_forget(db, title: str, body: str, data: Optional[Dict[str, Any]] = None):
    """Variante sync que agenda o envio em background sem bloquear o caller."""
    try:
        loop = asyncio.get_event_loop()
        loop.create_task(notify_admins(db, title, body, data))
    except Exception as exc:
        logger.warning(f"[push] falha ao agendar notify_admins: {exc}")


def format_feedback_notification(feedback_doc: Dict[str, Any]) -> Dict[str, str]:
    """Formata título e corpo para uma notificação de feedback de tom errado."""
    detected = feedback_doc.get("detected", {}).get("key_name", "?")
    correct = feedback_doc.get("correct", {}).get("key_name", "?")
    err = feedback_doc.get("error_classification", {})
    err_type = err.get("type", "?")
    diff = err.get("diff_semitones", "?")
    conf = feedback_doc.get("detected", {}).get("confidence", 0.0)
    try:
        conf_str = f"{float(conf) * 100:.0f}%"
    except Exception:
        conf_str = "?"
    
    title = f"Tom errado reportado: {correct}"
    body = (
        f"App detectou {detected} (conf {conf_str}) | tipo: {err_type} | diff: {diff} semi"
    )
    return {"title": title, "body": body}
