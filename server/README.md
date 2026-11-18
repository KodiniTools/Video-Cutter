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

**KI-Bilder für Bild-Clips (Gemini):** `GEMINI_API_KEY` in die Backend-`.env` eintragen
(optional `GEMINI_IMAGE_MODEL`, Standard `gemini-nano-banana-2.1`) und neu starten.
`GET /api/health` meldet dann `ai.image: true`. `POST /api/ai/image-prompt` lässt Claude aus
Stichworten, Stil und den Nachbarclips (Standbild + Transkript, falls vorhanden) einen Prompt
schreiben; `POST /api/ai/images { prompt, width, height, count }` erzeugt 1–4 Varianten, die
unter `GET /api/ai/images/:id` 30 Minuten abrufbar sind.
Jedes erzeugte Bild landet zusätzlich dauerhaft in der **Galerie** (`GALLERY_DIR`, Standard
`~/.video-cutter/gallery`, Limit `MAX_GALLERY_TOTAL_MB`): `GET /api/ai/gallery`,
`GET /api/ai/gallery/:id/file|thumb`, `DELETE /api/ai/gallery/:id`.

**KI-Videos (Gemini Omni, gleicher Schlüssel):** `POST /api/ai/video-prompt` (Claude) und
`POST /api/ai/video { prompt, width, height, duration }` (3–15 s, 16:9 oder 9:16). Das Video
kommt als normales Video in die Bibliothek und dauerhaft in die Galerie
(`POST /api/ai/gallery/:id/media` holt es später wieder in die Bibliothek). Modell:
`GEMINI_VIDEO_MODEL` (Standard `gemini-omni-1.2-flash`).

**KI-Sprecher (ElevenLabs):** `ELEVENLABS_API_KEY` in die Backend-`.env` eintragen (optional
`ELEVENLABS_MODEL`, Standard `eleven_multilingual_v2`) und neu starten. `GET /api/health` meldet
dann `ai.voice: true`. `GET /api/ai/voices` listet die Stimmen des Kontos (10 min gemerkt),
`POST /api/ai/voice-over { text, voiceId, speed, stability }` vertont bis 5000 Zeichen als MP3;
die Datei kommt als Tondatei in die Bibliothek. `POST /api/ai/script` lässt Claude einen
Sprechertext schreiben (`mode: write, idea, language, seconds`) oder übersetzen
(`mode: translate, text, language`). Der Schlüssel braucht die Rechte „Text to Speech“ und
„Voices: Lesen“.

**Modellauswahl:** `GET /api/ai/models` liefert die Bild- und Videomodelle, die der Schlüssel
nutzen darf (live von Google, 1 h gemerkt; ohne Verbindung eine feste Ersatzliste).
`POST /api/ai/images` und `POST /api/ai/video` nehmen optional `model` entgegen; ohne Angabe
gilt die Voreinstellung aus der `.env`. Das verwendete Modell steht im Ergebnis und in der Galerie.

## Frontend anbinden

Beim Build der SPA `VITE_API_BASE=/video-cutter` setzen; dann nutzt der
Umschalter „Auf dem Server" die Endpunkte oben. In der Entwicklung proxyt Vite
`/api` automatisch auf `http://localhost:4021`.
