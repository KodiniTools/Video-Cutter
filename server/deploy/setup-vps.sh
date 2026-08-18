#!/usr/bin/env bash
# Setup/Update des Video-Cutter-Backends auf dem VPS.
# Auf dem Server ausführen:  bash setup-vps.sh
set -euo pipefail

APP_DIR="/opt/video-cutter-server"
TMP_DIR="/var/tmp/video-cutter"

echo "==> ffmpeg sicherstellen"
if ! command -v ffmpeg >/dev/null 2>&1; then
  apt-get update -y
  apt-get install -y ffmpeg
fi
ffmpeg -version | head -n1

echo "==> Temp-Verzeichnis"
mkdir -p "$TMP_DIR"

echo "==> .env anlegen (falls fehlt)"
cd "$APP_DIR"
if [ ! -f .env ]; then
  cp .env.example .env
  # Server-spezifische Defaults setzen (keine manuelle Bearbeitung nötig).
  sed -i "s|^# TMP_DIR=.*|TMP_DIR=${TMP_DIR}|" .env
  echo "   .env aus Vorlage erstellt – bei Bedarf ALLOWED_ORIGINS prüfen."
fi

echo "==> Abhängigkeiten + Build"
npm ci
npm run build

echo "==> PM2 starten/neu laden"
if pm2 describe video-cutter-api >/dev/null 2>&1; then
  pm2 reload ecosystem.config.cjs
else
  pm2 start ecosystem.config.cjs
fi
pm2 save

echo "==> Health-Check"
sleep 1
curl -fsS "http://127.0.0.1:4021/api/health" && echo

echo "==> Fertig. Nginx-Snippet einbinden (deploy/nginx-video-cutter-api.conf),"
echo "    dann:  nginx -t && systemctl reload nginx"
