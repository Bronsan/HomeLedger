#!/usr/bin/env bash
# 以开发模式启动桌面端。
#
#   ./scripts/dev-desktop.sh          # 壳 + 内置 sidecar（用后端源码）
#   ./scripts/dev-desktop.sh --vite   # 壳 + Vite 热更新（调 UI 时用这个）
#
# --vite 会额外拉起 uvicorn(8000) 与 vite(5173)，窗口直接加载 5173，
# 改前端代码即时生效，不用反复 pnpm build。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="sidecar"
[ "${1:-}" = "--vite" ] && MODE="vite"

say() { printf '\n\033[1;36m▸ %s\033[0m\n' "$1"; }
die() { printf '\033[1;31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

command -v cargo >/dev/null || die "未找到 cargo，请先安装 Rust：https://rustup.rs"

PYTHON="${HOMELEDGER_PYTHON:-}"
if [ -z "$PYTHON" ]; then
  if [ -x "$ROOT/backend/.venv/bin/python" ]; then
    PYTHON="$ROOT/backend/.venv/bin/python"
  elif [ -x "$ROOT/backend/.venv/Scripts/python.exe" ]; then
    PYTHON="$ROOT/backend/.venv/Scripts/python.exe"
  else
    PYTHON="$(command -v python3 || command -v python)"
  fi
fi
[ -n "$PYTHON" ] || die "找不到 Python 解释器"
"$PYTHON" -c "import fastapi" 2>/dev/null || \
  die "$PYTHON 缺少后端依赖，先执行：$PYTHON -m pip install -r backend/requirements.txt"

export HOMELEDGER_BACKEND_DIR="$ROOT/backend"
export HOMELEDGER_PYTHON="$PYTHON"

PIDS=()
cleanup() {
  for pid in "${PIDS[@]:-}"; do
    [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  done
}
trap cleanup EXIT INT TERM

if [ "$MODE" = "vite" ]; then
  say "启动后端（8000）"
  ( cd "$ROOT/backend" && exec "$PYTHON" -m uvicorn app.main:app --host 127.0.0.1 --port 8000 ) \
    > /tmp/homeledger-dev-api.log 2>&1 &
  PIDS+=("$!")

  say "启动 Vite（5173）"
  command -v pnpm >/dev/null || die "未找到 pnpm"
  ( cd "$ROOT/frontend" && exec pnpm dev ) > /tmp/homeledger-dev-vite.log 2>&1 &
  PIDS+=("$!")

  # 等两个服务都起来，免得窗口先打开一个空白错误页。
  for _ in $(seq 1 40); do
    if curl -sf -o /dev/null http://127.0.0.1:5173/ && \
       curl -sf -o /dev/null http://127.0.0.1:8000/api/v1/system/health; then
      break
    fi
    sleep 0.5
  done

  export HOMELEDGER_DESKTOP_DEV_URL="http://127.0.0.1:5173"
  say "启动桌面壳（加载 Vite，改代码即时生效）"
else
  # 窗口加载的是后端托管的静态文件，没有产物就是一片 404。
  if [ ! -f "$ROOT/backend/app/static/index.html" ]; then
    say "前端产物缺失，先构建"
    ( cd "$ROOT/frontend" && pnpm install --frozen-lockfile && pnpm build )
  fi
  say "启动桌面端（内置 sidecar，后端：$PYTHON）"
fi

cd "$ROOT/src-tauri"
cargo run
