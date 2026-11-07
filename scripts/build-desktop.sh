#!/usr/bin/env bash
# 构建 HomeLedger 桌面安装包。
#
# 三步：前端产物 → PyInstaller 单目录后端 → Tauri 打包。
# 每一步都可单独跳过，方便只改了一层时快速出包。
#
#   ./scripts/build-desktop.sh                 # 完整构建（deb + rpm）
#   ./scripts/build-desktop.sh --skip-sidecar  # 只改了前端
#   ./scripts/build-desktop.sh --debug         # 不压缩、带调试符号
#   ./scripts/build-desktop.sh --bundles deb,rpm,appimage
#
# 依赖：node + pnpm、python3 + pip、rust(cargo)、以及各平台的 Tauri 系统依赖。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKIP_FRONTEND=0
SKIP_SIDECAR=0
BUNDLE_ARGS=()
# deb + rpm by default. AppImage is excluded on purpose: producing one requires
# downloading the AppRun stub from GitHub, which takes minutes to time out on a
# blocked or slow network — and the failure lands *after* the useful bundles are
# already written, so it reads like the build failed when it did not.
BUNDLES="${BUNDLES:-deb,rpm}"

for arg in "$@"; do
  case "$arg" in
    --skip-frontend) SKIP_FRONTEND=1 ;;
    --skip-sidecar)  SKIP_SIDECAR=1 ;;
    --debug)         BUNDLE_ARGS+=("--debug") ;;
    --bundles)       BUNDLES="${2:-deb,rpm}"; shift ;;
    --bundles=*)     BUNDLES="${arg#*=}" ;;
    -h|--help)       sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "未知参数：$arg" >&2; exit 2 ;;
  esac
done

say() { printf '\n\033[1;36m▸ %s\033[0m\n' "$1"; }
die() { printf '\033[1;31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

PYTHON="${PYTHON:-python3}"
command -v cargo >/dev/null || die "未找到 cargo，请先安装 Rust：https://rustup.rs"

# --- 1. 前端 ---------------------------------------------------------------
if [ "$SKIP_FRONTEND" -eq 0 ]; then
  say "构建前端"
  command -v pnpm >/dev/null || die "未找到 pnpm，请先安装：npm i -g pnpm"
  ( cd "$ROOT/frontend" && pnpm install --frozen-lockfile && pnpm build )
else
  say "跳过前端构建"
fi

[ -f "$ROOT/backend/app/static/index.html" ] || \
  die "backend/app/static/index.html 不存在，桌面版没有界面可加载。先跑一次前端构建。"

# --- 2. 后端 sidecar -------------------------------------------------------
if [ "$SKIP_SIDECAR" -eq 0 ]; then
  say "打包后端（PyInstaller）"
  # PyInstaller embeds libpython. A statically built interpreter (pyenv's
  # default, among others) has no shared library to embed and fails with a
  # message that reads like a PyInstaller bug. Check first and say what to do.
  if [ "$("$PYTHON" -c 'import sysconfig;print(sysconfig.get_config_var("Py_ENABLE_SHARED") or 0)')" != "1" ]; then
    die "当前解释器（$("$PYTHON" -c 'import sys;print(sys.executable)')）未启用共享库，PyInstaller 无法使用。
  改用系统 Python：PYTHON=/usr/bin/python3 ./scripts/build-desktop.sh
  或重新编译 Python 时加 --enable-shared。"
  fi
  "$PYTHON" -c "import PyInstaller" 2>/dev/null || {
    echo "  安装 pyinstaller…"
    "$PYTHON" -m pip install --quiet --upgrade pyinstaller
  }
  ( cd "$ROOT/backend" && "$PYTHON" -m PyInstaller --clean --noconfirm homeledger-server.spec )

  say "复制 sidecar 到 src-tauri/server"
  rm -rf "$ROOT/src-tauri/server/homeledger-server"
  mkdir -p "$ROOT/src-tauri/server"
  cp -R "$ROOT/backend/dist/homeledger-server" "$ROOT/src-tauri/server/"
  du -sh "$ROOT/src-tauri/server/homeledger-server"
else
  say "跳过 sidecar 打包"
fi

# --- 3. Tauri --------------------------------------------------------------
say "打包桌面应用"
cd "$ROOT"
# 本地装了 CLI 就用本地的（快、版本可锁）；没有就临时拉一个。
# 不把 CLI 塞进 frontend/package.json：桌面构建是一次性动作，不该让每个只跑
# Web 开发的人也下载一套 Rust 侧工具链。
if [ -x "$ROOT/node_modules/.bin/tauri" ]; then
  TAURI_CMD=("$ROOT/node_modules/.bin/tauri")
else
  TAURI_CMD=(pnpm dlx @tauri-apps/cli@^2)
fi

# The bundle list is explicit (see BUNDLES above) rather than `all`, so a slow
# AppImage download cannot turn a successful build into a failed one.
set +e
"${TAURI_CMD[@]}" build --bundles "$BUNDLES" "${BUNDLE_ARGS[@]+"${BUNDLE_ARGS[@]}"}"
TAURI_EXIT=$?
set -e

BUNDLE_DIR="$ROOT/src-tauri/target/release/bundle"
PRODUCED=$(find "$BUNDLE_DIR" -maxdepth 2 -type f \
  \( -name '*.deb' -o -name '*.AppImage' -o -name '*.rpm' \
     -o -name '*.dmg' -o -name '*.msi' -o -name 'setup.exe' \) 2>/dev/null)

if [ -z "$PRODUCED" ]; then
  die "Tauri 打包失败（退出码 $TAURI_EXIT），且没有产出任何安装包"
fi

if [ "$TAURI_EXIT" -ne 0 ]; then
  printf '\033[1;33m! Tauri 退出码 %s，但已经产出安装包。常见原因：某个格式需要联网下载\n' "$TAURI_EXIT"
  printf '  脚手架（AppImage 的 AppRun、Windows 的 NSIS 插件）而当前网络不可达。\033[0m\n'
fi

say "完成"
echo "$PRODUCED" | while read -r f; do du -h "$f"; done
