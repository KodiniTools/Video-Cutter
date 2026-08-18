# Video schneiden (Vue 3)

Tool zum Schneiden/Trimmen von Videos. Der Schnitt läuft **serverseitig** mit
nativem FFmpeg (VPS-Backend, Job-basiert mit SSE-Fortschritt). Das Frontend
lädt die Datei hoch, wählt Bereich + Modus und lädt das Ergebnis herunter.

## Stack

Vue 3 (Composition API, `<script setup>`) · TypeScript (strict) · Pinia · Vite ·
Vitest · vue-i18n (DE/EN). Backend: Node/Express + FFmpeg (siehe `server/`).

## Entwicklung

```bash
npm install
npm run dev       # Dev-Server (Vite proxyt /api auf das Backend :9015)
npm run test      # Unit-Tests (Vitest)
npm run build     # Typcheck + Produktions-Build nach dist/
npm run preview   # Build lokal prüfen
```

Für den Schnitt muss parallel das Backend laufen:

```bash
cd server && npm install && npm run dev   # startet auf :9015
```

> Node 18+ empfohlen. `pnpm` funktioniert genauso (Skripte identisch).

## Schnittmodi

- **Schnell (verlustfrei):** `-c copy`, extrem schnell, schneidet an Keyframes.
- **Genau (neu kodieren):** H.264/AAC, frame-genau, langsamer, immer `.mp4`.

## Deployment auf den VPS

Ein Skript erledigt Git-Sync, Build und das Ausliefern der statischen SPA nach
`/var/www/…` – idempotent und ohne `git pull`-Stolperfallen:

```bash
bash deploy/deploy.sh
```

Konfigurierbar über Umgebungsvariablen (Defaults für kodinitools.com, Seite
unter `/video-cutter/`):

```bash
BASE_PATH=/videoschneiden/ \
WEB_ROOT=/var/www/kodinitools/videoschneiden \
  bash deploy/deploy.sh
```

Einmalig noch das Nginx-Snippet aus `deploy/nginx-video-cutter.conf` einbinden
und `nginx -t && systemctl reload nginx`.

> Hinweis: Das Skript setzt den Arbeitsbaum per `git reset --hard` auf den
> Remote-Stand. Der Deploy-Checkout ist damit eine reine Ableitung von Git –
> lokale Änderungen auf dem Server gehen dabei verloren (gewollt).

## Server-Backend

Der eigentliche Schnitt passiert im VPS-Backend in `server/` (Express + FFmpeg,
Job-basiert mit SSE-Fortschritt).

- Dev: `cd server && npm install && npm run dev` (läuft auf `:9015`, Vite proxyt `/api`).
- Prod-Build der SPA mit `VITE_API_BASE=/video-cutter` (macht `deploy/deploy.sh`).
- Der Backend-Port (`server/.env` → `PORT`) muss mit dem Nginx-Proxy übereinstimmen (`:9015`).
- Deployment + Nginx: siehe `server/README.md`.
