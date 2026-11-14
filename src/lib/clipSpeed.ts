/**
 * Wiedergabegeschwindigkeit je Clip beim Zusammenfügen.
 *
 * Die Einstellung ist eine Stufe von −2,5 bis +2,5 in 0,5er-Schritten
 * (0 = normal). Plus macht schneller, Minus langsamer – symmetrisch:
 * +1 = doppelt so schnell (2×), −1 = halb so schnell (0,5×).
 *
 *   Stufe  +s -> Faktor 1 + s       (+2,5 -> 3,5×)
 *   Stufe  −s -> Faktor 1 / (1 + s) (−2,5 -> 1/3,5 ≈ 0,29×)
 *
 * Der Server bekommt den Faktor (setpts + atempo, Tonhöhe bleibt).
 */

/** Größte Stufe nach oben/unten. */
export const MAX_SPEED_STEP = 2.5
/** Schrittweite der Stufen. */
export const SPEED_STEP = 0.5

/** Alle wählbaren Stufen (−2,5 … +2,5). */
export const SPEED_STEPS: readonly number[] = Array.from(
  { length: (2 * MAX_SPEED_STEP) / SPEED_STEP + 1 },
  (_, i) => -MAX_SPEED_STEP + i * SPEED_STEP,
)

/** Stufe auf eine gültige Stufe runden (ungültig -> 0 = normal). */
export function normalizeSpeedStep(step: unknown): number {
  const n = typeof step === 'number' ? step : Number(step)
  if (!Number.isFinite(n)) return 0
  const r = Math.round(n / SPEED_STEP) * SPEED_STEP
  const c = Math.min(MAX_SPEED_STEP, Math.max(-MAX_SPEED_STEP, r))
  return c === 0 ? 0 : c // −0 vermeiden
}

/** Faktor einer Stufe (0 -> 1). */
export function speedFactor(step: number): number {
  const s = normalizeSpeedStep(step)
  return s >= 0 ? 1 + s : 1 / (1 - s)
}

/** Faktor für Anzeige, z. B. „2×“, „0,5×“, „0,29×“. */
export function formatSpeedFactor(step: number, locale = 'de'): string {
  const f = speedFactor(step)
  const digits = Number.isInteger(f) ? 0 : Math.abs(f * 10 - Math.round(f * 10)) < 1e-9 ? 1 : 2
  return `${f.toLocaleString(locale, { maximumFractionDigits: digits, minimumFractionDigits: digits })}×`
}

/** Stufe für Anzeige mit Vorzeichen, z. B. „+1,5“, „−2“, „0“. */
export function formatSpeedStep(step: number, locale = 'de'): string {
  const s = normalizeSpeedStep(step)
  const abs = Math.abs(s).toLocaleString(locale, { maximumFractionDigits: 1 })
  return s > 0 ? `+${abs}` : s < 0 ? `−${abs}` : '0'
}
