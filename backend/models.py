"""Modelos Pydantic para o Tom Certo API"""
from pydantic import BaseModel, Field
from typing import Optional, List
from datetime import datetime
from enum import Enum


class PlanType(str, Enum):
    MENSAL = "mensal"
    TRIMESTRAL = "trimestral"
    SEMESTRAL = "semestral"


class TokenStatus(str, Enum):
    ATIVO = "ativo"
    EXPIRADO = "expirado"
    CANCELADO = "cancelado"


# Duração dos planos em dias
PLAN_DURATIONS = {
    PlanType.MENSAL: 30,
    PlanType.TRIMESTRAL: 90,
    PlanType.SEMESTRAL: 180,
}

# Preços dos planos
PLAN_PRICES = {
    PlanType.MENSAL: 9.90,
    PlanType.TRIMESTRAL: 19.90,
    PlanType.SEMESTRAL: 39.90,
}


class TokenDocument(BaseModel):
    """Documento do token no MongoDB"""
    token: str
    nome_usuario: Optional[str] = None
    email_compra: Optional[str] = None
    plano: PlanType
    status: TokenStatus = TokenStatus.ATIVO
    created_at: datetime
    expires_at: datetime
    first_used_at: Optional[datetime] = None
    device_id: Optional[str] = None
    max_devices: int = 1
    
    # Campos extras para compatibilidade com sistema antigo
    active: bool = True
    active_devices: List[str] = []
    customer_name: Optional[str] = None  # alias para nome_usuario
    notes: Optional[str] = None


class WebhookCaktoPayload(BaseModel):
    """Payload do webhook da Cakto"""
    event: str  # pagamento_aprovado, pagamento_cancelado, reembolso, chargeback
    transaction_id: Optional[str] = None
    customer_name: Optional[str] = None
    customer_email: Optional[str] = None
    product_id: Optional[str] = None
    product_name: Optional[str] = None
    plan: Optional[str] = None  # mensal, trimestral, semestral
    amount: Optional[float] = None
    currency: Optional[str] = "BRL"
    created_at: Optional[str] = None
    
    # Campos extras que podem vir
    metadata: Optional[dict] = None


class ValidateTokenRequest(BaseModel):
    """Request para validar token"""
    token: str
    device_id: str


class ValidateTokenResponse(BaseModel):
    """Response da validação de token"""
    valid: bool
    reason: Optional[str] = None
    session: Optional[str] = None
    customer_name: Optional[str] = None
    plano: Optional[str] = None
    expires_at: Optional[str] = None
    days_remaining: Optional[int] = None
