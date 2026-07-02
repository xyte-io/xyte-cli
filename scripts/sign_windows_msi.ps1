param(
  [Parameter(Mandatory = $true)]
  [string]$MsiPath,

  [string]$CertificateBase64 = $env:WINDOWS_CODESIGN_PFX_BASE64,
  [string]$CertificatePassword = $env:WINDOWS_CODESIGN_PFX_PASSWORD,
  [string]$TimestampUrl = "https://timestamp.digicert.com"
)

$ErrorActionPreference = "Stop"

if (!(Test-Path $MsiPath)) {
  throw "MSI not found: $MsiPath"
}

if ([string]::IsNullOrWhiteSpace($CertificateBase64)) {
  throw "WINDOWS_CODESIGN_PFX_BASE64 is required to sign the MSI."
}

$signtool = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin" -Recurse -Filter signtool.exe -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -match "\\x64\\signtool\.exe$" } |
  Sort-Object FullName -Descending |
  Select-Object -First 1

if (!$signtool) {
  throw "signtool.exe was not found. Install the Windows SDK on the signing runner."
}

$pfxPath = Join-Path $env:RUNNER_TEMP "xyte-cli-codesign.pfx"
[IO.File]::WriteAllBytes($pfxPath, [Convert]::FromBase64String($CertificateBase64))

try {
  $args = @(
    "sign",
    "/fd", "SHA256",
    "/tr", $TimestampUrl,
    "/td", "SHA256",
    "/f", $pfxPath
  )
  if (![string]::IsNullOrWhiteSpace($CertificatePassword)) {
    $args += @("/p", $CertificatePassword)
  }
  $args += $MsiPath

  & $signtool.FullName @args
  if ($LASTEXITCODE -ne 0) {
    throw "signtool failed with exit code $LASTEXITCODE"
  }
} finally {
  Remove-Item -LiteralPath $pfxPath -Force -ErrorAction SilentlyContinue
}
