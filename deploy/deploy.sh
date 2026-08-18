#!/usr/bin/env bash
#
# Video-Cutter – Deploy auf den VPS (statische SPA + selbst gehostetes ffmpeg-core)
#
# Baut die Vue-SPA und spiegelt sie nach /var/www/… – idempotent und ohne die
# typischen "git pull"-Stolperfallen (lokale/untracked Änderungen auf dem Server).
#
# Aufruf (auf dem Server):
#   bash deploy/deploy.sh
#
# Alles ist über Umgebungsvariablen konfigurierbar (Defaults für kodinitools.com):
#   BRANCH        Zu deployender Branch                (default: main)
#   BASE_PATH     Unterverzeichnis der Seite           (default: /video-cutter/)
#   WEB_ROOT      Zielverzeichnis im Webroot           (default: /var/www/kodinitools.com/video-cutter)
#   WEB_USER      Eigentümer der ausgelieferten Dateien(default: www-data)
#   SKIP_PULL=1   Git-Sync überspringen (nur bauen/deployen)
#
# Beispiel mit abweichendem Pfad:
#   BASE_PATH=/videoschneiden/ WEB_ROOT=/var/www/kodinitools/videoschneiden bash deploy/deploy.sh

set -euo pipefail

# --- Konfiguration --------------------------------------------------------
BRANCH="${BRANCH:-main}"
BASE_PATH="${BASE_PATH:-/video-cutter/}"
WEB_ROOT="${WEB_ROOT:-/var/www/kodinitools.com/video-cutter}"
WEB_USER="${WEB_USER:-www-data}"

# Aus BASE_PATH abgeleitet (ohne abschließenden Slash für API/Core).
BASE_NO_SLASH="${BASE_PATH%/}"
VITE_BASE="${VITE_BASE:-$BASE_PATH}"
VITE_FFMPEG_CORE_URL="${VITE_FFMPEG_CORE_URL:-$BASE_NO_SLASH/ffmpeg}"
VITE_API_BASE="${VITE_API_BASE:-$BASE_NO_SLASH}"

# Repo-Wurzel = Elternverzeichnis dieses Skripts (deploy/).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_DIR"

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }

# --- 1) Sauberer Git-Sync -------------------------------------------------
# Ein "git pull" scheitert, sobald auf dem Server lokale Änderungen an
# versionierten Dateien (z. B. package.json) oder untracked Dateien liegen,
# die vom Remote überschrieben würden (z. B. ein per "npm install" erzeugtes
# package-lock.json). Deshalb setzen wir den Arbeitsbaum hart auf den Remote-
# Stand – der Deploy-Checkout ist eine reine Ableitung von Git, keine
# Arbeitskopie.
if [[ "${SKIP_PULL:-0}" != "1" ]]; then
  log "Git-Sync auf origin/$BRANCH (hard reset)"
  git fetch --prune origin "$BRANCH"
  git checkout -q "$BRANCH"
  git reset --hard "origin/$BRANCH"
  # Nicht versionierte Reste entfernen, aber node_modules/ und dist/ (ignored)
  # bewusst behalten, damit npm-Cache/Build nicht jedes Mal neu müssen.
  git clean -fd -e node_modules -e dist
else
  log "SKIP_PULL=1 – Git-Sync übersprungen"
fi

# --- 2) Abhängigkeiten reproduzierbar installieren ------------------------
# "npm ci" installiert exakt nach package-lock.json und stellt sicher, dass
# node_modules zum Build passt (der ffmpeg-core wird daraus kopiert).
log "npm ci"
npm ci

# --- 3) Produktions-Build -------------------------------------------------
log "Build (base=$VITE_BASE, core=$VITE_FFMPEG_CORE_URL, api=$VITE_API_BASE)"
VITE_BASE="$VITE_BASE" \
VITE_FFMPEG_CORE_URL="$VITE_FFMPEG_CORE_URL" \
VITE_API_BASE="$VITE_API_BASE" \
  npm run build

# --- 4) Ausliefern --------------------------------------------------------
# Hinweis: Der Schnitt läuft ausschließlich serverseitig (Backend :9015).
# Ein Browser-/WASM-Weg existiert nicht mehr, daher wird kein ffmpeg-core mehr
# mit ausgeliefert.
log "Rsync nach $WEB_ROOT"
sudo mkdir -p "$WEB_ROOT"
sudo rsync -a --delete dist/ "$WEB_ROOT/"
sudo chown -R "$WEB_USER:$WEB_USER" "$WEB_ROOT"

log "Deploy fertig – $WEB_ROOT (Branch $BRANCH)"
