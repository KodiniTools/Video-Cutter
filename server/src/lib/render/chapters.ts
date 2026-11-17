import { MICROS_PER_SECOND, type DocMarker } from './doc'

/** Name des Kapitels vor dem ersten Marker, wenn dieser nicht bei 0 liegt. */
export const FIRST_CHAPTER = 'Anfang'

/** Sonderzeichen des FFMETADATA-Formats maskieren (`=`, `;`, `#`, `\` und Zeilenumbruch). */
function escapeMeta(value: string): string {
  return value.replace(/[=;#\\\n]/g, (c) => `\\${c}`)
}

export interface Chapter {
  /** Beginn und Ende in Millisekunden. */
  start: number
  end: number
  title: string
}

/**
 * Kapitel aus den Markern: Jedes reicht bis zum nächsten Marker, das letzte
 * bis zum Ende. Marker hinter dem Ende entfallen. Liegt der erste Marker nicht
 * am Anfang, kommt ein Kapitel „Anfang“ davor, weil Player sonst den Beginn
 * keinem Kapitel zuordnen. Marker ohne Namen heißen „Kapitel N“.
 */
export function buildChapters(markers: readonly DocMarker[], durationSec: number): Chapter[] {
  const total = Math.round(durationSec * 1000)
  const starts = markers
    .map((m) => ({ start: Math.round(m.at / (MICROS_PER_SECOND / 1000)), title: m.label }))
    .filter((m) => m.start < total)
    .sort((a, b) => a.start - b.start)
    // Zwei Marker in derselben Millisekunde: der erste zählt.
    .filter((m, i, all) => i === 0 || m.start > all[i - 1].start)
  if (starts.length === 0) return []
  if (starts[0].start > 0) starts.unshift({ start: 0, title: FIRST_CHAPTER })
  return starts.map((m, i) => ({
    start: m.start,
    end: i + 1 < starts.length ? starts[i + 1].start : total,
    title: m.title || `Kapitel ${i + 1}`,
  }))
}

/** Inhalt einer FFMETADATA-Datei mit den Kapiteln, oder `null` ohne Kapitel. */
export function chapterMetadata(markers: readonly DocMarker[], durationSec: number): string | null {
  const chapters = buildChapters(markers, durationSec)
  if (chapters.length === 0) return null
  const lines = [';FFMETADATA1']
  for (const c of chapters) {
    lines.push(
      '[CHAPTER]',
      'TIMEBASE=1/1000',
      `START=${c.start}`,
      `END=${c.end}`,
      `title=${escapeMeta(c.title)}`,
    )
  }
  return `${lines.join('\n')}\n`
}
