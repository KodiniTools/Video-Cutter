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
- **Tempo** je Video in der Liste: Stufe −2,5 … +2,5 (0 = normal, +1 = 2×,
  −1 = 0,5×, +2,5 = 3,5×, −2,5 ≈ 0,29×). Wirkt echt beim Zusammenfügen
  (`setpts` + `atempo`, Tonhöhe bleibt) und in der Vorschau; Editor- und
  Zeilen-Player spielen im eingestellten Tempo. Von/Bis rechnen mit der
  Länge nach dem Tempo.
- **Karte „Tempo“** (eigenständig): ganzes markiertes Video schneller oder
  langsamer machen, ohne Schneiden/Zusammenfügen. Gleiche Skala; der Player
  zeigt das Tempo sofort, „Tempo anwenden“ ersetzt das Video (rückgängig
  machbar), danach „Herunterladen“. Server-Feld `speed` an `/api/cut`.
- **🔇 Stumm** je Video in der Liste: Editor- und Zeilen-Player spielen ohne
  Ton; beim Zusammenfügen/in der Vorschau wird der Ton des Clips durch Stille
  ersetzt (Übergänge, Musik, Lautstärke-Angleichung bleiben). „Schneiden“ und
  „Herunterladen“ liefern das Video ohne Tonspur (mit Musik: nur die Musik).
  Projekte und Rückgängig speichern die Einstellung. Server-Felder `mute`
  bzw. `appendMeta[].mute`, Feature `clipMute`.
- **🗑** löscht ein Video sofort vom Server (ein laufender Upload wird abgebrochen).
- **Auto-Aufräumen:** Videos, die `MEDIA_TTL_SEC` (Standard 2 h) nicht benutzt
  wurden, löscht der Server selbst; Gesamtlimit `MAX_MEDIA_TOTAL_MB`
  (Standard 20 GB, sonst 507).
- **Neustart:** Der Server führt ein Verzeichnis der Bibliothek
  (`MEDIA_INDEX_FILE`, Standard `<TMP_DIR>/media-index.json`). Nach einem
  Neustart des Backends (z. B. Deploy) sind die Videos unter derselben ID wieder
  da; die Frist fürs Auto-Aufräumen läuft weiter. `MEDIA_INDEX_FILE=` (leer)
  schaltet das ab – dann löscht ein Neustart alle gespeicherten Videos.
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

## Neuer Timeline-Editor (in Arbeit)

Die App wird schrittweise zu einem Video-Editor mit Mehrspur-Timeline umgebaut.
Der bisherige Editor bleibt dabei unter `/` unverändert der Standard.

- **Routen** (`src/router/`): `/` bisheriger Editor, `/editor` neuer Editor (Beta).
  Unbekannte Adressen führen zu `/`.
- **Freischalten** von `/editor`: Knopf „Neuer Editor (Beta)“ in der Kopfzeile
  (merkt sich die Freischaltung im Browser unter `videoCutter.timelineEditor`)
  oder Build-Variable `VITE_TIMELINE_EDITOR=1`. Ohne Freischaltung leitet
  `/editor` auf `/` um.
- **Timeline-Ansicht** (`src/components/timeline/TimelineView.vue`): „+ Timeline“
  in der Medienliste hängt ein Video hinten an (Bild auf V1, Ton verknüpft auf
  A1). Lineal-Klick setzt den Abspielkopf, Zoom per Knopf oder Strg+Mausrad.
- **Bearbeiten**: Clips ziehen (auch auf eine andere Spur gleicher Art), an den
  Rändern trimmen, am Abspielkopf teilen, löschen. Tasten (Timeline fokussiert):
  `S` teilen, `Entf` löschen, `Umschalt+Entf` löschen und Lücke schließen,
  `Strg+Z` / `Strg+Umschalt+Z` rückgängig/wiederholen, `Strg+A` alles markieren,
  `←`/`→` ein Bild (mit Umschalt 1 s), `Pos1`/`Ende`, `Esc` bricht das Ziehen ab.
- **Spuren**: „+ Video-Spur“ (oben, im Bild vorn) und „+ Ton-Spur“ (unten). Im
  Spurkopf: Doppelklick benennt um, dazu nach oben/unten, sperren,
  stummschalten bzw. ausblenden, entfernen (rückgängig machbar).
- **Compiler** (`server/src/lib/render/`): `parseTimelineDoc` prüft das vom
  Editor geschickte Dokument (Grenzen, Regeln), `compileTimeline` übersetzt es
  ganz oder abschnittsweise in einen FFmpeg-Aufruf (je Spur Clips und Lücken
  verkettet, Video-Spuren per `overlay` gestapelt, Ton per `amix`, alles auf
  dem Bildraster). Vorschau und Export nutzen denselben Code.
- **Server-Vorschau** (`server/src/lib/render/preview.ts`, Feature
  `timelinePreview`): `POST /api/preview/plan` (`{ doc, at }`) teilt die
  Timeline in 4-s-Abschnitte (höchstens 540 px hoch) und reiht fehlende ab dem
  Abspielkopf zum Rendern ein. Jeder Abschnitt hat einen Schlüssel aus seinem
  Inhalt: Nach einer Änderung werden nur betroffene Abschnitte neu gerendert,
  überholte abgebrochen. `GET /api/preview/segment/:key` liefert den Abschnitt
  (fragmentiertes MP4) und wartet bis zu 25 s darauf, `GET /api/preview/stats`
  zeigt Renderzeiten. Einstellungen: `PREVIEW_DIR`, `PREVIEW_CACHE_MB`,
  `PREVIEW_CONCURRENT`, `PREVIEW_THREADS`, `PREVIEW_TIMEOUT_SEC`.
- **Vorschau-Player** (`src/components/timeline/PreviewPlayer.vue`,
  `src/preview/`): hängt die Abschnitte des Servers über Media Source
  Extensions zu einem durchgehenden Film aneinander (Abspielen/Pause mit der
  Leertaste oder Klick aufs Bild, der Abspielkopf folgt). Nach einer Änderung
  holt er einen neuen Plan und ersetzt nur Abschnitte mit geändertem Schlüssel;
  geladen wird ab dem Abspielkopf etwa 20 s voraus. Im Browser wird nichts
  gerechnet.
- **Export** (`server/src/routes/render.ts`, Feature `timelineRender`,
  `src/components/timeline/ExportDialog.vue`): `POST /api/render`
  (`{ doc, quality, name }`) rendert die ganze Timeline in voller Größe aus den
  Originalen (H.264 + AAC, MP4; Qualität `high`/`standard`/`small` = CRF
  18/21/26) mit demselben Compiler wie die Vorschau. Fortschritt, Download und
  Abbrechen laufen über die Job-Endpunkte `/api/cut/:id/…`; es gelten
  `MAX_CONCURRENT` und `MAX_DURATION_SEC`.
  `normalizeAudio: true` gleicht die Lautstärke des fertigen Tons an
  (`loudnorm`, −16 LUFS; nur im Export, Feature `timelineNormalize`).
- **Formen, Symbole, Emojis** (Feature `timelineGraphics`): „+ Form / Emoji“
  legt einen Grafik-Clip auf eine Ebenen-Spur; Einstellungen im Feld daneben
  (`GraphicInspector.vue`). Im Dokument stehen nur die Einstellungen. Vor
  Vorschau und Export zeichnet der Browser je Aussehen ein PNG, lädt es einmal
  hoch (`POST /api/graphics`, ID = Hash des Inhalts) und schreibt die ID in die
  gesendete Kopie (`src/timeline/graphics.ts`). Der Compiler legt die Bilder per
  `overlay` unter die Texte, mit denselben Animationen wie der bisherige
  Editor. Fehlt ein Bild auf dem Server (`missingGraphics` im Plan, 409 beim
  Export), lädt der Editor es erneut hoch. Einstellungen: `GRAPHICS_DIR`,
  `GRAPHICS_CACHE_MB`.
- **Eigene Bilder**: „+ Bild“ lädt JPEG, PNG oder WebP in den Browser
  (`imageAssets`, wie im bisherigen Editor) und legt einen Grafik-Clip der Art
  `image` an. Breite, Drehung, Rahmen, Ecken, Deckkraft, Zuschnitt, Spiegeln
  und Schatten im selben Feld; der Server bekommt wie bei Formen nur das fertig
  bearbeitete PNG. Die Originale liegen im Browser und werden mit dem Projekt
  gespeichert.
- **Clip-Einstellungen** (`ClipInspector.vue`): Ist ein Video- oder Ton-Clip
  (bzw. ein verknüpftes Paar) markiert, zeigt die Seitenleiste das Feld „Clip“
  mit Tempo (Stufen wie im bisherigen Editor, 0,29× bis 3,5×; gilt für Bild
  und verknüpften Ton, Befehl `setClipSpeed`) und Lautstärke des Ton-Clips
  (0–200 %, `setClipGain`). Das Tempo ändert die Länge des Clips, der
  Quellbereich bleibt; „Folgende Clips mitverschieben“ rückt Späteres auf
  allen nicht gesperrten Spuren mit. Unter „Zuschneiden“ nehmen vier Regler
  (links, rechts, oben, unten) Ränder des Videos weg (`setClipCrop`,
  mindestens 10 % bleiben sichtbar); der Rest wird ins Projektformat
  eingepasst. Der Compiler kannte Tempo, Lautstärke und Zuschnitt bereits.
  „Ton-Blende“ (Feature `timelineAudioFade`, `setClipFade`) blendet den Ton
  am Anfang bzw. Ende des Ton-Clips (bis 10 s je Seite, Kurven wie im
  bisherigen Editor; Felder `fadeIn`/`fadeOut` am Clip). Der Compiler setzt
  `afade` mit Zeiten im Clip (`clipFadeFilters`), damit eine Blende über
  Abschnittsgrenzen der Vorschau hinweg wie im Export klingt. Beim Teilen
  bleibt die Einblendung am ersten, die Ausblendung am letzten Teil.
- **Verlustfreier Export** (Feature `timelineLossless`): Im Export-Dialog
  gibt es neben den Qualitätsstufen „Verlustfrei (ohne Neu-Kodieren)“. Das
  geht nur im einfachsten Fall: genau ein Video-Clip ab Zeit 0 in
  Originalgröße, ohne Tempo, Zuschnitt, Texte oder Grafiken, und der Ton ist
  der unveränderte Ton dieses Clips oder fehlt ganz. Sonst nennt der Dialog
  den Grund. Dieselbe Prüfung steht im Editor (`src/timeline/lossless.ts`)
  und im Server (`server/src/lib/render/lossless.ts`, maßgeblich);
  `POST /api/render` mit `lossless: true` kopiert dann mit `-c copy` in den
  Container der Quelle und antwortet mit `lossless: true`, andernfalls 422
  mit `losslessBlocker`. Wie beim bisherigen verlustfreien Schneiden beginnt
  die Kopie am Schlüsselbild vor dem Schnitt.
- **Bild-Clip, KI-Bild, KI-Video** (`StillClipForm.vue` in der Medienliste):
  Ein Bild (hochgeladen, mit KI erzeugt oder aus der KI-Galerie) oder nur
  eine Farbe wird über `POST /api/media/still` zu einem Video im
  Projektformat und kommt in die Medienliste (`mediaPool.addMedia`). Der
  Editor schickt `audio=0` (Feature `stillNoAudio`): Der Clip hat dann keine
  stille Tonspur, und auf der Timeline entsteht kein leerer Ton-Clip. KI-Videos
  und Galerie-Videos liegen schon auf dem Server und werden direkt
  aufgenommen. Der KI-Bereich ist die Komponente des bisherigen Editors
  (`StillAiImage.vue`). Grenze: Ein Bild-Clip wird nicht länger als beim
  Erstellen eingestellt (höchstens 600 s).
- **Musik und Tondateien** (Feature `mediaAudio`): `POST /api/media` nimmt
  auch Tondateien an (MP3, M4A, WAV, OGG, FLAC …). Die Antwort trägt dann
  `kind: 'audio'`; ein Titelbild in der Datei zählt nicht als Bild
  (`hasVideo` in `probe.ts`). In der Medienliste erscheinen sie mit Note und
  Wellenform. „+ Timeline“ legt eine Tondatei auf eine eigene Musik-Spur ab
  Zeit 0, weitere dahinter (`appendMedia`, `isMusicTrack`); Videos weichen
  Musik-Spuren aus, und das erste Video bestimmt weiterhin das Projektformat.
  Lautstärke, Ton-Blende, Tempo, Teilen und Kürzen gelten wie bei jedem
  Ton-Clip. Der bisherige Editor und das Einbrennen lehnen Tondateien ab.
  **Schleife:** „Bis zum Ende wiederholen“ im Feld „Clip“ (`repeatClip`,
  `repeatLimit`) legt Kopien eines eigenständigen Ton-Clips direkt dahinter,
  bis zum Ende der übrigen Spuren (höchstens bis zum nächsten Clip der Spur);
  die letzte Kopie wird gekürzt, die Ausblendung wandert ans Ende. Die Kopien
  sind gewöhnliche Clips, der Server braucht dafür nichts Neues.
- **Übergänge** (Feature `timelineTransitions`): Ein Video-Clip kann mit
  einem Übergang beginnen (`transitionIn: { preset, duration }`, Arten wie im
  bisherigen Editor: `fade`, `slide`, `scale`, `flip`; `setClipTransition`,
  Feld „Übergang am Anfang“ im Bereich „Clip“, Marke am Clip-Anfang). Zeiten
  auf der Timeline ändern sich nicht, Clips überlappen nie. `duration` ist die
  Gesamtdauer: Bei `fade` blendet der vorige Clip in der ersten Hälfte aus und
  dieser in der zweiten ein (unterste Spur über die Hintergrundfarbe, höhere
  Spuren durchsichtig). Die übrigen laufen in der halben Dauer per `xfade`
  über dem angehaltenen letzten Bild des vorigen Clips, nach einer Lücke aus
  dem Hintergrund. Der Compiler rechnet mit Zeiten im Clip, damit ein
  Übergang über Abschnittsgrenzen der Vorschau wie im Export aussieht.
  Übergänge aus Projekten des bisherigen Editors werden übernommen. Der Ton
  wird nicht automatisch geblendet, dafür gibt es die Ton-Blende je Clip.
- **Standbild in der Lücke** (Feature `timelineHold`): Mit „Letztes Bild
  halten bis zum nächsten Clip“ (`hold` am Video-Clip, `setClipHold`) zeigt
  die Lücke hinter einem Clip sein letztes Bild statt des Hintergrunds, bis
  der nächste Clip derselben Spur beginnt. Ein Übergang des nächsten Clips
  setzt am Standbild an. Beim Teilen bleibt die Einstellung am letzten Teil.
  Standbilder aus Projekten des bisherigen Editors werden so übernommen.
- **Farbkorrektur** (Feature `timelineColor`): Ein Video-Clip kann Helligkeit,
  Kontrast und Sättigung tragen (`color: { brightness, contrast, saturation }`,
  je −1 … 1, 0 = unverändert; `setClipColor`, Feld „Clip“). Der Compiler setzt
  dafür `eq` vor das Einpassen (`colorFilter` in `compile.ts`: Helligkeit ±0,4,
  Kontrast 0,4–1,6, Sättigung 0–2). Verlustfrei ist damit ausgeschlossen.
- **Bild-in-Bild** (Feature `timelineLayout`): Ein Video-Clip kann eine Lage
  im Bild tragen (`layout: { x, y, scale, opacity }`, `setClipLayout`,
  Feld „Clip“): `scale` ist der Anteil des Projektformats, in den das Bild
  eingepasst wird, `x`/`y` die Mitte, `opacity` die Deckkraft. Das Bild bleibt
  immer ganz im Projektformat; Knöpfe legen es in eine Ecke. Darunter ist zu
  sehen, was auf den Video-Spuren weiter unten liegt, auf der untersten Spur
  der Hintergrund. Der Compiler passt den Clip in den verkleinerten Rahmen
  ein und füllt den Rest durchsichtig (`fitSteps` in `compile.ts`); Übergänge
  und Standbild gelten weiter. Verlustfrei ist damit ausgeschlossen. Ein
  verkleinerter Clip lässt sich in der Vorschau ziehen (`PositionFrame.vue`,
  `layoutBox` in `src/timeline/positionFrame.ts` rechnet den Rahmen wie der
  Server); der Griff unten rechts ändert die Größe.
- **KI-Assistent** (`AiInspector.vue`, `src/stores/timelineAi.ts`,
  `src/timeline/subtitles.ts`): Für den markierten Clip mit Ton erzeugt
  „Untertitel erzeugen“ Text-Clips auf einer Ebenen-Spur. Dazu laufen die
  bestehenden Aufträge `/api/ai/transcribe` und `/api/ai/subtitles` für das
  Medium des Clips; die Zeiten der Quelle werden über Beginn, Quell-Beginn
  und Tempo des Clips auf die Timeline umgerechnet (`cuesToClips`), Texte
  außerhalb des Clips entfallen. Alle Untertitel landen gemeinsam auf einer
  Spur (`insertOverlayClips`) und sind ein Rückgängig-Schritt. „Texte
  übersetzen“ ersetzt alle Texte auf nicht gesperrten Spuren
  (`/api/ai/translate`). „Schnittvorschläge“ (`/api/ai/cuts`,
  `src/timeline/cutSuggestions.ts`) listet Füllwörter, Versprecher,
  Wiederholungen und Pausen des markierten Clips mit den Zeiten der Timeline;
  ein Klick springt zur Stelle. „Herausschneiden und Lücken schließen“
  (`cutClipRanges`) teilt den Clip an den Rändern der angehakten Bereiche,
  löscht sie samt verknüpftem Ton und rückt alles Spätere nach, in einem
  Rückgängig-Schritt. „Stille finden“ (`src/timeline/silence.ts`,
  `suggestSilence`) trägt Pausen in dieselbe Liste ein, ohne KI und ohne
  Server: aus der Wellenform des Mediums (50 Werte je Sekunde), mit einer
  Schwelle im Verhältnis zur Lautstärke der Aufnahme (drei Stufen), ab der
  Mindestlänge „Pausen ab“; 0,15 s bleiben vor und nach dem Gesprochenen
  stehen. Nur Frontend.
- **Projekte** (Feature `timelineProjects`, `ProjectDialog.vue`,
  `src/stores/timelineProjects.ts`, `src/timeline/projectFile.ts`): Der Knopf
  „Projekt“ speichert das Dokument über die bestehenden Endpunkte
  `/api/projects` (Stand `{ format: 'timeline', version: 2, doc, images }`),
  dazu die Videos (eigene Kopie im Projektordner) und die Originale der
  Bild-Clips als Zusatzdateien (SHA-256). Die Projektliste nennt je Projekt
  `kind` (`classic` | `timeline`); jeder Editor zeigt nur seine eigenen. Beim
  Öffnen meldet der Server die Videos neu an (neue IDs), der Editor schreibt
  das Dokument darauf um; was fehlt, wird ausgelassen und gemeldet.
  Projekte der bisherigen App stehen mit in der Liste („bisheriger Editor“) und
  werden beim Öffnen umgewandelt (`src/timeline/convertClassic.ts`): verwendete
  Videos in Listenreihenfolge auf V1 (Von/Bis, Tempo, „Von im Gesamtvideo“ wie
  beim Zusammenfügen), Ton verknüpft auf A1 (stumme ohne Ton-Clip), Texte und
  Grafiken je Video als Clips auf Ebenen-Spuren mit umgerechneten Zeiten. Das
  gespeicherte Projekt bleibt unverändert; das Ergebnis ist ein neues,
  ungespeichertes Projekt. Der Zuschnitt des markierten Videos wird zum
  Zuschnitt seines Clips, die Ton-Blende zur Einblendung des ersten und
  Ausblendung des letzten Ton-Clips. Die Hintergrundmusik wird beim Öffnen
  als Medium hochgeladen und liegt ab 0 auf einer eigenen Ton-Spur: mit ihrer
  Lautstärke, auf die Länge des Videos gekürzt oder in Schleife gelegt, auf
  Wunsch mit 2 s Ein-/Ausblendung; die Lautstärke des Originaltons geht an
  die übrigen Ton-Clips. Lässt sie sich nicht laden (fehlt, oder das Backend
  kennt `mediaAudio` nicht), nennt der Dialog sie als nicht übernommen.
  **Automatisches Speichern:** Ein geöffnetes (bereits gespeichertes) Projekt
  wird 3 s nach der letzten Änderung von selbst überschrieben (abschaltbar im
  Dialog, der Browser merkt es sich). Nicht bei neuen Projekten ohne Namen und
  nicht, wenn beim Öffnen Dateien fehlten (sonst würde der Verlust
  festgeschrieben). Bei ungespeicherten Änderungen fragt der Browser vor dem
  Verlassen der Seite nach.
- **Positionsrahmen** (`PositionFrame.vue`, `src/timeline/positionFrame.ts`):
  Der markierte Text, die Form oder das Bild hat im Vorschaubild einen Rahmen
  zum Ziehen (mit Umschalttaste fein) bzw. Verschieben mit den Pfeiltasten
  (0,5 %, mit Umschalttaste 5 %). Während des Ziehens zeigt der Rahmen bei
  Formen und Bildern eine blasse Kopie; erst das Loslassen ändert das Dokument
  (ein Rückgängig-Schritt, ein neuer Vorschau-Abschnitt).
- **Ton lösen / Verbinden**: Bild und Ton eines Videos sind verknüpft
  (`linkGroup`). „Ton lösen“ (`unlinkClips`) trennt die markierten Clips, danach
  lassen sich Bild und Ton einzeln markieren, verschieben, kürzen und löschen.
  Mehrere markierte Clips (Strg/Umschalt + Klick) verbindet „Verbinden“
  (`linkClips`) wieder.
- **Layout**: Vorschau und Timeline stehen gleich breit direkt untereinander
  und bleiben beim Scrollen stehen; die Seitenleiste (Medien, Einstellungen)
  scrollt für sich.
- **Texte** (Feature `timelineText`): „+ Text“ legt am Abspielkopf einen
  Text-Clip auf eine Ebenen-Spur (`insertOverlayClip`, bei Bedarf entsteht
  eine). Länge und Zeitpunkt wie bei jedem Clip in der Timeline; Inhalt,
  Schrift, Größe, Farben, Stil, Animation und Position im Feld „Text
  bearbeiten“ (`TextInspector.vue`, `updateClipData`). Der Compiler brennt die
  Texte mit denselben Regeln wie der bisherige Editor ein (ASS/libass) und legt
  sie über alle Video-Spuren; die Datei nennt Zeiten der ganzen Timeline,
  sodass Animationen über Abschnittsgrenzen der Vorschau nahtlos laufen.
- **Projektformat** (`ProjectSettings.vue`, Modell `updateSettings`): Größe
  (u. a. 16:9, 9:16, 1:1, 4:5), Bildrate und Hintergrundfarbe oben im Editor,
  rückgängig machbar. Das erste Video legt das Format fest; Clips anderer
  Größe werden eingepasst, Ränder zeigen den Hintergrund.
- **Datenmodell** (`src/timeline/model/`): reines TypeScript ohne Vue. Zeiten sind
  ganze Mikrosekunden, Clips einer Spur überlappen nicht, alle Befehle
  (`insertClip`, `moveClip`, `trimClip`, `splitClip`, `removeClip` mit Ripple,
  Einrasten) liefern ein neues Dokument oder einen Ablehnungsgrund.
  Tests: `tests/timelineModel.spec.ts`.
- **Store** (`src/stores/timeline.ts`): hält das Dokument, Auswahl, Abspielkopf,
  Zoom und den Rückgängig-Verlauf (höchstens 200 Schritte; eine Geste zwischen
  `beginGesture` und `endGesture` zählt als ein Schritt).
  Tests: `tests/timeline.store.spec.ts`.
- **Medienliste** (`src/components/timeline/MediaPool.vue`, Store
  `src/stores/mediaPool.ts`): Videos hochladen (auch per Ziehen), als Medien im
  Timeline-Dokument anmelden, Vorschaubild aus dem Filmstreifen, Wellenform und
  Stand der Vorbereitung anzeigen, entfernen (nicht, solange ein Clip das Video
  verwendet). Tests: `tests/mediaPool.spec.ts`, `tests/derivedApi.spec.ts`.
- **Abgeleitete Dateien** (`server/src/lib/derived.ts`, Feature `mediaDerived`):
  Je Video erzeugt der Server auf Abruf eine Wellenform (ein Byte je 20 ms),
  einen Filmstreifen (Kachelbild, höchstens 200 Bilder) und eine Vorschau-Kopie
  (höchstens 540 Zeilen, dichte Schlüsselbilder). Immer nur eine Berechnung zur
  Zeit, im Hintergrund; gelöscht werden sie mit dem Video.
  `POST /api/media/:id/derived` startet, `GET /api/media/:id/derived` zeigt den
  Stand, `GET /api/media/:id/peaks | strip | proxy` liefert die Dateien.
  Einstellungen: `DERIVED_DIR`, `DERIVED_THREADS`, `DERIVED_TIMEOUT_SEC`.
