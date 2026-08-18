# Deploy des Video-Cutter-Backends von Windows auf den VPS.
# Voraussetzung: OpenSSH-Client (ssh/scp) installiert.
# Aufruf (aus dem Ordner server/):
#   .\deploy\deploy.ps1

param(
  [string]$RemoteHost = "root@145.223.81.100",
  [string]$RemoteDir  = "/opt/video-cutter-server"
)

$ErrorActionPreference = "Stop"
$ServerRoot = Split-Path -Parent $PSScriptRoot   # ...\server

Write-Host "==> Zielverzeichnis anlegen" -ForegroundColor Cyan
ssh $RemoteHost "mkdir -p $RemoteDir"

Write-Host "==> Dateien kopieren (ohne node_modules/dist)" -ForegroundColor Cyan
$items = @("src", "deploy", "package.json", "tsconfig.json", "ecosystem.config.cjs", ".env.example")
foreach ($item in $items) {
  $path = Join-Path $ServerRoot $item
  if (Test-Path $path) {
    scp -r $path "${RemoteHost}:${RemoteDir}/"
  }
}

Write-Host "==> Setup/Build/PM2 auf dem Server" -ForegroundColor Cyan
ssh $RemoteHost "cd $RemoteDir && bash deploy/setup-vps.sh"

Write-Host "==> Deploy abgeschlossen." -ForegroundColor Green
Write-Host "   Danach einmalig Nginx-Snippet einbinden und reloaden."
