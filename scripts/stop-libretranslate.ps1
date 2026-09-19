# Stop local LibreTranslate started by start-libretranslate.ps1 (pip mode).
# Docker mode: docker stop libretranslate

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$PidFile = Join-Path $Root "tools\libretranslate\libretranslate.pid"
$Port = 5000

if (Test-Path $PidFile) {
  $oldPid = Get-Content $PidFile -ErrorAction SilentlyContinue
  if ($oldPid -and (Get-Process -Id $oldPid -ErrorAction SilentlyContinue)) {
    Stop-Process -Id $oldPid -Force
    Write-Host "Stopped PID $oldPid" -ForegroundColor Green
  }
  Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
} else {
  Write-Host "No pid file (Docker mode or not started via script)." -ForegroundColor Yellow
}

try {
  docker stop libretranslate 1>$null 2>$null
  if ($LASTEXITCODE -eq 0) {
    Write-Host "Stopped Docker container libretranslate." -ForegroundColor Green
  }
} catch {}

Write-Host "Done. If port $Port is still busy, kill the process manually."
