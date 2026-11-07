#!/usr/bin/env bash
# 构建 HomeLedger 手机客户端（APK）。
#
# 三端同构：桌面、手机、浏览器都是「完整的本地客户端」。
#
#   每台设备都自带一份 IndexedDB 数据库，断网照常增删改查、扫码、打标签。
#   联网是可选项：可以在设置里连一台服务器，用同步口令端到端加密后复制数据。
#   轻量索引字段（名称、位置、分类、条码）以明文存服务器供检索；
#   隐私字段与附件用设备上派生的密钥加密，服务器解不开。
#
# 所以 APK 和 deb 打包的是同一份前端产物，只是手机上没有 Python、不需要 sidecar，
# 也不需要填网关地址——第一次启动直接就是可用的本地库。
# 详见 docs/LOCAL_FIRST.md。
#
# 用法：
#   ./scripts/build-android.sh                  # arm64-v8a，绝大多数手机
#   ./scripts/build-android.sh --abi armv7      # 老设备
#   ./scripts/build-android.sh --all-abi        # 四种 ABI 各一个 APK
#   ./scripts/build-android.sh --debug          # 可调试版本
#
# 依赖（Ubuntu）：
#   JDK 17+、Android SDK、NDK 26.x
#   sdkmanager "platforms;android-36" "build-tools;36.0.0" "ndk;26.1.10909125"
#
# 环境变量：
#   ANDROID_HOME    Android SDK 根目录
#   NDK_HOME        具体 NDK 目录（不是 ndk/ 的父目录）
#   JAVA_HOME       JDK 17 及以上
#   GRADLE_MIRROR   设为 1 时把 Gradle 发行包指向国内镜像（仅本机构建期间生效）
#   ANDROID_KEYSTORE / ANDROID_KEYSTORE_PASSWORD / ANDROID_KEY_ALIAS
#                   设置后自动签名。都不设置时，如果
#                   ~/.homeledger-signing/android/homeledger-dev.p12 存在，
#                   会自动使用这把固定密钥；没有密钥才产出 *-unsigned.apk。
#   ANDROID_KEYSTORE_PASSWORD_FILE
#                   从文件读取签名密码（推荐），优先于 ANDROID_KEYSTORE_PASSWORD。
#                   密码不出现在环境变量和命令行里，适合固定密钥的日常构建。
#   HOMELEDGER_SIGNING_DIR
#                   覆盖固定密钥目录，默认 ~/.homeledger-signing/android

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ABI="aarch64"
ALL_ABI=0
BUNDLE_ARGS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --abi) ABI="$2"; shift 2 ;;
    --all-abi) ALL_ABI=1; shift ;;
    --debug) BUNDLE_ARGS+=("--debug"); shift ;;
    -h|--help) sed -n '2,26p' "$0"; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

say() { printf '\n\033[1;36m▸ %s\033[0m\n' "$1"; }
die() { printf '\033[1;31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

# 固定签名密钥。和 Windows 一样，签名材料放在用户目录而不是仓库或 dist，
# 这样清理构建产物、换机器目录时都不会换证书。没有显式指定密钥时自动使用它；
# 想换密钥再设置 ANDROID_KEYSTORE / ANDROID_KEYSTORE_PASSWORD_FILE 覆盖。
SIGNING_DIR="${HOMELEDGER_SIGNING_DIR:-$HOME/.homeledger-signing/android}"
if [ -z "${ANDROID_KEYSTORE:-}" ] && \
   [ -z "${ANDROID_KEYSTORE_PASSWORD:-}" ] && \
   [ -z "${ANDROID_KEYSTORE_PASSWORD_FILE:-}" ] && \
   [ -f "$SIGNING_DIR/homeledger-dev.p12" ]; then
  ANDROID_KEYSTORE="$SIGNING_DIR/homeledger-dev.p12"
  if [ -f "$SIGNING_DIR/password.txt" ]; then
    ANDROID_KEYSTORE_PASSWORD_FILE="$SIGNING_DIR/password.txt"
  fi
  export ANDROID_KEYSTORE ANDROID_KEYSTORE_PASSWORD_FILE
  echo "  使用固定签名密钥：$ANDROID_KEYSTORE"
fi

native_path() {
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -m "$1"
  else
    printf '%s\n' "$1"
  fi
}

# --- 前置检查 --------------------------------------------------------------
command -v node >/dev/null || die "未找到 node"
[ -n "${ANDROID_HOME:-}" ] || die "未设置 ANDROID_HOME。示例：export ANDROID_HOME=\$HOME/Android/Sdk"
[ -d "$ANDROID_HOME/ndk" ] || die "$ANDROID_HOME/ndk 不存在，请先装 NDK：sdkmanager \"ndk;26.1.10909125\""

if [ -z "${NDK_HOME:-}" ]; then
  NDK_HOME="$(find "$ANDROID_HOME/ndk" -maxdepth 1 -mindepth 1 -type d | sort -V | tail -1)"
  export NDK_HOME
  echo "  NDK_HOME 未设置，使用 $NDK_HOME"
fi

[ -n "${JAVA_HOME:-}" ] || die "未设置 JAVA_HOME（需要 JDK 17 及以上）"
JAVA_MAJOR="$("$JAVA_HOME/bin/java" -version 2>&1 | head -1 | sed -E 's/.*"([0-9]+).*/\1/')"
[ "${JAVA_MAJOR:-0}" -ge 17 ] || die "JDK 版本为 $JAVA_MAJOR，AGP 需要 17 及以上"

command -v rustup >/dev/null && rustup target list --installed | grep -q aarch64-linux-android || \
  echo "! 建议先执行：rustup target add aarch64-linux-android armv7-linux-androideabi x86_64-linux-android i686-linux-android"

[ -f "$ROOT/backend/app/static/index.html" ] || \
  echo "! 未找到前端产物（backend/app/static），先跑一次前端构建"

# --- Gradle 镜像（可选，退出时还原）----------------------------------------
WRAPPER="$ROOT/src-tauri/gen/android/gradle/wrapper/gradle-wrapper.properties"
RESTORE_WRAPPER=0
if [ "${GRADLE_MIRROR:-0}" = "1" ] && [ -f "$WRAPPER" ]; then
  say "切换 Gradle 发行包到国内镜像"
  cp "$WRAPPER" "$WRAPPER.bak"
  RESTORE_WRAPPER=1
  trap '[ "$RESTORE_WRAPPER" = "1" ] && mv "$WRAPPER.bak" "$WRAPPER"' EXIT
  # services.gradle.org 在国内经常只有几十 KB/s，装一次 150MB 的发行包能耗掉半小时。
  sed -i -E 's#https\\://services\.gradle\.org/distributions/#https\\://mirrors.cloud.tencent.com/gradle/#' "$WRAPPER"
  grep distributionUrl "$WRAPPER"
fi

# --- 初始化 Android 工程（只做一次）----------------------------------------
if [ ! -d "$ROOT/src-tauri/gen/android" ]; then
  say "生成 Android 工程"
  ( cd "$ROOT" && pnpm dlx @tauri-apps/cli@^2 android init --ci )
fi

# --- 构建 ------------------------------------------------------------------
say "编译 APK（$ABI）"
cd "$ROOT"
TARGET_ARGS=()
if [ "$ALL_ABI" -eq 0 ]; then
  TARGET_ARGS=(--target "$ABI")
else
  TARGET_ARGS=(--target aarch64 armv7 i686 x86_64 --split-per-abi)
fi

if [ -x "$ROOT/node_modules/.bin/tauri" ]; then
  CLI=("$ROOT/node_modules/.bin/tauri")
else
  CLI=(pnpm dlx @tauri-apps/cli@^2)
fi

# Tauri 会把 bundle.resources 复制进 Android 工程的 assets，但不会清理上一次
# 留下的文件。桌面构建会往 src-tauri/server/ 放一个 11MB 的 Linux sidecar；
# 如果先打了桌面包再打安卓包，它会以「资源」的身份原封不动混进 APK——
# 体积翻三倍，而且是个在手机上永远执行不了的 ELF。
# tauri.android.conf.json 已经把 resources 置空，这行是防止历史残留。
rm -rf "$ROOT/src-tauri/gen/android/app/src/main/assets/server"

# --- 原生补丁 --------------------------------------------------------------
# gen/android 是 `tauri android init` 生成的，重新生成会把人工改动冲掉。
# 与其在文档里写「记得改回来」，不如每次构建都校正一次——下面两件事都是
# 缺了就会让核心功能静默失效的那种：
#
#   1. 清单里要有 CAMERA。没有它，wry 弹不出系统权限对话框，
#      getUserMedia 直接 NotAllowedError，扫码入库整个功能不可用。
#   2. MainActivity 要开沉浸式全屏。没有它，内容会顶到状态栏底下。
say "校正 Android 原生配置"
python3 - "$ROOT/src-tauri/gen/android" <<'PYEOF'
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
manifest = root / "app/src/main/AndroidManifest.xml"
text = manifest.read_text(encoding="utf-8")
if "android.permission.CAMERA" not in text:
    text = text.replace(
        '<uses-permission android:name="android.permission.INTERNET" />',
        '<uses-permission android:name="android.permission.INTERNET" />\n'
        '    <uses-permission android:name="android.permission.CAMERA" />\n'
        '    <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />\n'
        '    <uses-feature android:name="android.hardware.camera" android:required="false" />',
    )
if "android.permission.READ_CALENDAR" not in text:
    text = text.replace(
        '<uses-permission android:name="android.permission.CAMERA" />',
        '<uses-permission android:name="android.permission.CAMERA" />' + '\n'
        + '    <uses-permission android:name="android.permission.READ_CALENDAR" />' + '\n'
        + '    <uses-permission android:name="android.permission.WRITE_CALENDAR" />',
    )
if "windowSoftInputMode" not in text:
    text = text.replace(
        'android:launchMode="singleTask"',
        'android:launchMode="singleTask"\n            android:windowSoftInputMode="adjustResize"',
    )
manifest.write_text(text, encoding="utf-8")

# 日历插件：权威源在 src-tauri/native/android/，gen 工程里这份是派生副本。
# 内容不一致就整体覆盖，改模板即生效，不用记住去改两处。
plugin = root / "app/src/main/java/app/homeledger/desktop/CalendarPlugin.kt"
template = root.parent.parent / "native/android/CalendarPlugin.kt"
if template.exists():
    want = template.read_text(encoding="utf-8")
    if not plugin.exists() or plugin.read_text(encoding="utf-8") != want:
        plugin.parent.mkdir(parents=True, exist_ok=True)
        plugin.write_text(want, encoding="utf-8")

# 分享/打印插件：同一套模板同步。
share = root / "app/src/main/java/app/homeledger/desktop/SharePlugin.kt"
share_template = root.parent.parent / "native/android/SharePlugin.kt"
if share_template.exists():
    want = share_template.read_text(encoding="utf-8")
    if not share.exists() or share.read_text(encoding="utf-8") != want:
        share.parent.mkdir(parents=True, exist_ok=True)
        share.write_text(want, encoding="utf-8")

# FileProvider 不用补：tauri android init 生成的清单自带
# androidx.core.content.FileProvider（authority = ${applicationId}.fileprovider），
# file_paths.xml 的 cache-path path="." 已覆盖插件写入的 cache/shared/。

activity = root / "app/src/main/java/app/homeledger/desktop/MainActivity.kt"
source = activity.read_text(encoding="utf-8")
if "WindowInsetsControllerCompat" not in source:
    activity.write_text(
        """package app.homeledger.desktop

import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.enableEdgeToEdge
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

// 拿在手里、对着货架用的应用：状态栏收起，内容画到屏幕边缘。
// 收不起来时（分屏、定制系统）布局退回 env(safe-area-inset-top)，
// 内容自动让开，而不是被压在时钟底下。
class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    immersive()
  }

  override fun onWindowFocusChanged(hasFocus: Boolean) {
    super.onWindowFocusChanged(hasFocus)
    if (hasFocus) immersive()
  }

  private fun immersive() {
    WindowCompat.setDecorFitsSystemWindows(window, false)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      window.attributes = window.attributes.apply {
        layoutInDisplayCutoutMode =
          WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
      }
    }
    val controller = WindowCompat.getInsetsController(window, window.decorView)
    controller.systemBarsBehavior =
      WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
    controller.hide(WindowInsetsCompat.Type.statusBars())
  }
}
""",
        encoding="utf-8",
    )
PYEOF

"${CLI[@]}" android build --apk --ci \
  "${TARGET_ARGS[@]}" "${BUNDLE_ARGS[@]+"${BUNDLE_ARGS[@]}"}"

# --- 签名 ------------------------------------------------------------------
# Gradle 出的 release APK 是 unsigned 的，装不上。这里用 apksigner 补签。
# 不配置密钥时只保留未签名产物，并明确告知——静默产出一个装不上的包更糟。
say "签名"
OUT="$ROOT/src-tauri/gen/android/app/build/outputs/apk"
BUILD_TOOLS="$(find "$ANDROID_HOME/build-tools" -maxdepth 1 -mindepth 1 -type d | sort -V | tail -1)"
# Windows 的 SDK 里这两个是 zipalign.exe / apksigner.bat；Linux 没有后缀。
ZIPALIGN="$BUILD_TOOLS/zipalign"
[ -x "$ZIPALIGN" ] || ZIPALIGN="$BUILD_TOOLS/zipalign.exe"
APKSIGNER="$BUILD_TOOLS/apksigner"
[ -x "$APKSIGNER" ] || APKSIGNER="$BUILD_TOOLS/apksigner.bat"
VERSION="$(node -p "require('$ROOT/src-tauri/tauri.conf.json').version")"

mkdir -p "$ROOT/dist"
while read -r apk; do
  [ -n "$apk" ] || continue
  # app-universal-release-unsigned.apk -> universal
  abi="$(basename "$apk" | sed -E 's/^app-(.*)-release-unsigned\.apk$/\1/')"
  # 没开 --split-per-abi 时 Gradle 把包放在 universal/ 下，但里面只有一种 ABI，
  # 用目录名命名会让人以为装了四种架构。单 ABI 时按真实目标命名。
  [ "$abi" = "universal" ] && [ "$ALL_ABI" -eq 0 ] && abi="$ABI"
  target="$ROOT/dist/HomeLedger_${VERSION}_${abi}.apk"

  if [ -n "${ANDROID_KEYSTORE:-}" ]; then
    [ -f "$ANDROID_KEYSTORE" ] || die "ANDROID_KEYSTORE 指向的文件不存在：$ANDROID_KEYSTORE"
    # 密码可以放在文件里（推荐，固定密钥日常构建用这个），也可以走环境变量。
    # 文件方式只给 --ks-pass 用：apksigner 不带 --key-pass 时会复用 keystore
    # 密码，避免同一份文件被当两行密码读而报 EOF。
    if [ -n "${ANDROID_KEYSTORE_PASSWORD_FILE:-}" ]; then
      [ -f "$ANDROID_KEYSTORE_PASSWORD_FILE" ] || \
        die "ANDROID_KEYSTORE_PASSWORD_FILE 指向的文件不存在：$ANDROID_KEYSTORE_PASSWORD_FILE"
      PASS_ARGS=(--ks-pass "file:$(native_path "$ANDROID_KEYSTORE_PASSWORD_FILE")")
    elif [ -n "${ANDROID_KEYSTORE_PASSWORD:-}" ]; then
      PASS_ARGS=(--ks-pass "env:ANDROID_KEYSTORE_PASSWORD" --key-pass "env:ANDROID_KEYSTORE_PASSWORD")
    else
      die "设置了 ANDROID_KEYSTORE 但没有 ANDROID_KEYSTORE_PASSWORD_FILE 或 ANDROID_KEYSTORE_PASSWORD"
    fi
    "$ZIPALIGN" -f -p 4 "$apk" /tmp/hl-aligned.apk
    "$APKSIGNER" sign \
      --ks "$(native_path "$ANDROID_KEYSTORE")" \
      --ks-key-alias "${ANDROID_KEY_ALIAS:-homeledger}" \
      "${PASS_ARGS[@]}" \
      --out "$target" /tmp/hl-aligned.apk
    "$APKSIGNER" verify --print-certs "$target" | head -1
  else
    target="${target%.apk}-unsigned.apk"
    cp "$apk" "$target"
  fi
  du -h "$target"
done < <(find "$OUT" -name '*-unsigned.apk' -type f)

say "完成"
if [ -z "${ANDROID_KEYSTORE:-}" ]; then
  cat <<'TIP'
  产物未签名，装不上。两种办法：
    1) 设 ANDROID_KEYSTORE / ANDROID_KEYSTORE_PASSWORD 后重跑本脚本
    2) 手动签：
       $ANDROID_HOME/build-tools/<ver>/apksigner sign \
         --ks your.jks --ks-key-alias homeledger --out out.apk in.apk
  调试用 --debug 出的包自带 debug 签名，可以直接装。
TIP
fi
