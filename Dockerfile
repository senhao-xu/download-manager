# Multi-stage build: frontend bundle, then a runtime image with all system deps.

# ---- Stage 1: build the React frontend ----
FROM node:20-slim AS frontend
WORKDIR /fe
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ---- Stage 2: runtime ----
FROM python:3.11-slim

# System deps: ffmpeg/ffprobe (A/V merge), ca-certificates. Node.js >= 22 is
# installed via NodeSource because Debian's apt nodejs (v20) is "unsupported" by
# yt-dlp-ejs 0.8.0 for YouTube's JS challenge - node 22 is required.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Python deps (stable versions), then a pinned yt-dlp nightly.
# Pinning the exact nightly (instead of `--pre -U`) gives reproducible builds and
# avoids the flaky "latest pre-release" index scan. Bump this when YouTube breaks.
ARG YTDLP_VERSION=2026.8.4.234419.dev0
COPY backend/requirements.txt ./backend/requirements.txt
ENV PIP_DISABLE_PIP_VERSION_CHECK=1 PIP_DEFAULT_TIMEOUT=120
# Single pip session: stable deps + the pinned yt-dlp nightly (explicit == allows
# the pre-release without a global --pre that would pull beta deps).
RUN pip install --no-cache-dir --retries 10 --timeout 120 \
        -r backend/requirements.txt "yt-dlp==${YTDLP_VERSION}"

# Application code + built frontend (mirrors dev layout: /app/backend, /app/frontend).
COPY backend/ ./backend/
COPY --from=frontend /fe/dist ./frontend/dist

WORKDIR /app/backend

ENV PORT=8000 \
    DATA_DIR=/data \
    DOWNLOAD_DIR=/data/downloads \
    PYTHONUNBUFFERED=1

RUN mkdir -p /data/downloads
EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
