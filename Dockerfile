# Tom Certo Backend — Dockerfile para Railway
# Baseado em python:3.11-slim (Debian) — ambiente padrão, todas libs C disponíveis.

FROM python:3.11-slim

# Variáveis de ambiente
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# Dependências de sistema (audio + ML)
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    g++ \
    ffmpeg \
    libsndfile1 \
    libffi-dev \
    libssl-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Instala deps Python primeiro (para cache de layer)
COPY backend/requirements.txt /app/backend/requirements.txt
RUN pip install --upgrade pip && \
    pip install --no-cache-dir -r /app/backend/requirements.txt

# Copia o resto do código
COPY . /app

WORKDIR /app/backend

# Railway define $PORT automaticamente
CMD uvicorn server:app --host 0.0.0.0 --port ${PORT:-8001} --workers 1 --timeout-keep-alive 75
