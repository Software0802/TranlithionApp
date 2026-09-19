# Starts local LibreTranslate for Tranlithion page/selection MT.
# Prefers Docker if available; otherwise uses tools/libretranslate/.venv (pip).

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Name = "libretranslate"
$Image = "libretranslate/libretranslate:latest"
$Port = 5000
$VenvDir = Join-Path $Root "tools\libretranslate\.venv"
$VenvPython = Join-Path $VenvDir "Scripts\python.exe"
$VenvLt = Join-Path $VenvDir "Scripts\libretranslate.exe"
$PidFile = Join-Path $Root "tools\libretranslate\libretranslate.pid"
$LogDir = Join-Path $Root "tools\libretranslate"
$LogOut = Join-Path $LogDir "libretranslate.out.log"
$LogErr = Join-Path $LogDir "libretranslate.err.log"

function Test-PortOpen {
  param([int]$Port)
  try {
    $client = New-Object System.Net.Sockets.TcpClient
    $iar = $client.BeginConnect("127.0.0.1", $Port, $null, $null)
    $ok = $iar.AsyncWaitHandle.WaitOne(400)
    if ($ok -and $client.Connected) { $client.Close(); return $true }
    $client.Close()
  } catch {}
  return $false
}

function Test-Docker {
  try {
    docker info 1>$null 2>$null
    return ($LASTEXITCODE -eq 0)
  } catch {
    return $false
  }
}

function Start-DockerLibreTranslate {
  $existing = docker ps -a --filter "name=^/${Name}$" --format "{{.ID}}"
  if (-not $existing) {
    Write-Host "Creating Docker container (first pull may take a while)..." -ForegroundColor Cyan
    docker run -d --name $Name -p "${Port}:5000" $Image
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  } else {
    $running = docker ps --filter "name=^/${Name}$" --format "{{.ID}}"
    if (-not $running) {
      Write-Host "Starting existing container $Name ..." -ForegroundColor Cyan
      docker start $Name | Out-Null
    } else {
      Write-Host "Container $Name already running." -ForegroundColor Green
    }
  }
}

function Ensure-PipVenv {
  if (Test-Path $VenvPython) { return }
  Write-Host "Creating venv and installing libretranslate (first time is slow)..." -ForegroundColor Cyan
  New-Item -ItemType Directory -Force -Path (Split-Path $VenvDir) | Out-Null
  py -m venv $VenvDir
  if ($LASTEXITCODE -ne 0) {
    python -m venv $VenvDir
  }
  & $VenvPython -m pip install --upgrade pip
  & (Join-Path $VenvDir "Scripts\pip.exe") install libretranslate
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

function Ensure-LanguagePackages {
  $argospm = Join-Path $VenvDir "Scripts\argospm.exe"
  if (-not (Test-Path $argospm)) { return }
  Write-Host "Ensuring Argos packages (ja_en, en_zh)..." -ForegroundColor Cyan
  & $argospm update 2>$null | Out-Null
  foreach ($pkg in @("translate-ja_en", "translate-en_zh")) {
    & $argospm install $pkg 2>&1 | Out-Null
  }
}

function Start-PipLibreTranslate {
  Ensure-PipVenv
  Ensure-LanguagePackages
  if (Test-PortOpen -Port $Port) {
    Write-Host "Port $Port already in use; skip start." -ForegroundColor Green
    return
  }
  if (Test-Path $PidFile) {
    $oldPid = Get-Content $PidFile -ErrorAction SilentlyContinue
    if ($oldPid -and (Get-Process -Id $oldPid -ErrorAction SilentlyContinue)) {
      Write-Host "LibreTranslate already running (PID $oldPid)." -ForegroundColor Green
      return
    }
  }
  Write-Host "Starting LibreTranslate via Python..." -ForegroundColor Cyan
  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
  # en is required as pivot for ja->zh (no direct ja_zh package).
  $proc = Start-Process -FilePath $VenvLt `
    -ArgumentList @(
      "--host", "127.0.0.1",
      "--port", "$Port",
      "--load-only", "en,ja,zh"
    ) `
    -WorkingDirectory $LogDir `
    -RedirectStandardOutput $LogOut `
    -RedirectStandardError $LogErr `
    -WindowStyle Hidden `
    -PassThru
  Set-Content -Path $PidFile -Value $proc.Id -Encoding ascii
  Write-Host "Started PID $($proc.Id)" -ForegroundColor Yellow
  Write-Host "Logs: $LogOut / $LogErr" -ForegroundColor Yellow
  Write-Host "Waiting for ready..." -ForegroundColor Cyan
  $deadline = (Get-Date).AddMinutes(15)
  while ((Get-Date) -lt $deadline) {
    if (-not (Get-Process -Id $proc.Id -ErrorAction SilentlyContinue)) {
      Write-Host "Process exited. See: $LogErr" -ForegroundColor Red
      if (Test-Path $LogErr) { Get-Content $LogErr -Tail 40 }
      exit 1
    }
    if (Test-PortOpen -Port $Port) { break }
    Start-Sleep -Seconds 2
  }
  if (-not (Test-PortOpen -Port $Port)) {
    Write-Host "Timed out waiting for port $Port." -ForegroundColor Red
    if (Test-Path $LogErr) { Get-Content $LogErr -Tail 40 }
    exit 1
  }
}

if (Test-PortOpen -Port $Port) {
  Write-Host "LibreTranslate already listening on http://127.0.0.1:$Port" -ForegroundColor Green
} elseif (Test-Docker) {
  Write-Host "Docker detected; using container." -ForegroundColor Cyan
  Start-DockerLibreTranslate
} else {
  Write-Host "No Docker; using local Python venv." -ForegroundColor Yellow
  Start-PipLibreTranslate
}

Write-Host ""
Write-Host "LibreTranslate: http://127.0.0.1:$Port" -ForegroundColor Green
Write-Host "Translate API:  http://127.0.0.1:$Port/translate" -ForegroundColor Green
Write-Host "Enable local MT in extension options and allow 127.0.0.1." -ForegroundColor Yellow
