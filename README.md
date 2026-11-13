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

## Design-System, Navigation und Footer

Der Video Cutter nutzt dasselbe Design-System wie der
[Collage Maker](https://github.com/KodiniTools/Collage-Maker):

- **Tokens v2** (`src/design-system/`, CSS-Namespace `--ds-*`): unveränderte
  Kopie aus dem Collage Maker – Palette, Schrift (Supreme, gebündelt unter
  `src/assets/fonts/`), Radien, Motion. Rollen und Regeln:
  `src/design-system/README.md`.
- **Globale Partials** per NGINX-SSI wie im Collage Maker: `index.html` bindet
  `/partials/nav.html`, `/partials/footer.html` und `/partials/cookie-banner.html`
  ein (Nginx: `ssi on;`, siehe `deploy/nginx-video-cutter.conf`). Im Vite-Dev-
  Server bleiben die Includes wirkungslos, Nav und Footer fehlen dort also.
- **Einstellungen** (`src/stores/settings.ts`, Pinia): Theme (Standard Light)
  und Sprache (Standard DE) wie im Collage Maker über `localStorage`
  `theme`/`locale`, `html[data-theme]` und das `locale-changed`-Event der Nav.

## Schnittmodi

- **Schnell (verlustfrei):** `-c copy`, extrem schnell, schneidet an Keyframes.
- **Genau (neu kodieren):** H.264/AAC, frame-genau, langsamer, immer `.mp4`.

## Meine Videos (Video-Bibliothek)

Mehrere Videos lassen sich auf einmal hochladen (Dropzone oder
**„+ Videos hochladen"**). Jedes Video wird **einmal** auf den Server geladen und
dort gespeichert; danach wird es nur noch per ID referenziert – Schneiden und
Zusammenfügen laden nichts erneut hoch.

- **Markieren:** Klick auf ein Video öffnet es im Haupt-Editor.
- **„Schneiden"** wirkt nur auf das markierte Video (Ausschnitte, Bildausschnitt,
  Modus). Das Ergebnis **ersetzt** das Video in der Liste; das alte wird vom
  Server gelöscht. „Herunterladen" speichert das markierte Video.
- **„Zusammenfügen"** verbindet alle angehakten Videos (**„Beim Zusammenfügen
  verwenden"**, max. 6) in Listenreihenfolge, jeweils mit **Von/Bis** gekürzt.
  Das Ergebnis kommt als **neues** Video in die Liste (zunächst nicht angehakt).
- **🗑** löscht ein Video sofort vom Server (ein laufender Upload wird abgebrochen).
- **Auto-Aufräumen:** Videos, die `MEDIA_TTL_SEC` (Standard 2 h) nicht benutzt
  wurden, löscht der Server selbst; Gesamtlimit `MAX_MEDIA_TOTAL_MB`
  (Standard 20 GB, sonst 507). Die Bibliothek liegt im Arbeitsspeicher des
  Servers – ein Neustart des Backends löscht alle gespeicherten Videos.
- **Projekte:** Die Karte „Projekte" speichert den ganzen Bearbeitungsstand
  (Videos, Von/Bis, Auswahl/Ausschnitte, Texte, Formen, Bilder, Musik,
  Ton-Blende, Übergänge, Ausgabeformat) unter einem Namen auf dem Server.
  Das Projekt bekommt eigene Videokopien (Hardlink, sonst Kopie) in
  `PROJECTS_DIR` (Standard `~/.video-cutter/projects`, bewusst außerhalb des
  Backend-Ordners) – Auto-Aufräumen und Neustart betreffen es nicht.
  Öffnen ersetzt die aktuelle Bearbeitung; der Rückgängig-Verlauf beginnt neu.
  Gesamtlimit `MAX_PROJECTS_TOTAL_MB` (Standard 100 GB). Endpunkte:
  `GET/POST /api/projects`, `GET/DELETE /api/projects/:id`,
  `POST /api/projects/:id/open`, `GET/POST /api/projects/:id/assets/:sha256`.

Backend: `POST /api/media` (multipart `video`) → `{ id, name, size, duration,
width, height, hasAudio }`, `GET /api/media/:id`, `GET /api/media/:id/file`,
`DELETE /api/media/:id`. `POST /api/cut` akzeptiert statt Dateien `mediaId` und
`appendMediaIds` (JSON-Array) sowie `storeResult=1` – das Ergebnis wird dann
gespeichert und seine ID im SSE-Ereignis `done` als `mediaId` gemeldet.
Feature `media`.

## Zusammenfügen

Die Liste „Meine Videos" bestimmt die Reihenfolge: am Griff ⠿ per
**Drag & Drop** oder mit ↑/↓ sortieren. Optional gleicht
**„Lautstärke angleichen"** alle Clips per `loudnorm` (EBU R128, −16 LUFS) auf
eine einheitliche Lautheit an. Alles wird serverseitig zu einer Datei
zusammengefügt. Dabei wird immer neu kodiert: Alle Clips werden auf die
Auflösung des ersten Videos skaliert (Letterbox statt Verzerrung), auf 30 fps
und 48 kHz Stereo normiert; Clips ohne Tonspur erhalten Stille. Die gewählte
Animation gilt als Standard-Übergang.

Zwischen je zwei zusammenzufügenden Videos lässt sich ein **eigener Übergang** wählen
(Standard = globale Animation, Keine, Ein-/Ausblenden, Gleiten, Zoomen,
Umklappen). Die Übergangsdauer ist für alle Nahtstellen gleich.

Backend: angehängte Videos als `appendMediaIds` (Bibliothek) oder als
Multipart-Dateien `append`, plus `appendMeta` (JSON, je Video
`{ start, duration?, position, slot? }` – `slot` = hinter dem n-ten
Ausschnitt einfügen) optional `normalizeAudio=1` und `seamTransitions` (JSON-Array je Nahtstelle,
`null` = global; Dauer aus `transitionDuration`). Analyse per `ffprobe`
(`FFPROBE_PATH`, Limit `MAX_APPEND_FILES`). Health meldet
`"features":["crop","append","appendTrim","appendSlots","normalizeAudio","outputFormat","music","seamTransitions","media"]`.
Ein älteres Backend ohne diese Features wird erkannt; der Job wird dann mit
Hinweis abgebrochen statt falsch zusammengefügt.

## Ausgabeformat (16:9 / 9:16 / 1:1)

Das Menü **„Ausgabeformat"** in der Werkzeugleiste stellt das Seitenverhältnis
des Ergebnisses ein: **Original** (wie Hauptvideo bzw. Bildausschnitt),
**16:9**, **9:16** oder **1:1**. Die kurze Kante des Hauptvideos bleibt dabei
erhalten (1920×1080 → 9:16 = 1080×1920). Clips mit anderem Seitenverhältnis
werden wahlweise mit **schwarzen Balken**, auf **unscharfem Hintergrund** oder
**zugeschnitten** eingepasst. Gilt auch ohne angehängte Videos; erzwingt
Re-Encode.

Backend: optionale Felder `outputAspect` (`auto|16:9|9:16|1:1`) und
`outputFill` (`pad|blur|crop`), Feature `outputFormat`.

## Hintergrundmusik

In der Karte **„Hintergrundmusik"** lässt sich eine Audiodatei (oder ein Video
mit Tonspur) unter das gesamte nächste Ergebnis legen (Schneiden oder
Zusammenfügen); danach wird sie zurückgesetzt.
Einstellbar sind die Lautstärke von **Musik** und **Originalton**,
**Ein-/Ausblenden** (2 s) und **Wiederholen**, falls die Musik kürzer ist. Die
Musik endet mit dem Video. Erzwingt Re-Encode.

Backend: optionale Datei `music` (audio/* oder video/*) mit `musicVolume`,
`musicOriginalVolume` (je 0–1), `musicFade`, `musicLoop`; Feature `music`.

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

## Bearbeiten im Kodini Designer

Texte, Titel/Meta und Farben sind ohne Code-Änderung über den
[Kodini Designer](https://github.com/KodiniTools/Kodini-Designer) editierbar.
Grundlage ist die Content-Schicht `src/content/site.json` (leerer Wert =
eingebauter Standard aus `src/i18n.ts` bzw. den Design-Tokens):

| Bereich                 | Felder                                                                                                                                                                     | Wirkung                                                                                                                                                                                           |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `meta`                  | `title`, `description`                                                                                                                                                     | `<title>` und Meta-Beschreibung der `index.html` (Build, `vite.config.ts`)                                                                                                                        |
| `texts.de` / `texts.en` | `app.title`, `app.subtitle`, `drop.title`, `drop.hint`, `footer`                                                                                                           | überschreiben die vue-i18n-Texte (`src/i18n.ts` → `mergeMessages`)                                                                                                                                |
| `theme`                 | `accent`, `playhead`, `light.bg/surface/text`, `dark.bg/surface/text`, `bgImage`, `bgImageOpacity`, `bgImageDarken`, `bgImageBlur`                                         | überschreibt Design-Tokens (`--ds-accent*`, `--ds-surface-0/1`, `--ds-text`) und `--vc-playhead`; fixiertes Hintergrundbild (`body::before`) (Laufzeit, `src/content/site.ts` → `applySiteTheme`) |
| `styles`                | verschachtelt je Text-Slot (`app.title`, `app.subtitle`, `drop.title`, `drop.hint`, `footer`): `font`, `size`, `weight`, `spacing`, `transform`, `colorLight`, `colorDark` | Slot-Design auf `[data-slot="…"]` (`slotCss`, `!important`, `@font-face` aus `/fonts/`)                                                                                                           |

Der Designer schreibt nur diese Datei, baut die Vorschau (`VITE_BASE`,
`VITE_OUT_DIR`) und veröffentlicht per Commit, Push und `deploy/deploy.sh`
(mit `SKIP_API=1`, Frontend-only; ohne sudo, wenn der Webroot beschreibbar ist).
Das Profil dafür liegt im Designer-Repo unter `profiles/video-cutter/`.

## Server-Backend

Der eigentliche Schnitt passiert im VPS-Backend in `server/` (Express + FFmpeg,
Job-basiert mit SSE-Fortschritt).

- Dev: `cd server && npm install && npm run dev` (läuft auf `:9015`, Vite proxyt `/api`).
- Prod-Build der SPA mit `VITE_API_BASE=/video-cutter` (macht `deploy/deploy.sh`).
- Der Backend-Port (`server/.env` → `PORT`) muss mit dem Nginx-Proxy übereinstimmen (`:9015`).
- Deployment + Nginx: siehe `server/README.md`.
- **Nach Änderungen in `server/` muss das Backend mit deployt werden**
  (`bash deploy/deploy.sh` ohne `SKIP_API=1`; der Kodini Designer aktualisiert
  nur das Frontend). Ein veraltetes Backend ignoriert neue Felder wie den
  Bildausschnitt (`crop`); das Frontend bricht den Schnitt dann mit einem
  Hinweis ab. Prüfen: `curl https://kodinitools.com/video-cutter/api/health`
  → `"features":["crop"]`.
