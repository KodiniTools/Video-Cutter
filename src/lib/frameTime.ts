/**
 * Frame-genaue Zeiten (Sekunden) für Cursor und Text-Einblendungen.
 *
 * Regel überall (Vorschau UND Einbrennen): Ein Text ist auf einem Bild mit
 * Zeitstempel t sichtbar, wenn `start <= t < end`. Liegen Von/Bis exakt auf
 * Bildanfängen, ist „Von = Cursor" das erste Bild mit Text und „Bis = Cursor"
 * das erste Bild ohne Text – im Browser wie im eingebrannten Video.
 *
 * Bildzeiten werden auf ganze ms gerundet (Anzeige, Speicherung); das Backend
 * gleicht diese Rundung aus (siehe server/src/lib/textOverlay.ts `assTime`).
 * Ohne bekannte Bildrate (`fps <= 0`) arbeiten alle Funktionen ms-genau.
 */

/** Schritt der Spinner ohne bekannte Bildrate (ms). */
export const FALLBACK_STEP_MS = 10

/**
 * Toleranz in Bildern: ms-gerundete Bildzeiten (z. B. 29,97 fps: 3,2032 s ->
 * 3,203 s) liegen knapp VOR dem echten Bildanfang und zählen trotzdem zu ihm.
 */
const FRAME_EPS = 0.05

function validFps(fps: number): boolean {
  return Number.isFinite(fps) && fps > 0
}

function roundMs(sec: number): number {
  return Math.round(sec * 1000) / 1000
}

/** Index des Bildes, das zum Zeitpunkt `sec` angezeigt wird. */
export function frameIndex(sec: number, fps: number): number {
  if (!validFps(fps)) return 0
  return Math.max(0, Math.floor(Math.max(0, sec) * fps + FRAME_EPS))
}

/** Anfang (ms-gerundet) des Bildes, das bei `sec` zu sehen ist. */
export function snapToFrame(sec: number, fps: number): number {
  const s = Number.isFinite(sec) ? Math.max(0, sec) : 0
  if (!validFps(fps)) return roundMs(s)
  return roundMs(frameIndex(s, fps) / fps)
}

/**
 * Seek-Ziel für ein Bild: die Bildmitte. Ein Seek genau auf den Bildanfang
 * zeigt in manchen Browsern wegen Rundung das vorherige Bild.
 */
export function frameSeekTime(sec: number, fps: number): number {
  if (!validFps(fps)) return Math.max(0, sec)
  return (frameIndex(sec, fps) + 0.5) / fps
}

/**
 * Um `frames` Bilder verschieben (ohne Bildrate: um `frames` × 10 ms) und auf
 * [0, max] begrenzen. Ergebnis liegt auf einem Bildanfang (ms-gerundet).
 */
export function stepFrames(sec: number, frames: number, fps: number, max = Infinity): number {
  const limit = Number.isFinite(max) && max > 0 ? max : Infinity
  if (!validFps(fps)) {
    return roundMs(Math.min(limit, Math.max(0, sec + (frames * FALLBACK_STEP_MS) / 1000)))
  }
  const k = Math.max(0, frameIndex(sec, fps) + frames)
  const t = roundMs(k / fps)
  // Nicht über das Ende hinaus: letzter Bildanfang <= max.
  return t > limit ? snapToFrame(limit, fps) : t
}

/** Anzahl ganzer Bilder zwischen zwei (bildgenauen) Zeiten. */
export function frameCount(start: number, end: number, fps: number): number {
  if (!validFps(fps)) return 0
  return Math.max(0, frameIndex(end, fps) - frameIndex(start, fps))
}
