[CmdletBinding()]
param(
  [string]$BuildPath = "",
  [string]$TargetRoot = "",
  [switch]$SkipBridgeProtocol
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$pluginId = "com.hechao.premiere.voiceover-namer"

function Get-Sha256 {
  param([Parameter(Mandatory = $true)][string]$Path)

  $stream = [System.IO.File]::OpenRead($Path)
  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try {
    return [System.BitConverter]::ToString($sha256.ComputeHash($stream)).Replace("-", "")
  } finally {
    $sha256.Dispose()
    $stream.Dispose()
  }
}

function Get-FileInventory {
  param([Parameter(Mandatory = $true)][string]$Root)

  $resolvedRoot = (Resolve-Path -LiteralPath $Root).Path.TrimEnd("\")
  return @(
    Get-ChildItem -File -Recurse -LiteralPath $resolvedRoot | ForEach-Object {
      [pscustomobject]@{
        RelativePath = $_.FullName.Substring($resolvedRoot.Length).TrimStart("\")
        Hash = Get-Sha256 -Path $_.FullName
      }
    }
  )
}

if ([string]::IsNullOrWhiteSpace($BuildPath)) {
  $scriptDirectory = Split-Path -Parent $PSCommandPath
  $BuildPath = Join-Path (Split-Path -Parent $scriptDirectory) "dist"
}

if ([string]::IsNullOrWhiteSpace($TargetRoot) -and [string]::IsNullOrWhiteSpace($env:APPDATA)) {
  throw "APPDATA is unavailable; cannot resolve the user UXP directory."
}
if ([string]::IsNullOrWhiteSpace($TargetRoot)) {
  $TargetRoot = Join-Path $env:APPDATA "Adobe\UXP\Plugins\External"
}

if (Get-Process -Name "Adobe Premiere Pro" -ErrorAction SilentlyContinue) {
  throw "Close Premiere Pro before installing or updating the plugin."
}

if (-not (Test-Path -LiteralPath $BuildPath -PathType Container)) {
  throw "Build directory not found: $BuildPath. Run npm run check first."
}

$manifestPath = Join-Path $BuildPath "manifest.json"
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
  throw "Plugin manifest not found: $manifestPath"
}

$manifest = Get-Content -Raw -Encoding UTF8 -LiteralPath $manifestPath | ConvertFrom-Json
if ($manifest.id -ne $pluginId) {
  throw "Unexpected plugin id in manifest: $($manifest.id)"
}
if ($manifest.host.app -ne "premierepro") {
  throw "The build does not target Premiere Pro."
}

$uxpRoot = Split-Path -Parent (Split-Path -Parent $TargetRoot)
$stagingRoot = Join-Path $uxpRoot "PluginStaging"
$backupRoot = Join-Path $uxpRoot "PluginBackups"
$targetPath = Join-Path $TargetRoot $pluginId
$runId = "{0}-{1}" -f (Get-Date -Format "yyyyMMdd-HHmmss"), ([guid]::NewGuid().ToString("N").Substring(0, 8))
$stagingPath = Join-Path $stagingRoot ("{0}-{1}" -f $pluginId, $runId)
$backupPath = Join-Path $backupRoot ("{0}-before-{1}" -f $pluginId, $runId)
$failedPath = Join-Path $backupRoot ("{0}-failed-{1}" -f $pluginId, $runId)

New-Item -ItemType Directory -Path $TargetRoot, $stagingRoot, $backupRoot -Force | Out-Null
New-Item -ItemType Directory -Path $stagingPath -Force | Out-Null
Get-ChildItem -Force -LiteralPath $BuildPath | Copy-Item -Destination $stagingPath -Recurse -Force

$sourceInventory = Get-FileInventory -Root $BuildPath
$stagedInventory = Get-FileInventory -Root $stagingPath
$stageDiff = @(Compare-Object $sourceInventory $stagedInventory -Property RelativePath, Hash)
if ($sourceInventory.Count -eq 0 -or $stageDiff.Count -ne 0) {
  throw "Staged plugin failed file-count or SHA-256 verification. Staging was retained at: $stagingPath"
}

$previousInstall = Test-Path -LiteralPath $targetPath -PathType Container
try {
  if ($previousInstall) {
    Move-Item -LiteralPath $targetPath -Destination $backupPath
  }

  Move-Item -LiteralPath $stagingPath -Destination $targetPath
  $installedInventory = Get-FileInventory -Root $targetPath
  $installDiff = @(Compare-Object $sourceInventory $installedInventory -Property RelativePath, Hash)
  if ($installDiff.Count -ne 0) {
    throw "Installed plugin failed SHA-256 verification."
  }
  & (Join-Path $PSScriptRoot 'configure-recycle-bridge.ps1') -PluginPath $targetPath -PreviousPluginPath $(if ($previousInstall) { $backupPath } else { '' }) -SkipProtocol:$SkipBridgeProtocol
} catch {
  if (Test-Path -LiteralPath $targetPath) {
    Move-Item -LiteralPath $targetPath -Destination $failedPath
  }
  if ($previousInstall -and (Test-Path -LiteralPath $backupPath) -and -not (Test-Path -LiteralPath $targetPath)) {
    Move-Item -LiteralPath $backupPath -Destination $targetPath
  }
  throw
}

[pscustomobject]@{
  Status = "installed"
  PluginId = $pluginId
  Version = [string]$manifest.version
  InstalledPath = $targetPath
  FileCount = $sourceInventory.Count
  PreviousInstallBackup = if ($previousInstall) { $backupPath } else { $null }
  NextStep = "Start Premiere, then open Window > UXP Plugins and select the voice-over naming panel."
}
