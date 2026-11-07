# 一次性创建 HomeLedger 的 Windows 代码签名证书。
#
# 证书和私钥放在用户目录，不放进仓库、也不随 dist 清理：
#   %USERPROFILE%\.homeledger-signing\windows\
#
# 以后固定复用同一张证书，不要重新生成，否则已发布的安装包会变成另一个发布者。
# 这是自签名证书，Windows 默认不信任它；要消除 SmartScreen 的“未知发布者”，
# 需要购买受信任的代码签名证书，或在本机手动信任 homeledger-codesign.cer。

$ErrorActionPreference = "Stop"

$dir = Join-Path $env:USERPROFILE ".homeledger-signing\windows"
$pfx = Join-Path $dir "homeledger-codesign.pfx"
$cer = Join-Path $dir "homeledger-codesign.cer"
$pwFile = Join-Path $dir "password.txt"
$thumbFile = Join-Path $dir "thumbprint.txt"
$friendly = "HomeLedger Code Signing"

New-Item -ItemType Directory -Force -Path $dir | Out-Null

$cert = Get-ChildItem Cert:\CurrentUser\My |
    Where-Object { $_.FriendlyName -eq $friendly -and $_.HasPrivateKey } |
    Select-Object -First 1

if (-not $cert) {
    $cert = New-SelfSignedCertificate `
        -Type CodeSigningCert `
        -Subject "CN=HomeLedger, O=HomeLedger, C=CN" `
        -FriendlyName $friendly `
        -KeyUsage DigitalSignature `
        -KeySpec Signature `
        -KeyExportPolicy Exportable `
        -KeyLength 3072 `
        -HashAlgorithm SHA256 `
        -NotAfter (Get-Date).AddYears(10) `
        -CertStoreLocation Cert:\CurrentUser\My
}

if (-not (Test-Path $pwFile)) {
    $bytes = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $password = [Convert]::ToBase64String($bytes).Replace("/", "_").Replace("+", "-").TrimEnd("=")
    Set-Content -Path $pwFile -Value $password -Encoding ASCII -NoNewline
} else {
    $password = (Get-Content -Raw $pwFile).Trim()
}

$secure = ConvertTo-SecureString $password -AsPlainText -Force
if (-not (Test-Path $pfx)) {
    Export-PfxCertificate -Cert $cert -FilePath $pfx -Password $secure | Out-Null
}
if (Test-Path $cer) { Remove-Item $cer -Force }
Export-Certificate -Cert $cert -FilePath $cer | Out-Null
Set-Content -Path $thumbFile -Value $cert.Thumbprint -Encoding ASCII -NoNewline

"Thumbprint: $($cert.Thumbprint)"
"PFX:        $pfx"
"CER:        $cer"
