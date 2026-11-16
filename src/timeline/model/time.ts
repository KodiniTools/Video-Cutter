import type { Time } from './types'

export const MICROS_PER_SECOND = 1_000_000

/** Kürzeste Clip-Länge (50 ms, wie die Mindestauswahl im bisherigen Editor). */
export const MIN_CLIP_DURATION: Time = 50_000

export const MIN_SPEED = 0.25
export const MAX_SPEED = 4

/** Sekunden → Mikrosekunden (gerundet); ungültige Werte ergeben 0. */
export function secondsToTime(seconds: number): Time {
  return Number.isFinite(seconds) ? Math.round(seconds * MICROS_PER_SECOND) : 0
}

export function timeToSeconds(time: Time): number {
  return time / MICROS_PER_SECOND
}

/** Gültige Zeit: ganze, nicht negative Zahl. */
export function isTime(v: unknown): v is Time {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
}

function validFps(fps: number): boolean {
  return Number.isFinite(fps) && fps > 0
}

/** Nummer des Bildes, das der Zeit am nächsten liegt. */
export function frameIndex(time: Time, fps: number): number {
  return validFps(fps) ? Math.round((time * fps) / MICROS_PER_SECOND) : 0
}

/** Beginn des Bildes `index`. */
export function frameTime(index: number, fps: number): Time {
  return validFps(fps) ? Math.round((index * MICROS_PER_SECOND) / fps) : 0
}

/** Zeit auf das Bildraster legen; ohne gültige Bildrate bleibt sie unverändert. */
export function snapToFrame(time: Time, fps: number): Time {
  return validFps(fps) ? frameTime(frameIndex(time, fps), fps) : time
}
