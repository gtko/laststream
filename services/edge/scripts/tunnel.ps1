# Tunnel rapide cloudflared (tâche planifiée « Laststream Tunnel »). Enregistre l'URL courante auprès du Worker.
$ErrorActionPreference = 'Continue'
$root = Join-Path $env:APPDATA 'Laststream'
$logs = Join-Path $root 'logs'
New-Item -ItemType Directory -Force $logs | Out-Null
$log = Join-Path $logs 'tunnel.log'
$cfLog = Join-Path $logs 'cloudflared.log'
if ((Test-Path $log) -and (Get-Item $log).Length -gt 5MB) { Move-Item -Force $log "$log.1" }
function Log($m) { Add-Content -Path $log -Value ("{0:s} {1}" -f (Get-Date), $m) }

$worker = 'https://laststream.gtux-prog.workers.dev'
$secretFile = Join-Path $root 'tunnel.secret'
$cloudflared = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links\cloudflared.exe'
if (-not (Test-Path $cloudflared)) { $cloudflared = (Get-Command cloudflared -ErrorAction SilentlyContinue).Source }

# Une autre instance du script (arrêt de tâche qui n'a pas tué l'arborescence) est arrêtée d'abord.
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
  Where-Object { $_.CommandLine -match 'tunnel\.ps1' -and $_.ProcessId -ne $PID } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

# Un tunnel orphelin d'une exécution précédente est arrêté avant d'en lancer un nouveau.
Get-CimInstance Win32_Process -Filter "Name like 'cloudflared%'" |
  Where-Object { $_.CommandLine -match '--url http://127.0.0.1:7000' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

function Register-Tunnel([string]$url) {
  $secret = (Get-Content -Raw $secretFile).Trim()
  try {
    Invoke-RestMethod -Method Post -Uri "$worker/__laststream/register" -TimeoutSec 20 `
      -Headers @{ 'x-register-secret' = $secret } -ContentType 'application/json' -Body (@{ url = $url } | ConvertTo-Json) | Out-Null
    return $true
  } catch {
    Log "enregistrement refusé ou impossible : $($_.Exception.Message)"
    return $false
  }
}

function Test-Health([string]$base) {
  try {
    $r = Invoke-WebRequest -Uri "$base/health" -UseBasicParsing -TimeoutSec 10 -Headers @{ 'cache-control' = 'no-cache' }
    return $r.StatusCode -eq 200
  } catch { return $false }
}

# Chien de garde : toutes les 60 s, /health en direct sur le tunnel ET via le Worker.
# 2 échecs directs consécutifs => cloudflared est redémarré (nouvelle URL, ré-enregistrement).
# Ré-enregistrement inconditionnel toutes les 5 min. Journal concis : échecs, redémarrages, une ligne « ok » / 30 min.
while ($true) {
  if (Test-Path $cfLog) { Remove-Item -Force $cfLog -ErrorAction SilentlyContinue }
  Log 'démarrage de cloudflared'
  $proc = Start-Process -FilePath $cloudflared -ArgumentList 'tunnel', '--url', 'http://127.0.0.1:7000', '--no-autoupdate' `
    -WindowStyle Hidden -PassThru -RedirectStandardError $cfLog -RedirectStandardOutput (Join-Path $logs 'cloudflared.out.log')
  $url = $null
  $deadline = (Get-Date).AddSeconds(60)
  while (-not $proc.HasExited -and -not $url -and (Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 1
    if (Test-Path $cfLog) {
      $m = Select-String -Path $cfLog -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -AllMatches -ErrorAction SilentlyContinue | Select-Object -Last 1
      if ($m) { $url = $m.Matches[0].Value }
    }
  }
  if ($url) {
    Log "tunnel : $url"
    $registered = $false
    for ($i = 0; $i -lt 10 -and -not $registered -and -not $proc.HasExited; $i++) {
      $registered = Register-Tunnel $url
      if (-not $registered) { Start-Sleep -Seconds 5 }
    }
    if ($registered) { Log 'URL enregistrée auprès du Worker' }

    # Période de grâce : attente (max ~90 s) que le tunnel réponde en direct (propagation DNS) avant de compter les échecs.
    $up = $false
    for ($i = 0; $i -lt 30 -and -not $up -and -not $proc.HasExited; $i++) { if (Test-Health $url) { $up = $true } else { Start-Sleep -Seconds 3 } }
    if ($up) { Log 'tunnel joignable en direct' } else { Log 'tunnel non joignable après la période de grâce' }

    $nextCheck = (Get-Date).AddSeconds(60)
    $nextRegister = (Get-Date).AddMinutes(5)
    $nextOk = (Get-Date).AddMinutes(30)
    $directFails = 0
    $workerFails = 0
    while (-not $proc.HasExited) {
      Start-Sleep -Seconds 2
      $now = Get-Date
      if ($now -ge $nextRegister) {
        $nextRegister = $now.AddMinutes(5)
        $null = Register-Tunnel $url   # les échecs sont journalisés par Register-Tunnel
      }
      if ($now -lt $nextCheck) { continue }
      $nextCheck = $now.AddSeconds(60)
      if (Test-Health $url) { $directFails = 0 } else {
        $directFails++
        Log "health direct en échec ($directFails/2)"
        if ($directFails -ge 2) { Log 'tunnel mort : redémarrage de cloudflared'; break }
      }
      if (Test-Health $worker) { $workerFails = 0 } else {
        $workerFails++
        Log "health via le Worker en échec ($workerFails)"
        # Le Worker ne pointe peut-être plus sur la bonne URL : on la ré-enregistre sans attendre.
        if ($directFails -eq 0) { $null = Register-Tunnel $url; $nextRegister = (Get-Date).AddMinutes(5) }
      }
      if ($now -ge $nextOk) { Log "ok ($url)"; $nextOk = $now.AddMinutes(30) }
    }
  } else {
    Log 'aucune URL de tunnel obtenue'
  }
  if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
  Log 'cloudflared arrêté, relance dans 5 s'
  Start-Sleep -Seconds 5
}
