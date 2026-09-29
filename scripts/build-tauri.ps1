# Build Tauri shell. Windows + Chinese project path: MinGW windres cannot open
# icons under non-ASCII paths, so we override icon paths via TAURI_CONFIG.
param(
  [switch]$Release
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $Root 'src-tauri\Cargo.toml'))) {
  throw "Run from repo: missing src-tauri"
}

# Prefer WinLibs MinGW on PATH
$wingetPkgs = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages'
$gcc = Get-ChildItem -Path $wingetPkgs -Recurse -Filter gcc.exe -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -match 'mingw64\\bin\\gcc\.exe$' } |
  Select-Object -First 1
if ($gcc) {
  $env:Path = "$(Split-Path $gcc.FullName);$env:Path"
}

$iconSrc = Join-Path $Root 'src-tauri\icons'
$iconDst = 'C:\dev\douyin-frames-icons'
New-Item -ItemType Directory -Force -Path $iconDst | Out-Null
cmd /c "xcopy /Y /Q `"$iconSrc\*.*`" `"$iconDst\`" >nul"

$icons = @(
  'C:/dev/douyin-frames-icons/32x32.png',
  'C:/dev/douyin-frames-icons/128x128.png',
  'C:/dev/douyin-frames-icons/henry.w@example.net',
  'C:/dev/douyin-frames-icons/icon.icns',
  'C:/dev/douyin-frames-icons/icon.ico'
)
$env:TAURI_CONFIG = (@{ bundle = @{ icon = $icons } } | ConvertTo-Json -Compress -Depth 5)
$env:CARGO_TARGET_DIR = Join-Path $env:LOCALAPPDATA 'douyin-frames-target'

# Build via ASCII junction when project path has non-ASCII chars
$junction = 'C:\dev\douyin-frames'
if (-not (Test-Path $junction)) {
  New-Item -ItemType Directory -Force -Path 'C:\dev' | Out-Null
  cmd /c "mklink /J `"$junction`" `"$Root`""
}
Set-Location (Join-Path $junction 'src-tauri')

$mode = if ($Release) { 'build --release' } else { 'build' }
Write-Host "cargo $mode (target=$env:CARGO_TARGET_DIR)"
Invoke-Expression "cargo $mode"
Write-Host "OK. Binary under $env:CARGO_TARGET_DIR"
