param(
  [string]$Tenant,
  [string]$KeyFile,
  [switch]$AssumeYes,
  [switch]$SkipApiKeySetup,
  [switch]$SkipNpmMigration,
  [switch]$NonInteractive
)

$ErrorActionPreference = "Stop"

function Write-Step {
  param([string]$Message)
  Write-Host ""
  Write-Host "== $Message =="
}

function Invoke-XyteCli {
  param(
    [string[]]$Arguments,
    [switch]$AllowFailure
  )
  & $script:XyteCli @Arguments
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0 -and !$AllowFailure) {
    throw "xyte-cli $($Arguments -join ' ') failed with exit code $exitCode."
  }
  if ($AllowFailure) {
    return $exitCode
  }
}

function Test-Yes {
  param([string]$Question)
  if ($AssumeYes) {
    return $true
  }
  if ($NonInteractive) {
    return $false
  }
  $answer = Read-Host "$Question [y/N]"
  return @("y", "yes") -contains $answer.Trim().ToLowerInvariant()
}

$script:InstallRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$script:XyteCli = Join-Path $script:InstallRoot "xyte-cli.cmd"

if (!(Test-Path $script:XyteCli)) {
  throw "Could not find installed xyte-cli at $script:XyteCli"
}

Write-Step "Verify installed Xyte CLI"
Invoke-XyteCli @("--version")
Invoke-XyteCli @("doctor", "environment", "--format", "text")

Write-Step "Check command precedence"
$commands = @(Get-Command "xyte-cli" -All -ErrorAction SilentlyContinue) + @(Get-Command "xyte-cli.cmd" -All -ErrorAction SilentlyContinue)
$uniqueCommands = $commands | Sort-Object -Property Definition -Unique
if ($uniqueCommands.Count -eq 0) {
  Write-Host "No xyte-cli command is visible on PATH yet. Open a new PowerShell window after install."
} else {
  foreach ($command in $uniqueCommands) {
    Write-Host "PATH candidate: $($command.Definition)"
  }
}

if (!$SkipNpmMigration) {
  Write-Step "Check previous npm global install"
  $npm = Get-Command "npm.cmd" -ErrorAction SilentlyContinue
  if ($npm) {
    $npmPath = $npm.Definition
    $npmListOutput = & $npmPath list -g @xyteai/cli --depth=0 2>$null
    $hasNpmGlobal = $LASTEXITCODE -eq 0 -and (($npmListOutput -join "`n") -match "@xyteai/cli@")
    if ($hasNpmGlobal) {
      Write-Host "Found previous global npm install of @xyteai/cli."
      Write-Host "The MSI install keeps config and API keys under the same user profile locations."
      if (Test-Yes "Remove the global npm copy so the Windows installer is the only update channel?") {
        & $npmPath uninstall -g @xyteai/cli
        if ($LASTEXITCODE -ne 0) {
          throw "npm uninstall -g @xyteai/cli failed."
        }
      } else {
        Write-Host "Leaving npm global install in place. If PATH picks npm first, run: npm uninstall -g @xyteai/cli"
      }
    } else {
      Write-Host "No previous global npm install was detected."
    }
  } else {
    Write-Host "npm is not available; skipping npm migration check."
  }
}

if (!$SkipApiKeySetup) {
  Write-Step "Connect API key"
  if ($KeyFile) {
    if (!$Tenant) {
      throw "-Tenant is required when -KeyFile is provided."
    }
    Invoke-XyteCli @("setup", "run", "--non-interactive", "--tenant", $Tenant, "--key-file", $KeyFile, "--output", "json")
  } elseif (!$NonInteractive) {
    Write-Host "Interactive setup will store the API key using Windows secure storage when available."
    if (Test-Yes "Run xyte-cli setup now?") {
      if ($Tenant) {
        Invoke-XyteCli @("setup", "run", "--tenant", $Tenant)
      } else {
        Invoke-XyteCli @("setup", "run")
      }
    }
  } else {
    Write-Host "No -KeyFile was supplied, and -NonInteractive is set. Skipping API key setup."
  }
}

Write-Step "Readiness"
$readinessExitCode = Invoke-XyteCli -Arguments @("setup", "status", "--field", "tenantId") -AllowFailure
if ($readinessExitCode -ne 0) {
  Write-Host "No connected tenant was confirmed. Run this assistant again or run: xyte-cli setup run"
}
Write-Host ""
if ($readinessExitCode -eq 0) {
  Write-Host "Xyte CLI Windows setup is complete."
} else {
  Write-Host "Xyte CLI Windows install is complete, but setup still needs an API key."
}
