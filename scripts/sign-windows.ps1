# 用固定的 HomeLedger Windows 代码签名证书签署一个 PE 文件。
#
# 证书由 scripts/setup-windows-signing.ps1 创建，放在
# %USERPROFILE%\.homeledger-signing\windows\。不要重新生成证书。
#
# 用法：
#   .\scripts\sign-windows.ps1 -File dist\HomeLedger_2.0.0_x64-setup.exe

param(
    [Parameter(Mandatory = $true)]
    [string]$File,
    # 移除已有签名。Tauri 打 NSIS 包前会往主程序里写安装类型标记；
    # 如果上次构建留下的签名还在，改完就会变成 HashMismatch。
    [switch]$RemoveSignature
)

$ErrorActionPreference = "Stop"

$dir = Join-Path $env:USERPROFILE ".homeledger-signing\windows"
$pfx = Join-Path $dir "homeledger-codesign.pfx"
$cer = Join-Path $dir "homeledger-codesign.cer"
$pwFile = Join-Path $dir "password.txt"
$thumbFile = Join-Path $dir "thumbprint.txt"

foreach ($p in @($pfx, $pwFile, $thumbFile)) {
    if (-not (Test-Path $p)) {
        throw "签名材料不完整：$p。先运行 scripts/setup-windows-signing.ps1"
    }
}

$thumb = (Get-Content -Raw $thumbFile).Trim()
$cert = Get-ChildItem Cert:\CurrentUser\My |
    Where-Object { $_.Thumbprint -eq $thumb -and $_.HasPrivateKey } |
    Select-Object -First 1

if (-not $cert) {
    $password = (Get-Content -Raw $pwFile).Trim()
    $secure = ConvertTo-SecureString $password -AsPlainText -Force
    Import-PfxCertificate -FilePath $pfx -CertStoreLocation Cert:\CurrentUser\My -Password $secure | Out-Null
    $cert = Get-ChildItem Cert:\CurrentUser\My |
        Where-Object { $_.Thumbprint -eq $thumb -and $_.HasPrivateKey } |
        Select-Object -First 1
    if (-not $cert) { throw "PFX 已导入，但在 CurrentUser\My 里找不到证书 $thumb" }
}

$signtool = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin" `
    -Filter signtool.exe -Recurse -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match "\\x64\\signtool\.exe$" } |
    Sort-Object FullName -Descending |
    Select-Object -First 1

if (-not $signtool) {
    $cmd = Get-Command signtool.exe -ErrorAction SilentlyContinue
    if ($cmd) { $signtool = Get-Item $cmd.Source }
}
if (-not $signtool) { throw "找不到 signtool.exe（需要 Windows SDK）" }

$target = (Resolve-Path $File).Path

if ($RemoveSignature) {
    $existing = Get-AuthenticodeSignature $target
    if (-not $existing.SignerCertificate) {
        Write-Host "主程序没有旧签名，无需清理" -ForegroundColor Cyan
        exit 0
    }
    & $signtool.FullName remove /s $target
    if ($LASTEXITCODE -ne 0) { throw "移除旧签名失败" }
    Write-Host "已移除主程序旧签名" -ForegroundColor Cyan
    exit 0
}

Write-Host "签署 $target" -ForegroundColor Cyan
Write-Host "证书 $thumb"

& $signtool.FullName sign /sha1 $thumb /fd SHA256 `
    /tr "http://timestamp.digicert.com" /td SHA256 $target

if ($LASTEXITCODE -ne 0) {
    Write-Warning "时间戳服务不可用，改为不带时间戳签名"
    & $signtool.FullName sign /sha1 $thumb /fd SHA256 $target
}

if ($LASTEXITCODE -ne 0) { throw "signtool 签名失败" }

& $signtool.FullName verify /pa /v $target | Select-Object -Last 8
$verifyExit = $LASTEXITCODE
if ($verifyExit -ne 0) {
    # 自签名证书没有受信任的根，/pa 校验会以“根证书不受信任”失败；
    # 这不是签名没写进去。只要文件上有这张证书的签名就继续。
    $sig = Get-AuthenticodeSignature $target
    if (-not $sig.SignerCertificate -or $sig.SignerCertificate.Thumbprint -ne $thumb) {
        throw "签名验证失败：文件上的签名证书不是 $thumb"
    }
    Write-Warning "签名已写入，但本机不信任自签名根证书（$($sig.Status)）。要让 Windows 默认信任，需要受信任的代码签名证书，或手动信任 homeledger-codesign.cer。"
}
