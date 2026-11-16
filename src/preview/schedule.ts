/**
 * Reine Entscheidungen für den Vorschau-Player: Welche geladenen Abschnitte
 * sind überholt, welche liegen zu weit weg, welcher wird als nächster geholt.
 * Abschnitt `i` steht an Stelle `i` der Liste.
 */

export interface SegmentRef {
  index: number
  start: number
  duration: number
  key: string
}

/** Index des Abschnitts, der die Zeit enthält (am Ende: der letzte); -1 ohne Abschnitte. */
export function segmentIndexAt(segments: readonly SegmentRef[], time: number): number {
  if (!segments.length) return -1
  for (const s of segments) if (time < s.start + s.duration) return s.index
  return segments.length - 1
}

/** Geladene Abschnitte, deren Inhalt nicht mehr zum Plan passt. */
export function staleIndices(
  segments: readonly SegmentRef[],
  loaded: ReadonlyMap<number, string>,
): number[] {
  const out: number[] = []
  for (const [index, key] of loaded) if (segments[index]?.key !== key) out.push(index)
  return out.sort((a, b) => a - b)
}

/** Geladene Abschnitte außerhalb des Fensters um die aktuelle Stelle. */
export function farIndices(
  loaded: ReadonlyMap<number, string>,
  current: number,
  behind: number,
  ahead: number,
): number[] {
  const out: number[] = []
  for (const index of loaded.keys())
    if (index < current - behind || index > current + ahead) out.push(index)
  return out.sort((a, b) => a - b)
}

/**
 * Nächster Abschnitt, der geladen werden soll: der erste ab der aktuellen
 * Stelle, der fehlt – höchstens `ahead` Abschnitte voraus. `skip`: Schlüssel,
 * die fehlgeschlagen sind und nicht erneut versucht werden.
 */
export function nextToLoad(
  segments: readonly SegmentRef[],
  loaded: ReadonlyMap<number, string>,
  current: number,
  ahead: number,
  skip?: ReadonlySet<string>,
): SegmentRef | null {
  const from = Math.max(0, current)
  for (let i = from; i < Math.min(segments.length, from + ahead); i++) {
    const s = segments[i]
    if (loaded.get(i) !== s.key && !skip?.has(s.key)) return s
  }
  return null
}
