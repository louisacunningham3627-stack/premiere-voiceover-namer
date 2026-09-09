[CmdletBinding()]
param(
  [string]$TargetRoot = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$pluginId = "com.hechao.premiere.voiceover-namer"

if ([string]::IsNullOrWhiteSpace($TargetRoot) -and [string]::IsNullOrWhiteSpace($env:APPDATA)) {
  throw "APPDATA is unavailable; cannot resolve the user UXP directory."
}
if ([string]::IsNullOrWhiteSpace($TargetRoot)) {
  $TargetRoot = Join-Path $env:APPDATA "Adobe\UXP\Plugins\External"
}

if (Get-Process -Name "Adobe Premiere Pro" -ErrorAction SilentlyContinue) {
  throw "Close Premiere Pro before uninstalling the plugin."
}

$targetPath = Join-Path $TargetRoot $pluginId
if (-not (Test-Path -LiteralPath $targetPath -PathType Container)) {
  [pscustomobject]@{
    Status = "not-installed"
    PluginId = $pluginId
    InstalledPath = $targetPath
  }
  exit 0
}

$uxpRoot = Split-Path -Parent (Split-Path -Parent $TargetRoot)
$backupRoot = Join-Path $uxpRoot "PluginBackups"
$runId = "{0}-{1}" -f (Get-Date -Format "yyyyMMdd-HHmmss"), ([guid]::NewGuid().ToString("N").Substring(0, 8))
$backupPath = Join-Path $backupRoot ("{0}-uninstalled-{1}" -f $pluginId, $runId)

New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
& (Join-Path $PSScriptRoot 'configure-recycle-bridge.ps1') -PluginPath $targetPath -Remove
Move-Item -LiteralPath $targetPath -Destination $backupPath

[pscustomobject]@{
  Status = "uninstalled"
  PluginId = $pluginId
  PreviousPath = $targetPath
  RecoverableBackup = $backupPath
  RestoreCommand = "Move-Item -LiteralPath '$backupPath' -Destination '$targetPath'"
}
