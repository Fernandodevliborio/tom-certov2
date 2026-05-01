"""Modelos Pydantic para o Tom Certo API"""
from pydantic import BaseModel, Field
from typing import Optional, List
from datetime import datetime
from enum import Enum


class PlanType(str, Enum):
    """
    Planos do Tom Certo:
    - ESSENCIAL: Detecção de tom + Campo harmônico (sem acordes em tempo real)
    - PROFISSIONAL: Acesso completo (inclui acordes em tempo real)
    """
    ESSENCIAL = "essencial"
    PROFISSIONAL = "profissional"
    # Planos legados (mantidos para compatibilidade)
    MENSAL = "mensal"           # Mapeado para ESSENCIAL
    TRIMESTRAL = "trimestral"   # Mapeado para PROFISSIONAL
    SEMESTRAL = "semestral"     # Mapeado para PROFISSIONAL


class TokenStatus(str, Enum):
    ATIVO = "ativo"
    EXPIRADO = "expirado"
    CANCELADO = "cancelado"


# Duração dos planos em dias
PLAN_DURATIONS = {
    PlanType.ESSENCIAL: 30,
    PlanType.PROFISSIONAL: 30,
    # Legados
    PlanType.MENSAL: 30,
    PlanType.TRIMESTRAL: 90,
    PlanType.SEMESTRAL: 180,
}

# Preços dos planos
PLAN_PRICES = {
    PlanType.ESSENCIAL: 9.90,
    PlanType.PROFISSIONAL: 19.90,
    # Legados
    PlanType.MENSAL: 9.90,
    PlanType.TRIMESTRAL: 19.90,
    PlanType.SEMESTRAL: 39.90,
}

# Funcionalidades por plano
PLAN_FEATURES = {
    PlanType.ESSENCIAL: {
        "key_detection": True,      # Detecção de tom
        "harmonic_field": True,     # Campo harmônico
        "real_time_chord": False,   # 🔒 Acorde em tempo real
        "smart_chords": False,      # 🔒 Acordes inteligentes
    },
    PlanType.PROFISSIONAL: {
        "key_detection": True,
        "harmonic_field": True,
        "real_time_chord": True,    # ✅ Desbloqueado
        "smart_chords": True,       # ✅ Desbloqueado
    },
}


def normalize_plan(plano: str) -> str:
    """
    Normaliza planos legados para os novos nomes.
    mensal → essencial
    trimestral/semestral → profissional
    """
    plano_lower = plano.lower().strip() if plano else "essencial"
    if plano_lower in ("mensal", "essencial"):
        return "essencial"
    if plano_lower in ("trimestral", "semestral", "profissional"):
        return "profissional"
    return "essencial"


def get_plan_features(plano: str) -> dict:
    """Retorna as funcionalidades disponíveis para um plano."""
    normalized = normalize_plan(plano)
    try:
        plan_enum = PlanType(normalized)
    except ValueError:
        plan_enum = PlanType.ESSENCIAL
    return PLAN_FEATURES.get(plan_enum, PLAN_FEATURES[PlanType.ESSENCIAL])


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
    features: Optional[dict] = None  # Funcionalidades do plano
