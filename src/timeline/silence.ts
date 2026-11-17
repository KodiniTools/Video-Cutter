/**
 * Stille in einer Tonspur finden – ohne Server und ohne KI, aus der
 * Wellenform, die der Editor ohnehin lädt (ein Byte je Abschnitt, lauteste
 * Stelle, siehe `derived.ts` auf dem Server).
 */

/** Schwelle im Verhältnis zur lauten Stelle der Aufnahme. */
export const SILENCE_LEVELS = { low: 0.03, normal: 0.06, high: 0.12 } as const
export type SilenceLevel = keyof typeof SILENCE_LEVELS

/** So viel Stille bleibt vor und nach dem Gesprochenen stehen (Sekunden). */
export const SILENCE_KEEP = 0.15

export interface SilenceOptions {
  /** Kürzeste Pause, die als Stille gilt (Sekunden). */
  minLength: number
  /** Empfindlichkeit: `high` wertet auch leises Rauschen als Stille. */
  level?: SilenceLevel
  /** Rest der Pause, der an beiden Rändern stehen bleibt (Sekunden). */
  keep?: number
}

/** Lautstärke, unter der 95 % der Abschnitte liegen: „laut“ ohne einzelne Spitzen. */
function loudLevel(peaks: Uint8Array): number {
  const counts = new Array<number>(256).fill(0)
  for (const p of peaks) counts[p]++
  let seen = 0
  for (let v = 0; v < 256; v++) {
    seen += counts[v]
    if (seen >= peaks.length * 0.95) return v
  }
  return 255
}

/**
 * Stille Bereiche als Zeiten in der Quelle (Sekunden). Als still gilt, was
 * unter einem Anteil der lauten Stellen liegt; gemeldet werden Pausen ab
 * `minLength`, an beiden Rändern um `keep` gekürzt (am Anfang und Ende der
 * Datei nicht). Eine Aufnahme ganz ohne Ton ergibt nichts.
 */
export function findSilences(
  peaks: Uint8Array | null | undefined,
  rate: number,
  opts: SilenceOptions,
): { start: number; end: number }[] {
  if (!peaks || peaks.length === 0 || !(rate > 0)) return []
  const loud = loudLevel(peaks)
  if (loud < 2) return []
  const threshold = Math.max(1, loud * SILENCE_LEVELS[opts.level ?? 'normal'])
  const keep = Math.max(0, opts.keep ?? SILENCE_KEEP)
  const minLength = Math.max(0.1, opts.minLength)
  const out: { start: number; end: number }[] = []
  const close = (from: number, to: number) => {
    if ((to - from) / rate < minLength) return
    const start = from === 0 ? 0 : from / rate + keep
    const end = to === peaks.length ? to / rate : to / rate - keep
    if (end - start > 0.05) out.push({ start, end })
  }
  let from = -1
  for (let i = 0; i < peaks.length; i++) {
    const quiet = peaks[i] <= threshold
    if (quiet && from < 0) from = i
    else if (!quiet && from >= 0) {
      close(from, i)
      from = -1
    }
  }
  if (from >= 0) close(from, peaks.length)
  return out
}
