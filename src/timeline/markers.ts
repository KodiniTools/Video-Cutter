import { timeToSeconds, type Marker, type Time } from './model'

/** Zeit für eine Kapitelliste: `m:ss`, ab einer Stunde `h:mm:ss`. */
export function chapterTime(at: Time): string {
  const total = Math.floor(timeToSeconds(at))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

/** Marker, die als Kapitel zählen (Takt-Marker nicht). */
export function chapterMarkers(markers: readonly Marker[]): Marker[] {
  return markers.filter((m) => !m.beat)
}

/**
 * Kapitelliste aus den Markern, eine Zeile je Marker („0:00 Name“), so wie
 * Videoplattformen sie in der Beschreibung erwarten. Marker ohne Namen
 * bekommen `fallback` und ihre Nummer.
 */
export function chapterList(markers: readonly Marker[], fallback = 'Kapitel'): string {
  return chapterMarkers(markers)
    .slice()
    .sort((a, b) => a.at - b.at)
    .map((m, i) => `${chapterTime(m.at)} ${m.label || `${fallback} ${i + 1}`}`)
    .join('\n')
}

/** Nächster Marker hinter (`dir` 1) bzw. vor (`dir` −1) der Zeit, sonst `null`. */
export function neighbourMarker(
  markers: readonly Marker[],
  time: Time,
  dir: -1 | 1,
): Marker | null {
  let best: Marker | null = null
  for (const m of markers) {
    if (dir > 0 ? m.at <= time : m.at >= time) continue
    if (!best || (dir > 0 ? m.at < best.at : m.at > best.at)) best = m
  }
  return best
}
