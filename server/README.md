# Video-Cutter – VPS-Backend

Optionales Backend für **serverseitigen** Videoschnitt mit nativem FFmpeg.
Sinnvoll für große Dateien oder schnelle Encodes. Für den Normalfall reicht die
Browser-Variante (FFmpeg.wasm) – das Backend ist ein Zusatz, kein Ersatz.

## Ablauf (Job-basiert mit Fortschritt)

1. `POST /api/cut` (multipart: `video`, `start`, `duration`, `mode`) → `202 { jobId }`
2. `GET  /api/cut/:jobId/events` → **SSE**-Stream: `{ state, progress, error }`
3. `GET  /api/cut/:jobId/download` → geschnittene Datei (danach Auto-Cleanup)
4. `DELETE /api/cut/:jobId` → laufenden Job abbrechen
5. `GET  /api/health` → Status + Auslastung + `features` (z. B. `["crop"]`)

`mode`: `copy` (verlustfrei, keyframe-genau) oder `reencode` (H.264/AAC, frame-genau).

## Sicherheit & Robustheit

- `spawn` ohne Shell → keine Command-Injection; Parameter streng validiert.
- Upload-Limit (`MAX_FILE_SIZE_MB`), Dauer-Limit, MIME-Filter (`video/*`).
- Harte Zeitgrenze pro Job (`FFMPEG_TIMEOUT_SEC`) + Kill.
- Concurrency-Limit (`MAX_CONCURRENT`) → schützt CPU/RAM; sonst `429`.
- Temp-Dateien werden **immer** gelöscht (Erfolg, Fehler, Timeout, TTL, Shutdown).
- CORS auf erlaubte Origins beschränkt, Helmet, Rate-Limiting pro IP (`RATE_LIMIT_WRITE_MAX` für POST, `RATE_LIMIT_READ_MAX` für den Rest, je 15 min; sonst `429` mit `Retry-After`).
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

## KI-Funktionen (Untertitel, Schnittvorschläge)

Optional. Die Tonspur wird lokal mit [whisper.cpp](https://github.com/ggml-org/whisper.cpp)
transkribiert (Wort-Zeitstempel); Claude korrigiert/übersetzt daraus Untertitel und
schlägt Schnitte vor (Füllwörter, Versprecher, Wiederholungen; Pausen erkennt der
Server selbst). Zeiten berechnet der Server aus den Wort-Indizes.

```bash
sudo apt-get install -y build-essential cmake git
sudo git clone --depth 1 https://github.com/ggml-org/whisper.cpp /opt/whisper.cpp
cd /opt/whisper.cpp
sudo cmake -B build -DCMAKE_BUILD_TYPE=Release
sudo cmake --build build -j8 --config Release
sudo bash ./models/download-ggml-model.sh large-v3-turbo-q5_0
```

Dann in der Backend-`.env`: `WHISPER_CLI`, `WHISPER_MODEL`, `ANTHROPIC_API_KEY`
(siehe `.env.example`) und `pm2 restart video-cutter-api --update-env`.
`GET /api/health` meldet unter `ai` beides als `true`, wenn alles bereit ist.

Endpunkte: `POST /api/ai/transcribe | subtitles | cuts` (JSON mit `mediaId`) → `202 { jobId }`,
Fortschritt/Ergebnis per SSE `GET /api/ai/jobs/:id/events`, Abbruch `DELETE /api/ai/jobs/:id`.
Höchstens eine Transkription gleichzeitig (belegt `WHISPER_THREADS` Kerne).

## Frontend anbinden

Beim Build der SPA `VITE_API_BASE=/video-cutter` setzen; dann nutzt der
Umschalter „Auf dem Server" die Endpunkte oben. In der Entwicklung proxyt Vite
`/api` automatisch auf `http://localhost:4021`.
