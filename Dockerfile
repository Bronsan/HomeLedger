# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# HomeLedger — one image, three deployment modes.
#   build:  docker build -t homeledger .
#   run:    docker run -p 8000:8000 -v hl-data:/data homeledger
# ---------------------------------------------------------------------------

# ---------- stage 1: build the web client ----------
FROM node:20-alpine AS web
WORKDIR /web
COPY frontend/package.json frontend/pnpm-lock.yaml* ./
# Pin the package manager: `corepack enable` alone picks whatever pnpm version
# is current that day, which makes the same commit build differently over time.
RUN corepack enable && corepack prepare pnpm@10.28.2 --activate
# The lockfile already pins exact versions and integrity hashes, so nothing is
# resolved dynamically here. pnpm's minimumReleaseAge gate (which rejects
# packages published within the last day) would otherwise make the image
# unbuildable right after any dependency refresh.
RUN pnpm install --frozen-lockfile --config.minimumReleaseAge=0
COPY frontend/ ./
# The repo config writes into ../backend/app/static for local dev; in the
# container we emit a plain dist/ and copy it in the next stage.
RUN pnpm exec tsc --noEmit && pnpm exec vite build --outDir dist --emptyOutDir

# ---------- stage 2: runtime ----------
FROM python:3.12-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HOMELEDGER_DATA_DIR=/data

WORKDIR /app

# Debian's default mirror is often slow from mainland China (~30KB/s), which
# turns a 30-second step into a 10-minute one. Override at build time:
#   docker build --build-arg APT_MIRROR=https://mirrors.tuna.tsinghua.edu.cn .
ARG APT_MIRROR=
RUN if [ -n "${APT_MIRROR}" ]; then \
      sed -i "s|http://deb.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list.d/debian.sources; \
    fi \
 && apt-get update \
 && apt-get install -y --no-install-recommends fonts-wqy-microhei tzdata curl \
 && rm -rf /var/lib/apt/lists/* \
 && ls -l /usr/share/fonts/truetype/wqy/

COPY backend/requirements.txt ./requirements.txt
# Same idea for PyPI. Large wheels (sqlalchemy ~5MB) routinely stall on the
# default index from mainland China:
#   docker build --build-arg PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple .
ARG PIP_INDEX_URL=https://pypi.org/simple
RUN pip install --no-cache-dir --index-url "${PIP_INDEX_URL}" -r requirements.txt

COPY backend/app ./app
COPY --from=web /web/dist ./app/static

# Non-root runtime user; /data must stay writable.
RUN useradd --system --uid 10001 --create-home homeledger \
 && mkdir -p /data/uploads /data/backups \
 && chown -R homeledger:homeledger /data /app
USER homeledger

VOLUME ["/data"]
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8000/api/v1/system/health || exit 1

# A single worker keeps the in-process scheduler correct. For multi-replica
# cloud deployments set HOMELEDGER_ENABLE_SCHEDULER=false and scale workers.
# --no-access-log: uvicorn's default access log includes the client IP, which
# this product deliberately does not retain. Errors are still logged.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--no-proxy-headers", "--no-access-log"]
