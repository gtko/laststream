# Serveur lastAddon permanent (tâche planifiée « Laststream Server »). Sans fenêtre ; relance le serveur s'il s'arrête.
# Au démarrage, relance la tâche « Laststream Tunnel » si elle n'est pas en cours (ex. après stop.ps1 puis relance du seul serveur).
$ErrorActionPreference = 'Continue'
$root = Join-Path $env:APPDATA 'Laststream'
$logs = Join-Path $root 'logs'
New-Item -ItemType Directory -Force $logs | Out-Null
$desktop = 'C:\Users\grego\Projets\laststream\dist\laststream-desktop'
$log = Join-Path $logs 'server.log'
if ((Test-Path $log) -and (Get-Item $log).Length -gt 5MB) { Move-Item -Force $log "$log.1" }

function Log($m) { Add-Content -Path $log -Value ("{0:s} {1}" -f (Get-Date), $m) }

$dataDir = Join-Path $root 'lastaddon'
New-Item -ItemType Directory -Force $dataDir | Out-Null
$env:PORT = '7000'
$env:LASTADDON_DATA_DIR = $dataDir
$env:LASTADDON_ENV_FILE = Join-Path $dataDir '.env'
$env:LASTADDON_UI_DIR = Join-Path $desktop 'ui'
$env:LASTADDON_FFMPEG = Join-Path $desktop 'ffmpeg.exe'
$env:LASTADDON_ALLOWED_ORIGINS = 'http://localhost:8080,http://127.0.0.1:8080,http://192.168.1.143:8080,https://localhost,http://localhost,capacitor://localhost,https://laststream.gtux-prog.workers.dev,http://127.0.0.1:7000,http://localhost:7000'
$edge = Join-Path $root 'edge.secret'
if (Test-Path $edge) { $env:LASTADDON_EDGE_SECRET = (Get-Content -Raw $edge).Trim() }

# Une autre instance du script, ou un serveur orphelin sur le port 7000, est arrêtée d'abord.
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
  Where-Object { $_.CommandLine -match 'server\.ps1' -and $_.ProcessId -ne $PID } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Get-NetTCPConnection -State Listen -LocalPort 7000 -ErrorAction SilentlyContinue |
  ForEach-Object { $o = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue; if ($o -and $o.ProcessName -eq 'node') { Stop-Process -Id $o.Id -Force } }
Start-Sleep -Seconds 1

$tunnelTask = Get-ScheduledTask -TaskName 'Laststream Tunnel' -ErrorAction SilentlyContinue
if ($tunnelTask -and $tunnelTask.State -ne 'Running') { Start-ScheduledTask -TaskName 'Laststream Tunnel' -ErrorAction SilentlyContinue; Log 'tunnel relancé par le serveur' }

$node = Join-Path $desktop 'lastaddon\node.exe'
$bundle = Join-Path $desktop 'lastaddon\lastaddon.cjs'
while ($true) {
  Log "démarrage de lastAddon (port 7000)"
  $p = Start-Process -FilePath $node -ArgumentList "`"$bundle`"" -WindowStyle Hidden -PassThru -Wait `
    -RedirectStandardOutput (Join-Path $logs 'lastaddon.out.log') -RedirectStandardError (Join-Path $logs 'lastaddon.err.log')
  Log "lastAddon arrêté (code $($p.ExitCode)), relance dans 5 s"
  Start-Sleep -Seconds 5
}

