# Video schneiden (Vue 3)

Browser-basiertes Tool zum Schneiden/Trimmen von Videos. Verarbeitung passiert
**client-seitig** mit FFmpeg (WebAssembly) – die Datei verlässt das Gerät nicht.

## Stack

Vue 3 (Composition API, `<script setup>`) · TypeScript (strict) · Pinia · Vite ·
Vitest · vue-i18n (DE/EN) · FFmpeg.wasm.

## Entwicklung

```bash
npm install
npm run dev       # Dev-Server (setzt COOP/COEP-Header automatisch)
npm run test      # Unit-Tests (Vitest)
npm run build     # Typcheck + Produktions-Build nach dist/
npm run preview   # Build lokal prüfen
```

> Node 18+ empfohlen. `pnpm` funktioniert genauso (Skripte identisch).

## Schnittmodi

- **Schnell (verlustfrei):** `-c copy`, extrem schnell, schneidet an Keyframes.
- **Genau (neu kodieren):** H.264/AAC, frame-genau, langsamer, immer `.mp4`.

## Deployment auf den VPS

Ein Skript erledigt Git-Sync, Build (inkl. selbst gehostetem ffmpeg-core) und
das Ausliefern nach `/var/www/…` – idempotent und ohne `git pull`-Stolperfallen:

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
(COOP/COEP + wasm-MIME!) und `nginx -t && systemctl reload nginx`.

> Hinweis: Das Skript setzt den Arbeitsbaum per `git reset --hard` auf den
> Remote-Stand. Der Deploy-Checkout ist damit eine reine Ableitung von Git –
> lokale Änderungen auf dem Server gehen dabei verloren (gewollt).

### Wichtig: Cross-Origin Isolation

FFmpeg.wasm braucht die Header
`Cross-Origin-Opener-Policy: same-origin` und
`Cross-Origin-Embedder-Policy: require-corp`.
Ohne sie lädt die Engine nicht. Prüfen in der Konsole:
`self.crossOriginIsolated === true`.

### ffmpeg-core selbst hosten (empfohlen)

Standardmäßig wird der Core von unpkg geladen. Für Unabhängigkeit von der CDN:
`@ffmpeg/core` in einen Ordner kopieren, ausliefern und
`VITE_FFMPEG_CORE_URL=/videoschneiden/ffmpeg` beim Build setzen.

## Server-Backend (optional)

Für große Dateien oder schnelle native Encodes gibt es ein vollständiges
VPS-Backend in `server/` (Express + FFmpeg, Job-basiert mit SSE-Fortschritt).
Der Umschalter „Im Browser / Auf dem Server" in der UI wählt den Weg.

- Dev: `cd server && npm install && npm run dev` (läuft auf `:4021`, Vite proxyt `/api`).
- Prod-Build der SPA mit `VITE_API_BASE=/videoschneiden`.
- Deployment + Nginx: siehe `server/README.md`.
