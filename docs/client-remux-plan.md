# Client-seitiger „Copy"-Remux — Plan & Prototyp

Ziel: Den **verlustfreien** Video-Schnitt (`-c copy`) ohne Server erledigen —
analog zum Audio-Cutter, der WAV/MP3 komplett im Browser erzeugt. Für den
häufigsten Fall (ein Ausschnitt behalten) entfällt damit der komplette
Upload **und** Download; die Wartezeit sinkt von „Upload + Serverjob + Download"
auf reines lokales Umschreiben des Containers.

## Warum genau dieser Fall — und nur dieser

Der Server macht bei „behalten + copy + genau ein Ausschnitt" ohnehin **kein
Re-Encoding**, sondern kopiert die bereits kodierten Frames und schneidet am
Keyframe. Genau das kann der Browser selbst (Container neu muxen, Streams
unverändert). Alle anderen Fälle brauchen echtes FFmpeg und bleiben am Server:

| Fall | Weg |
| --- | --- |
| behalten · copy · 1 Ausschnitt · MP4/MOV | **Client-Remux (neu)** |
| entfernen / mehrere Ausschnitte / Übergänge | Server (concat/xfade, Re-Encode) |
| Modus „genau" (reencode) | Server (H.264/AAC bzw. VP9/Opus) |
| WebM/MKV-Quelle | Server (anderer Muxer nötig) |

Der Client-Remux ist damit **reine Beschleunigung**: Er greift nur, wo das
Ergebnis bitgleich zum Server wäre, und weicht bei jedem Problem transparent auf
den Server aus.

## Architektur

Gleiches Muster wie im Rest des Projekts: reine, testbare Logik getrennt von der
Browser-/Bibliotheks-Anbindung.

```
src/lib/remux.ts                 REIN: Eignungsprüfung + keyframe-genaue
                                 Sample-Fenster-Auswahl (voll unit-getestet)
src/composables/useClientRemux.ts  Browser: MP4Box.js-Anbindung (parse →
                                 Samples extrahieren → Fenster kopieren → Blob)
src/types/mp4box.d.ts            Minimales Typ-Shim (mp4box liefert keine Typen)
src/components/VideoTrimmer.vue   onExport: Fast-Path zuerst, sonst Server
tests/remux.spec.ts              Tests der reinen Logik
```

### Ablauf im Prototyp (`useClientRemux.remux`)

1. Datei zu `ArrayBuffer` lesen, mit MP4Box parsen (`onReady` → Track-Infos).
2. Video-Track (und optional Audio-Track) per `setExtractionOptions` +
   `start()` in ihre Samples zerlegen.
3. `selectSampleWindow` bestimmt das **keyframe-ausgerichtete** Fenster:
   Start = letztes Keyframe bei/vor `start`, Ende = letztes Sample `≤ end`
   (identische Semantik zu FFmpeg `-c copy`).
4. Neues `ISOFile`: Tracks via `addTrack` anlegen und dabei die **Original-
   Codec-Konfig-Box** (avcC/hvcC/av1C/esds …) unverändert übernehmen — dadurch
   codec-agnostisch ohne Byte-Frickelei.
5. Samples des Fensters mit auf 0 normierten Zeitstempeln per `addSample`
   kopieren, `getBuffer()` → `Blob('video/mp4')`.

## Was schon steht

- ✅ Reine Kernlogik inkl. Eignungsprüfung und Fensterwahl, **11 Unit-Tests**.
- ✅ MP4Box-Remux-Composable mit Fortschritt und Abbruch.
- ✅ Integration in `onExport` mit **automatischem Server-Fallback** bei jedem
  Fehler (unbekannter Codec, exotischer Container, Speicher …).
- ✅ i18n-Status „Lokal schneiden …", Typecheck/Build/Lint/Format grün.

## Bewusste Grenzen des Prototyps (Backlog bis Produktion)

1. **Browser-Validierung ausstehend.** Die reine Logik ist getestet; die
   MP4Box-Anbindung braucht noch echte Tests im Browser (Chromium/Firefox/
   Safari, iOS) mit AVC-, HEVC- und AV1-Material inkl. B-Frames. Der Fallback
   schützt Nutzer bis dahin.
2. **Speicher.** Datei und Samples liegen komplett im RAM. Für sehr große
   Dateien (mehrere GB) weiterhin Server bevorzugen — sinnvoll wäre eine
   Größen-Schwelle (z. B. `file.size > X` → direkt Server) und/oder Streaming
   via `appendBuffer` in Chunks + `releaseUsedSamples`.
3. **Fragmentiertes MP4.** `addSample` erzeugt fMP4. Spielt überall, aber für
   maximale Kompatibilität später optional „flach" (moov+mdat) schreiben.
4. **A/V-Sync am Rand.** Audio wird auf das Video-Keyframe-Fenster genormt; ein
   Versatz ≤ ein Audioframe ist möglich. Bei Bedarf über Edit-Lists (`elst`)
   exakt ausrichten.
5. **Nur ISO-BMFF.** WebM-Client-Remux bräuchte einen Matroska-Muxer — bewusst
   ausgeklammert.

## Empfohlene nächste Schritte

1. Manuelle Browsertests mit realen Clips (verschiedene Codecs, VFR, langes
   GOP) + Vergleich gegen den Server-Output.
2. Größen-Schwelle + optionaler UI-Hinweis „lokal geschnitten (kein Upload)".
3. Optional: Streaming-Parsing für große Dateien.
4. `server/README.md` korrigieren — der dort erwähnte „Browser-Variante
   (FFmpeg.wasm)"-Pfad existierte nie; dieser Remux ist die echte Browser-Route
   für den Copy-Fall.
