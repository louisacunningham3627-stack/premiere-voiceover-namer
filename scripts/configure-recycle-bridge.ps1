[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$PluginPath,
  [string]$PreviousPluginPath = '',
  [switch]$Remove,
  [switch]$SkipProtocol
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$resolved = [IO.Path]::GetFullPath($PluginPath).TrimEnd('\')
$helperPath = Join-Path $resolved 'native\windows\RecycleHelper.exe'
$schemePath = 'HKCU:\Software\Classes\hechao-voiceover-recycle'
$commandPath = Join-Path $schemePath 'shell\open\command'
$command = '"' + $helperPath + '" "%1"'

if ($Remove) {
  if (-not $SkipProtocol -and (Test-Path -LiteralPath $commandPath)) {
    $existing = (Get-Item -LiteralPath $commandPath).GetValue('')
    if ($existing -ceq $command) {
      # Delete only this verified, plugin-owned protocol registration.
      Remove-Item -LiteralPath $commandPath
      Remove-Item -LiteralPath (Join-Path $schemePath 'shell\open')
      Remove-Item -LiteralPath (Join-Path $schemePath 'shell')
      Remove-Item -LiteralPath $schemePath
    } else { throw '回收协议已指向其它程序，未改动该注册项。' }
  }
  return
}

$manifest = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $resolved 'manifest.json') | ConvertFrom-Json
if ($manifest.id -ne 'com.hechao.premiere.voiceover-namer' -or -not (Test-Path -LiteralPath $helperPath -PathType Leaf)) {
  throw '回收助手安装文件不完整。'
}
if (-not $SkipProtocol -and (Test-Path -LiteralPath $schemePath)) {
  if (-not (Test-Path -LiteralPath $commandPath) -or (Get-Item -LiteralPath $commandPath).GetValue('') -cne $command) {
    throw '同名协议已被其它程序占用，未覆盖。'
  }
}
$uxpRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $resolved))
$bridgePath = Join-Path $uxpRoot 'VoiceoverNamerData\Bridge'
New-Item -ItemType Directory -Path $bridgePath -Force | Out-Null
$tokenPath = Join-Path $bridgePath 'token.txt'
if (-not (Test-Path -LiteralPath $tokenPath)) {
  $token = ''
  if ($PreviousPluginPath) {
    $previousTokenPath = Join-Path $PreviousPluginPath 'native\windows\.bridge\token.txt'
    if (Test-Path -LiteralPath $previousTokenPath -PathType Leaf) {
      $token = [IO.File]::ReadAllText($previousTokenPath).Trim()
      if ($token -notmatch '^[0-9a-f]{64}$') { throw '旧回收助手身份无效，未覆盖安装。' }
    }
  }
  if (-not $token) {
    $bytes = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    $token = [BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant()
  }
  [IO.File]::WriteAllText($tokenPath, $token, (New-Object Text.UTF8Encoding($false)))
}
$locationPath = Join-Path (Split-Path -Parent $helperPath) 'bridge-location.json'
[IO.File]::WriteAllText($locationPath, (@{ directory = $bridgePath } | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false)))
if (-not $SkipProtocol) {
  New-Item -Path $commandPath -Force | Out-Null
  Set-Item -LiteralPath $schemePath -Value 'URL:赫朝录音回收助手'
  New-ItemProperty -LiteralPath $schemePath -Name 'URL Protocol' -Value '' -PropertyType String -Force | Out-Null
  Set-Item -LiteralPath $commandPath -Value $command
}
Write-Output '录音回收助手已配置；仅按需启动，不注册开机自启或计划任务。'
