# Video-Cutter – VPS-Backend

Optionales Backend für **serverseitigen** Videoschnitt mit nativem FFmpeg.
Sinnvoll für große Dateien oder schnelle Encodes. Für den Normalfall reicht die
Browser-Variante (FFmpeg.wasm) – das Backend ist ein Zusatz, kein Ersatz.

## Ablauf (Job-basiert mit Fortschritt)

1. `POST /api/cut` (multipart: `video`, `start`, `duration`, `mode`) → `202 { jobId }`
2. `GET  /api/cut/:jobId/events` → **SSE**-Stream: `{ state, progress, error }`
3. `GET  /api/cut/:jobId/download` → geschnittene Datei (danach Auto-Cleanup)
4. `DELETE /api/cut/:jobId` → laufenden Job abbrechen
5. `GET  /api/health` → Status + Auslastung

`mode`: `copy` (verlustfrei, keyframe-genau) oder `reencode` (H.264/AAC, frame-genau).

## Sicherheit & Robustheit

- `spawn` ohne Shell → keine Command-Injection; Parameter streng validiert.
- Upload-Limit (`MAX_FILE_SIZE_MB`), Dauer-Limit, MIME-Filter (`video/*`).
- Harte Zeitgrenze pro Job (`FFMPEG_TIMEOUT_SEC`) + Kill.
- Concurrency-Limit (`MAX_CONCURRENT`) → schützt CPU/RAM; sonst `429`.
- Temp-Dateien werden **immer** gelöscht (Erfolg, Fehler, Timeout, TTL, Shutdown).
- CORS auf erlaubte Origins beschränkt, Helmet, Rate-Limiting.
- Graceful Shutdown (SIGTERM/SIGINT) beendet laufende ffmpeg-Prozesse.

## Lokale Entwicklung

```bash
cd server
npm install
cp .env.example .env
npm run test      # Unit-Tests
npm run dev       # startet auf :4021 (tsx watch)
```

## Deployment auf den VPS

**Windows → VPS (bequem):**
```powershell
cd server
.\deploy\deploy.ps1
```
Kopiert die Quellen, installiert ffmpeg (falls nötig), baut und startet PM2.

**Oder direkt auf dem Server:**
```bash
cd /opt/video-cutter-server
bash deploy/setup-vps.sh
```

Danach einmalig das Nginx-Snippet `deploy/nginx-video-cutter-api.conf` in den
`server{}`-Block einbinden und `nginx -t && systemctl reload nginx`.

## Konfiguration

Alle Werte in `.env` (siehe `.env.example`). Wichtig für Produktion:
`ALLOWED_ORIGINS`, `MAX_FILE_SIZE_MB`, `MAX_CONCURRENT`.

## Frontend anbinden

Beim Build der SPA `VITE_API_BASE=/video-cutter` setzen; dann nutzt der
Umschalter „Auf dem Server" die Endpunkte oben. In der Entwicklung proxyt Vite
`/api` automatisch auf `http://localhost:4021`.
