import { frameIndex, frameTime, snapToFrame, type Time } from './model'

/** Schrittweiten (ms) zum genauen Verschieben des Abspielkopfs. */
export const NUDGE_STEPS_MS = [10, 100, 1000] as const
export type NudgeStepMs = (typeof NUDGE_STEPS_MS)[number]
export const DEFAULT_NUDGE_MS: NudgeStepMs = 100

export function isNudgeStep(v: unknown): v is NudgeStepMs {
  return (NUDGE_STEPS_MS as readonly unknown[]).includes(v)
}

/**
 * Neuer Abspielkopf nach einem Schritt von `stepMs` in Richtung `dir`. Der
 * Abspielkopf liegt immer auf dem Bildraster; ist der Schritt kürzer als ein
 * Bild (10 ms bei 30 Bildern/s), geht es genau ein Bild weiter, damit der
 * Knopf nie wirkungslos bleibt. Ergebnis liegt in [0, duration].
 */
export function nudgeTime(
  playhead: Time,
  dir: -1 | 1,
  stepMs: number,
  fps: number,
  duration: Time,
): Time {
  const end = Math.max(0, duration)
  let next = snapToFrame(playhead + dir * Math.round(stepMs * 1000), fps)
  if (next === playhead) next = frameTime(frameIndex(playhead, fps) + dir, fps)
  return Math.min(end, Math.max(0, next))
}
