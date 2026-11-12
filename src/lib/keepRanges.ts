/**
 * Client-Gegenstück zu `computeKeepRanges` im Backend (server/src/lib/args.ts).
 * Muss dieselben Bereiche liefern, damit die Einfügestellen angehängter Videos
 * („hinter Ausschnitt n") auf beiden Seiten dieselbe Bedeutung haben.
 */

/** Toleranz in Sekunden für Rand-/Degenerationsfälle (wie im Backend). */
const EPS = 0.05

export interface KeepRange {
  start: number
  duration: number
}

/**
 * Ermittelt die tatsächlich zu BEHALTENDEN Bereiche (Überlappungen
 * zusammengeführt, nach Zeit sortiert):
 * - 'keep':   die Auswahl-Bereiche.
 * - 'remove': das Komplement der Auswahl innerhalb [0, total].
 */
export function computeKeepRanges(
  segments: KeepRange[],
  operation: 'keep' | 'remove',
  total: number,
): KeepRange[] {
  const tot = Number.isFinite(total) ? total : Number.POSITIVE_INFINITY
  const ivs = segments
    .map((r) => {
      const s = Math.max(0, r.start)
      return { s, e: Math.min(s + Math.max(0, r.duration), tot) }
    })
    .filter((iv) => iv.e - iv.s > EPS)
    .sort((a, b) => a.s - b.s)

  const merged: { s: number; e: number }[] = []
  for (const iv of ivs) {
    const last = merged[merged.length - 1]
    if (last && iv.s <= last.e + EPS) last.e = Math.max(last.e, iv.e)
    else merged.push({ ...iv })
  }

  let keep: { s: number; e: number }[]
  if (operation === 'keep') {
    keep = merged
  } else {
    keep = []
    let cursor = 0
    for (const iv of merged) {
      if (iv.s - cursor > EPS) keep.push({ s: cursor, e: iv.s })
      cursor = Math.max(cursor, iv.e)
    }
    if (Number.isFinite(tot) && tot - cursor > EPS) keep.push({ s: cursor, e: tot })
  }

  return keep
    .filter((iv) => iv.e - iv.s > EPS)
    .map((iv) => ({ start: iv.s, duration: iv.e - iv.s }))
}
