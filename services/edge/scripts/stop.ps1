# ATTENTION : arrête serveur ET tunnel (comportement voulu). Pour relancer, démarrer les deux tâches « Laststream Server » et « Laststream Tunnel » ;
# démarrer seulement le serveur relance aussi le tunnel (voir server.ps1), pas l'inverse.
# Arrêt complet de Laststream (serveur et tunnel) : désactive les tâches, arrête les scripts, le serveur sur 7000 et cloudflared.
param([switch]$Uninstall)
foreach ($n in 'Laststream Tunnel', 'Laststream Server') { Stop-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue }
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -match '(tunnel|server)\.ps1' -and $_.ProcessId -ne $PID } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Get-CimInstance Win32_Process -Filter "Name like 'cloudflared%'" | Where-Object { $_.CommandLine -match '--url http://127.0.0.1:7000' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Get-NetTCPConnection -State Listen -LocalPort 7000 -ErrorAction SilentlyContinue | ForEach-Object {
  $o = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue; if ($o -and $o.ProcessName -eq 'node') { Stop-Process -Id $o.Id -Force } }
if ($Uninstall) { foreach ($n in 'Laststream Tunnel', 'Laststream Server') { Unregister-ScheduledTask -TaskName $n -Confirm:$false -ErrorAction SilentlyContinue } }
'ok'
