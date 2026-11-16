import { MICROS_PER_SECOND, type Time } from './model'

/**
 * Umrechnung zwischen Zeit und Pixeln sowie die Beschriftung des Lineals.
 * `zoom` ist immer Pixel je Sekunde.
 */

export function timeToPx(time: Time, zoom: number): number {
  return (time / MICROS_PER_SECOND) * zoom
}

/** Pixel → Zeit (ganze Mikrosekunden, nie negativ). */
export function pxToTime(px: number, zoom: number): Time {
  if (!(zoom > 0) || !Number.isFinite(px)) return 0
  return Math.max(0, Math.round((px / zoom) * MICROS_PER_SECOND))
}

/** Mögliche Abstände der beschrifteten Lineal-Striche in Sekunden. */
const TICK_STEPS = [
  0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400,
]
/** So weit müssen beschriftete Striche mindestens auseinander liegen (px). */
const MIN_LABEL_GAP = 80

export interface RulerTick {
  time: Time
  /** Beschriftung; leer bei Zwischenstrichen. */
  label: string
  major: boolean
}

/** Abstand der beschrifteten Striche für diesen Zoom (Sekunden). */
export function tickStep(zoom: number): number {
  const z = zoom > 0 ? zoom : 1
  return TICK_STEPS.find((s) => s * z >= MIN_LABEL_GAP) ?? TICK_STEPS[TICK_STEPS.length - 1]
}

/** Beschriftung eines Strichs: `m:ss`, ab einer Stunde `h:mm:ss`, bei feinem Raster mit Zehnteln. */
export function formatRulerLabel(seconds: number, step: number): string {
  const tenths = Math.round(seconds * 10)
  const whole = Math.floor(tenths / 10)
  const sec = whole % 60
  const min = Math.floor(whole / 60) % 60
  const hours = Math.floor(whole / 3600)
  const pad = (n: number) => String(n).padStart(2, '0')
  const base = hours > 0 ? `${hours}:${pad(min)}:${pad(sec)}` : `${min}:${pad(sec)}`
  return step < 1 ? `${base}.${tenths % 10}` : base
}

/**
 * Striche des Lineals zwischen `from` und `to`: beschriftete Hauptstriche im
 * Abstand `tickStep`, dazwischen vier unbeschriftete Zwischenstriche.
 */
export function rulerTicks(zoom: number, from: Time, to: Time): RulerTick[] {
  const step = tickStep(zoom)
  const minor = step / 5
  const first = Math.max(0, Math.floor(from / MICROS_PER_SECOND / minor))
  const last = Math.ceil(Math.max(from, to) / MICROS_PER_SECOND / minor)
  const ticks: RulerTick[] = []
  for (let i = first; i <= last; i++) {
    const major = i % 5 === 0
    // Über den Index rechnen, damit sich keine Rundungsfehler aufsummieren.
    const seconds = Math.round(i * minor * 1000) / 1000
    ticks.push({
      time: Math.round(seconds * MICROS_PER_SECOND),
      label: major ? formatRulerLabel(seconds, step) : '',
      major,
    })
  }
  return ticks
}

/** Zoom, bei dem `duration` in `width` Pixel passt (mit etwas Rand rechts). */
export function fitZoom(duration: Time, width: number, min: number, max: number): number {
  if (!(duration > 0) || !(width > 0)) return Math.min(max, Math.max(min, 100))
  const zoom = (width * 0.95) / (duration / MICROS_PER_SECOND)
  return Math.min(max, Math.max(min, zoom))
}

export interface ThumbSlot {
  /** Linke Kante im Clip (px). */
  left: number
  /** Index des Bildes im Filmstreifen. */
  index: number
}

/**
 * Vorschaubilder entlang eines Video-Clips: lückenlos nebeneinander, jedes
 * zeigt die Stelle der Quelle an seiner linken Kante. Sehr breite Clips
 * bekommen höchstens `maxThumbs` Bilder in größeren Abständen.
 */
export function clipThumbs(opts: {
  clipWidth: number
  thumbWidth: number
  zoom: number
  sourceIn: Time
  speed: number
  /** Abstand der Bilder im Filmstreifen (Sekunden). */
  interval: number
  count: number
  maxThumbs?: number
}): ThumbSlot[] {
  const { clipWidth, thumbWidth, zoom, sourceIn, speed, interval, count } = opts
  if (!(clipWidth > 0) || !(thumbWidth > 0) || !(zoom > 0) || !(interval > 0) || count < 1)
    return []
  const max = Math.max(1, opts.maxThumbs ?? 100)
  const step = Math.max(thumbWidth, clipWidth / max)
  const slots: ThumbSlot[] = []
  for (let left = 0; left < clipWidth && slots.length < max; left += step) {
    const sourceSeconds = sourceIn / MICROS_PER_SECOND + (left / zoom) * speed
    slots.push({
      left,
      index: Math.min(count - 1, Math.max(0, Math.floor(sourceSeconds / interval))),
    })
  }
  return slots
}

/** Ausschnitt der Wellenform, den ein Ton-Clip aus seiner Quelle zeigt. */
export function clipPeaks(
  peaks: Uint8Array | null | undefined,
  rate: number,
  sourceIn: Time,
  duration: Time,
  speed: number,
): Uint8Array | null {
  if (!peaks || !(rate > 0)) return null
  // Erst multiplizieren, dann teilen: so bleiben ganze Stützstellen exakt (kein 55,000000001).
  const from = Math.floor((sourceIn * rate) / MICROS_PER_SECOND)
  const to = Math.ceil(Math.round((sourceIn + duration * speed) * rate) / MICROS_PER_SECOND)
  return peaks.subarray(Math.min(from, peaks.length), Math.min(Math.max(to, from), peaks.length))
}
