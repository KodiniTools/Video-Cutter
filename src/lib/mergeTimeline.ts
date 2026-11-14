import type { SeamPreset } from '@/stores/library'

/** Kürzeste Länge, die ein Clip im Gesamtvideo behält (wie MIN_LENGTH im Store). */
const MIN_SPAN = 0.05

/** Ein Clip für die Zeitleiste des Gesamtvideos. */
export interface TimelineClip {
  /** Verwendete Länge des Clips (Clip ab … Clip bis), Sekunden; 0 = unbekannt. */
  length: number
  /** Gewünschter Beginn im Gesamtvideo (Von); `null` = direkt nach dem vorigen Clip. */
  at: number | null
}

/** Lage eines Clips im Gesamtvideo und was der Server dafür bekommt. */
export interface TimelineEntry {
  /** Von: hier beginnt der Clip im Gesamtvideo (bei Überblendung: Beginn des Übergangs). */
  start: number
  /** Bis: hier endet der eigene Inhalt des Clips im Gesamtvideo. */
  end: number
  /** Tatsächlich verwendete Länge (kürzer, wenn der nächste Clip früher beginnt). */
  used: number
  /** Standbild danach (Sekunden): Lücke bis zum nächsten Clip. */
  hold: number
  /** Frühestmöglicher Beginn (direkt nach dem Beginn des vorigen Clips). */
  minStart: number
}

/**
 * Überlappung je überblendender Nahtstelle, wie der Server sie rechnet
 * (`effectiveTransition`/`resolveSeams`): die Hälfte der eingestellten
 * Übergangsdauer, begrenzt durch den kürzesten Clip; unter 0,1 s keine.
 */
export function seamOverlap(spans: number[], duration: number): number {
  if (spans.length < 2) return 0
  const minLen = Math.min(...spans)
  const cap = spans.length > 2 ? minLen / 2 : minLen
  const d = Math.min(duration / 2, Math.max(0, cap - 0.05))
  return d >= 0.1 ? d : 0
}

/** Überlappen sich die Clips an dieser Nahtstelle? (harter Schnitt und Dip to Black nicht) */
function overlaps(preset: SeamPreset): boolean {
  return preset !== 'none' && preset !== 'fade'
}

function layout(clips: TimelineClip[], ov: number[]): TimelineEntry[] {
  const out: TimelineEntry[] = []
  clips.forEach((c, i) => {
    if (i === 0) {
      out.push({ start: 0, end: c.length, used: c.length, hold: 0, minStart: 0 })
      return
    }
    const prev = out[i - 1]
    const prevLen = clips[i - 1].length
    const natural = prev.start + prevLen - ov[i - 1]
    const minStart = prev.start + MIN_SPAN
    const start = Math.max(minStart, c.at ?? natural)
    // Vorigen Clip anpassen: bis hierher (+ Überlappung) laufen lassen, also
    // kürzen oder mit Standbild verlängern.
    const span = start + ov[i - 1] - prev.start
    prev.used = Math.min(prevLen, span)
    prev.hold = Math.max(0, span - prevLen)
    prev.end = prev.start + prev.used
    out.push({ start, end: start + c.length, used: c.length, hold: 0, minStart })
  })
  return out
}

/**
 * Zeitleiste des Gesamtvideos: Von/Bis jedes Clips, wie lang er verwendet wird
 * und wie lange sein letztes Bild in einer Lücke stehen bleibt. Gleiche
 * Überblend-Rechnung wie der Server. `seams` = Übergang je Nahtstelle
 * (`null` = global). `null`, solange eine Länge unbekannt ist.
 */
export function mergeTimeline(
  clips: TimelineClip[],
  seams: (SeamPreset | null)[],
  globalPreset: SeamPreset,
  duration: number,
): { entries: TimelineEntry[]; total: number } | null {
  if (!clips.length || clips.some((c) => !(c.length > 0))) return null
  const presets = clips.slice(1).map((_, k) => seams[k] ?? globalPreset)
  const animated = presets.some((p) => p !== 'none')
  const ovFor = (d: number) => presets.map((p) => (overlaps(p) ? d : 0))
  // Der Server begrenzt die Überblendung über die tatsächlichen Clip-Längen
  // (inkl. Kürzung/Standbild) – zweimal nachrechnen, bis es zusammenpasst.
  let d = animated
    ? seamOverlap(
        clips.map((c) => c.length),
        duration,
      )
    : 0
  let entries = layout(clips, ovFor(d))
  for (let k = 0; k < 2 && animated; k++) {
    const next = seamOverlap(
      entries.map((e) => e.used + e.hold),
      duration,
    )
    if (Math.abs(next - d) < 1e-6) break
    d = next
    entries = layout(clips, ovFor(d))
  }
  const last = entries[entries.length - 1]
  return { entries, total: last.end }
}
