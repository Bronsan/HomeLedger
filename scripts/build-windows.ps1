# 一条命令出 Windows 安装包（EXE + 免安装 zip）。
#
# 为什么单独写一个而不是复用 build-desktop.ps1：那个脚本假设机器上装了 pnpm，
# 而实际出包的人往往只有 npm。这里固定出 NSIS 的 setup.exe，并顺手把免安装版
# 也打出来——测试时不想装就直接解压跑。
#
#   .\scripts\build-windows.ps1                # 全量
#   .\scripts\build-windows.ps1 -SkipFrontend  # 只改了后端
#   .\scripts\build-windows.ps1 -SkipSidecar   # 只改了前端
#
# 产物落在 dist\：
#   HomeLedger_<ver>_x64-setup.exe
#   HomeLedger-<ver>-win-x64-portable.zip

param(
    [switch]$SkipFrontend,
    [switch]$SkipSidecar,
    [switch]$SkipBundle
)

# 这里是 Continue 而不是 Stop：PS 5.1 会把原生命令写到 stderr 的任何一行都当成
# 终止性错误（NativeCommandError），而 vite 会往 stderr 打"dynamically imported
# but also statically imported"这类无害警告——用 Stop 的话构建会在正常输出之后
# 突然中断。所以统一靠 $LASTEXITCODE 判断成败。
$ErrorActionPreference = "Continue"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

function Say($msg) { Write-Host "`n> $msg" -ForegroundColor Cyan }
function Die($msg) { Write-Host "x $msg" -ForegroundColor Red; exit 1 }

$Version = (Get-Content "$Root\package.json" -Raw -Encoding UTF8 | ConvertFrom-Json).version
Write-Host "HomeLedger $Version" -ForegroundColor Green

# --- 1. 前端 ---------------------------------------------------------------
if (-not $SkipFrontend) {
    Say "构建前端"
    if (-not (Test-Path "$Root\frontend\node_modules")) {
        Say "安装前端依赖（npm）"
        Push-Location "$Root\frontend"
        & npm install --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { Die "npm install 失败" }
        # 仓库用 pnpm-lock.yaml，别让 npm 生成的锁文件混进去
        Remove-Item "$Root\frontend\package-lock.json" -ErrorAction SilentlyContinue
        Pop-Location
    }
    Push-Location "$Root\frontend"
    & npx tsc --noEmit
    if ($LASTEXITCODE -ne 0) { Die "类型检查失败" }
    & npx vite build
    if ($LASTEXITCODE -ne 0) { Die "前端构建失败" }
    Pop-Location
} else {
    Say "跳过前端构建"
}

if (-not (Test-Path "$Root\backend\app\static\index.html")) {
    Die "backend\app\static\index.html 不存在，桌面版没有界面可加载"
}

# --- 2. 后端 sidecar -------------------------------------------------------
if (-not $SkipSidecar) {
    Say "打包后端（PyInstaller）"
    $py = "$Root\backend\.venv\Scripts\python.exe"
    if (-not (Test-Path $py)) { $py = "python" }

    & $py -c "import PyInstaller" 2>$null
    if ($LASTEXITCODE -ne 0) {
        Say "安装 pyinstaller"
        & $py -m pip install --quiet --upgrade pyinstaller
    }

    # PyInstaller --noconfirm 会自己删旧目录；先删掉，免得它的删除逻辑
    # 在某些安全软件下卡住，报错还指向别处。
    Remove-Item "$Root\backend\dist\homeledger-server" -Recurse -Force -ErrorAction SilentlyContinue
    Push-Location "$Root\backend"
    & $py -m PyInstaller --noconfirm homeledger-server.spec
    if ($LASTEXITCODE -ne 0) { Die "PyInstaller 打包失败" }
    Pop-Location

    Say "复制 sidecar 到 src-tauri\server"
    Remove-Item "$Root\src-tauri\server\homeledger-server" -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force -Path "$Root\src-tauri\server" | Out-Null
    Copy-Item "$Root\backend\dist\homeledger-server" -Destination "$Root\src-tauri\server\" -Recurse -Force
} else {
    Say "跳过 sidecar 打包"
}

if (-not (Test-Path "$Root\src-tauri\server\homeledger-server\homeledger-server.exe")) {
    Die "src-tauri\server 里没有 sidecar，安装包装出来会缺后端"
}

# --- 3. Tauri --------------------------------------------------------------
if (-not $SkipBundle) {
    Say "编译桌面应用"
    if (-not (Test-Path "$Root\node_modules\.bin\tauri.cmd")) {
        Say "安装 Tauri CLI"
        & npm install --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { Die "npm install 失败" }
        Remove-Item "$Root\package-lock.json" -ErrorAction SilentlyContinue
    }
    # 先只编译、不打包，方便后面单独取主程序做免安装版。
    # 注意不要在这里签主程序：`tauri bundle` 会在打包前往 exe 里写 NSIS
    # 安装类型标记，签完再改会让签名变成 HashMismatch。安装包里的主程序
    # 保持未签名，外层 setup.exe 单独签；portable 里的 exe 在复制后另签。
    # 2>&1 + ForEach-Object：tauri 会往 stderr 打进度行，不接管的话每次都会
    # 冒出一段红色的 NativeCommandError，看起来像构建失败了。
    & "$Root\node_modules\.bin\tauri.cmd" build --no-bundle 2>&1 | ForEach-Object { Write-Host $_ }
    if ($LASTEXITCODE -ne 0) { Die "Tauri 编译失败" }

    $signScript = "$Root\scripts\sign-windows.ps1"
    if (-not (Test-Path $signScript)) { Die "找不到签名脚本：$signScript" }

    # cargo 在源码没变时会复用上次构建的 exe，里面的签名也还在。NSIS 打包
    # 前会改这个文件写安装类型，签名就会变 HashMismatch，所以先清掉旧签名。
    Say "清理主程序旧签名"
    & powershell.exe -NoProfile -File $signScript -File "$Root\src-tauri\target\release\homeledger-desktop.exe" -RemoveSignature
    if ($LASTEXITCODE -ne 0) { Die "清理主程序旧签名失败" }

    Say "打包 NSIS 安装器"
    # 固定出 NSIS。安装器语言、安装范围和界面在 tauri.conf.json 的
    # bundle.windows.nsis 里配置：简体中文、当前用户安装、无管理员弹窗。
    & "$Root\node_modules\.bin\tauri.cmd" bundle --bundles nsis 2>&1 | ForEach-Object { Write-Host $_ }
    if ($LASTEXITCODE -ne 0) {
        Die "Tauri NSIS 打包失败。检查 %LOCALAPPDATA%\tauri\NSIS 工具链是否完整，或网络能否下载 NSIS。"
    }
}

# --- 4. 免安装版 -----------------------------------------------------------
Say "组装免安装版"
$portable = "$Root\build\portable\HomeLedger"
Remove-Item "$Root\build\portable" -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $portable | Out-Null
Copy-Item "$Root\src-tauri\target\release\homeledger-desktop.exe" -Destination $portable -Force
Copy-Item "$Root\src-tauri\server" -Destination $portable -Recurse -Force

# portable 里的主程序是用户直接双击的，单独签一次。
if (-not $signScript) {
    $signScript = "$Root\scripts\sign-windows.ps1"
    if (-not (Test-Path $signScript)) { Die "找不到签名脚本：$signScript" }
}
Say "签名免安装版主程序"
& powershell.exe -NoProfile -File $signScript -File "$portable\homeledger-desktop.exe"
if ($LASTEXITCODE -ne 0) { Die "免安装版主程序签名失败" }

New-Item -ItemType Directory -Force -Path "$Root\dist" | Out-Null
$zip = "$Root\dist\HomeLedger-$Version-win-x64-portable.zip"
Remove-Item $zip -Force -ErrorAction SilentlyContinue
# 用系统的 bsdtar 而不是 Compress-Archive：后者（.NET Framework 实现）写进 zip 的
# 条目用反斜杠做分隔符，Windows 资源管理器能吃，但 Linux/macOS 的 unzip 会报
# "appears to use backslashes as path separators"，7-Zip 之外的解压器可能直接把
# 整个目录压成一层。bsdtar 写的是标准的前斜杠。
& "$env:SystemRoot\System32\tar.exe" -a -c -f $zip -C "$Root\build\portable" "HomeLedger"
if ($LASTEXITCODE -ne 0) { Die "打包免安装版失败" }

$setup = Get-ChildItem "$Root\src-tauri\target\release\bundle\nsis\*.exe" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $setup) { Die "没有找到 NSIS 安装包（bundle\nsis\*.exe）" }
Copy-Item $setup.FullName -Destination "$Root\dist\" -Force

# 安装包签名固定用 %USERPROFILE%\.homeledger-signing\windows 里的同一张证书。
# 证书材料缺失时这里会失败，而不是悄悄产出一个未签名包。
$signScript = "$Root\scripts\sign-windows.ps1"
if (-not (Test-Path $signScript)) { Die "找不到签名脚本：$signScript" }
Say "签名安装包"
& powershell.exe -NoProfile -File $signScript -File "$Root\dist\$($setup.Name)"
if ($LASTEXITCODE -ne 0) { Die "安装包签名失败" }

Say "完成"
@(
    (Get-Item "$Root\dist\$($setup.Name)"),
    (Get-Item $zip)
) | ForEach-Object { "{0,-52} {1,6:N1} MB" -f $_.Name, ($_.Length / 1MB) }
