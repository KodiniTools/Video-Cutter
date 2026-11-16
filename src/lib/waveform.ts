/**
 * Verdichtet eine Wellenform (ein Wert 0–255 je Abschnitt) auf `columns`
 * Balken: je Balken der lauteste Wert seines Bereichs, als Anteil 0–1.
 */
export function waveformBars(peaks: Uint8Array | null | undefined, columns: number): number[] {
  const n = Math.max(0, Math.trunc(Number.isFinite(columns) ? columns : 0))
  if (!peaks || peaks.length === 0 || n === 0) return []
  const bars: number[] = []
  for (let c = 0; c < n; c++) {
    const from = Math.floor((c * peaks.length) / n)
    // Mindestens ein Wert je Balken, auch wenn es mehr Balken als Werte gibt.
    const to = Math.max(from + 1, Math.floor(((c + 1) * peaks.length) / n))
    let max = 0
    for (let i = from; i < to && i < peaks.length; i++) if (peaks[i] > max) max = peaks[i]
    bars.push(max / 255)
  }
  return bars
}
