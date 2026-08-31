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

| Fall                                        | Weg                              |
| ------------------------------------------- | -------------------------------- |
| behalten · copy · 1 Ausschnitt · MP4/MOV    | **Client-Remux (neu)**           |
| entfernen / mehrere Ausschnitte / Übergänge | Server (concat/xfade, Re-Encode) |
| Modus „genau" (reencode)                    | Server (H.264/AAC bzw. VP9/Opus) |
| WebM/MKV-Quelle                             | Server (anderer Muxer nötig)     |

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

- ✅ Reine Kernlogik inkl. Eignungsprüfung, Fensterwahl und Größen-Guard,
  **Unit-Tests** (`tests/remux.spec.ts`).
- ✅ MP4Box-Remux-Composable mit Fortschritt und Abbruch.
- ✅ **Integrationstest** (`tests/clientRemux.integration.spec.ts`): erzeugt eine
  echte MP4 (H.264 + AAC), schickt sie durch `remux()` und prüft, dass eine
  gültige, kürzere MP4 herauskommt. Läuft in Node und deckt die MP4Box-Anbindung
  ab, die die reinen Unit-Tests nicht erreichen.
- ✅ Integration in `onExport` mit **automatischem Server-Fallback** bei jedem
  Fehler (unbekannter Codec, exotischer Container, Speicher …).
- ✅ **Sichtbarer Nachweis**: Ergebnis wird mit „⚡ Lokal – kein Upload" markiert,
  wenn der Client-Pfad lief (`resultViaClient`). So ist sofort erkennbar, ob der
  Fast-Path griff oder auf den Server ausgewichen wurde.
- ✅ **Größen-Guard** (`MAX_CLIENT_REMUX_BYTES`, 1 GiB): sehr große Dateien
  bleiben am Server (Tab-OOM ist nicht abfangbar).
- ✅ i18n-Status „Lokal schneiden …", Typecheck/Build/Lint/Format grün.

## Nachtrag: „keine Änderung bemerkbar" nach dem Deploy

Erste Rückmeldung nach dem Merge: im Browser sei kein Unterschied spürbar. Das
ist genau das erwartete Bild, wenn der Fast-Path **still auf den Server
zurückfällt** — das Ergebnis ist identisch, nur eben ohne die Beschleunigung.
Gegenmaßnahmen in diesem Follow-up:

- Der **Integrationstest** beweist, dass `remux()` in einem echten JS-Runtime
  aus einer realen MP4 eine gültige, kürzere MP4 erzeugt — die Kernmechanik
  funktioniert also.
- Der **sichtbare „Lokal"-Marker** macht beim nächsten Test eindeutig: erscheint
  er, lief der lokale Schnitt; erscheint er nicht, hat der Fallback gegriffen und
  die Konsole zeigt unter `[client-remux] Fallback auf Server:` den Grund.

Bleibt der Marker im Browser aus, ist als Nächstes zu prüfen: (a) wurde wirklich
der neue Build ausgeliefert (Cache/CDN), (b) war die Testdatei überhaupt
geeignet (MP4/MOV, „behalten", Modus „schnell", ein Ausschnitt, < 1 GiB), (c)
welcher konkrete Fehler steht in der Konsole.

## Bewusste Grenzen (Backlog bis Produktion)

1. **Reale Codec-Vielfalt.** Kern und Anbindung sind getestet (AVC + AAC); HEVC/
   AV1 sowie B-Frames/VFR sollten noch mit echten Clips gegengeprüft werden. Der
   Fallback schützt Nutzer bis dahin.
2. **Speicher.** Datei und Samples liegen komplett im RAM; jenseits von
   `MAX_CLIENT_REMUX_BYTES` bleibt es am Server. Für noch größere lokale Schnitte
   wäre Streaming via `appendBuffer` in Chunks + `releaseUsedSamples` nötig.
3. **Fragmentiertes MP4.** `addSample` erzeugt fMP4. Spielt überall, aber für
   maximale Kompatibilität später optional „flach" (moov+mdat) schreiben.
4. **A/V-Sync am Rand.** Audio wird auf das Video-Keyframe-Fenster genormt; ein
   Versatz ≤ ein Audioframe ist möglich. Bei Bedarf über Edit-Lists (`elst`)
   exakt ausrichten.
5. **Nur ISO-BMFF.** WebM-Client-Remux bräuchte einen Matroska-Muxer — bewusst
   ausgeklammert.

## Empfohlene nächste Schritte

1. Im Browser mit dem sichtbaren Marker verifizieren; bei ausbleibendem Marker
   die drei Punkte aus dem Nachtrag durchgehen (Build/Eignung/Konsolenfehler).
2. Gegentest mit realen Clips (HEVC/AV1, VFR, langes GOP) inkl. Vergleich gegen
   den Server-Output.
3. Optional: Streaming-Parsing für Dateien über dem Größen-Guard.
4. `server/README.md` korrigieren — der dort erwähnte „Browser-Variante
   (FFmpeg.wasm)"-Pfad existierte nie; dieser Remux ist die echte Browser-Route
   für den Copy-Fall.
