#!/usr/bin/env bash
# 本地开发：同时起后端（8000，热重载）与前端（5173，HMR）
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ ! -d "${ROOT}/.venv" ]; then
  python3 -m venv "${ROOT}/.venv"
  "${ROOT}/.venv/bin/pip" install -q -r "${ROOT}/backend/requirements.txt"
fi

echo "→ 后端 http://127.0.0.1:8000  (API 文档 /api/docs)"
(cd "${ROOT}/backend" && HOMELEDGER_DATA_DIR="${ROOT}/backend/data" \
  "${ROOT}/.venv/bin/uvicorn" app.main:app --reload --port 8000) &
BACK_PID=$!

echo "→ 前端 http://127.0.0.1:5173"
(cd "${ROOT}/frontend" && [ -d node_modules ] || pnpm install; pnpm dev) &
FRONT_PID=$!

trap 'kill ${BACK_PID} ${FRONT_PID} 2>/dev/null' EXIT INT TERM
wait
