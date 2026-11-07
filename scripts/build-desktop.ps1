# HomeLedger 桌面安装包构建（Windows）。
#
# 在 Windows 上跑这个脚本，产出 dist\HomeLedger_<version>_x64-setup.exe。
#
# 为什么需要它：PyInstaller 不做交叉编译。它把**当前这台机器**的 Python 解释器
# 和当前平台的二进制轮子打进产物里，所以 Linux 上跑出来的 sidecar 在 Windows
# 上是一堆无法执行的 ELF 文件。要在 Windows 上出包，就必须在 Windows 上打包。
# （同理，.dmg 只能在 macOS 上出。）
#
# 用法：
#   .\scripts\build-desktop.ps1                  # 完整构建
#   .\scripts\build-desktop.ps1 -SkipSidecar     # 只改了前端，复用上次的 sidecar
#   .\scripts\build-desktop.ps1 -Debug           # 带调试符号
#
# 依赖：Node 20+ / pnpm、Python 3.11+、Rust（MSVC 工具链）、WebView2 Runtime。

[CmdletBinding()]
param(
    [switch]$SkipFrontend,
    [switch]$SkipSidecar,
    # 不能叫 $Debug：[CmdletBinding()] 会注入同名公共参数，绑定阶段直接报
    # ParameterNameAlreadyExistsForCommand，脚本一行都跑不了。
    [switch]$DebugSymbols
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

function Say($msg) { Write-Host "`n> $msg" -ForegroundColor Cyan }
function Die($msg) { Write-Host "x $msg" -ForegroundColor Red; exit 1 }

# --- 0. 前置检查 ----------------------------------------------------------
Say "检查工具链"
foreach ($tool in @("node", "pnpm", "cargo", "python")) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        Die "未找到 $tool。$tool 的安装说明见 docs/DESKTOP.md"
    }
}

# 静态链接的 Python（官方 embeddable 包、部分 conda 环境）没有 python3.dll，
# PyInstaller 会以「failed to locate a library」这类误导性信息失败。提前说清楚。
$shared = python -c "import sysconfig; print(sysconfig.get_config_var('Py_ENABLE_SHARED') or 0)"
if ($shared -ne "1") {
    Write-Host "! 当前 Python 未启用共享库，PyInstaller 可能失败。" -ForegroundColor Yellow
    Write-Host "  如遇问题，改用 python.org 的官方安装包（勾选 'Install for all users'）。" -ForegroundColor Yellow
}

# --- 1. 前端 ---------------------------------------------------------------
if (-not $SkipFrontend) {
    Say "构建前端"
    Push-Location "$Root\frontend"
    try {
        pnpm install --frozen-lockfile
        if ($LASTEXITCODE -ne 0) { Die "pnpm install 失败" }
        pnpm build
        if ($LASTEXITCODE -ne 0) { Die "前端构建失败" }
    } finally { Pop-Location }
} else {
    Say "跳过前端构建"
}

if (-not (Test-Path "$Root\backend\app\static\index.html")) {
    Die "backend\app\static\index.html 不存在。先跑一次前端构建。"
}

# --- 2. 后端 sidecar -------------------------------------------------------
if (-not $SkipSidecar) {
    Say "打包后端（PyInstaller）"
    # 必须用后端 venv 的解释器：系统 Python 版本杂（3.10/3.14 并存），而
    # backend 的 __pycache__ 是 venv 版本编译的——解释器扫到别的版本的
    # .pyc 会直接 IndexError（dis 反汇编字节码对不上）。venv 内自洽。
    $py = Join-Path $Root "backend\.venv\Scripts\python.exe"
    if (-not (Test-Path $py)) { $py = "python" }
    & $py -c "import PyInstaller" 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  安装 pyinstaller…"
        & $py -m pip install --quiet --upgrade pyinstaller
    }
    Push-Location "$Root\backend"
    try {
        & $py -m PyInstaller --clean --noconfirm homeledger-server.spec
        if ($LASTEXITCODE -ne 0) { Die "PyInstaller 打包失败" }
    } finally { Pop-Location }

    Say "复制 sidecar 到 src-tauri\server"
    $dst = "$Root\src-tauri\server\homeledger-server"
    if (Test-Path $dst) { Remove-Item $dst -Recurse -Force }
    New-Item -ItemType Directory -Force -Path "$Root\src-tauri\server" | Out-Null
    Copy-Item "$Root\backend\dist\homeledger-server" -Destination "$Root\src-tauri\server\" -Recurse
    "{0:N0} MB" -f ((Get-ChildItem $dst -Recurse | Measure-Object -Property Length -Sum).Sum / 1MB) |
        ForEach-Object { Write-Host "  sidecar: $_" }
} else {
    Say "跳过 sidecar 打包"
}

# --- 3. Tauri --------------------------------------------------------------
Say "打包桌面应用"
Push-Location $Root
try {
    # 本地装了 CLI 就用本地的：`pnpm dlx` 每次都要去 registry 确认版本，断网
    # 或者 registry 慢的时候，明明 node_modules 里已经有二进制了还要等一轮。
    if (Test-Path "$Root\node_modules\.bin\tauri.cmd") {
        $tauri = "$Root\node_modules\.bin\tauri.cmd"
        $tauriArgs = @("build")
    } else {
        $tauri = "pnpm"
        $tauriArgs = @("dlx", "@tauri-apps/cli@^2", "build")
    }

    # NSIS 先来，失败再退到 MSI。
    #
    # 这不是"多打一种格式"，是这台机器上的现实：Tauri 的 NSIS bundler 会去
    # GitHub Releases 下 nsis-3.13.zip，国内网络经常在 TLS 握手上被掐断
    # （`peer closed connection without sending TLS close_notify`）。而 WiX
    # 一旦下载过一次就缓存在 %LOCALAPPDATA%\tauri\WixTools314，之后完全离线可用。
    # 换句话说：编译早就成功了，卡住的只是一个打包器。
    $nsisArgs = $tauriArgs + @("--bundles", "nsis")
    if ($DebugSymbols) { $nsisArgs += "--debug" }
    & $tauri @nsisArgs
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  ! NSIS 打包失败（多为工具链下载不通），改用 MSI" -ForegroundColor Yellow
        $msiArgs = $tauriArgs + @("--bundles", "msi")
        if ($DebugSymbols) { $msiArgs += "--debug" }
        & $tauri $msiArgs
        if ($LASTEXITCODE -ne 0) { Die "Tauri 打包失败（NSIS 与 MSI 都没出包）" }
    }
} finally { Pop-Location }

Say "完成"
# 两个目录都收：上一次成功留下的产物不该因为这次换了格式就消失。
New-Item -ItemType Directory -Force -Path "$Root\dist" | Out-Null
foreach ($kind in @(@("nsis", "*.exe"), @("msi", "*.msi"))) {
    $out = "$Root\src-tauri\target\release\bundle\$($kind[0])"
    if (-not (Test-Path $out)) { continue }
    Get-ChildItem $out -Filter $kind[1] | ForEach-Object {
        "{0}  {1:N1} MB" -f $_.Name, ($_.Length / 1MB)
        Copy-Item $_.FullName -Destination "$Root\dist\" -Force
    }
}
Write-Host "  已复制到 dist\" -ForegroundColor Green
