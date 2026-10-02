/**
 * Millisekunden-genaue Zeitdarstellung (übernommen aus dem Audio-Cutter).
 * Reine Funktionen auf Sekundenbasis (Store-Einheit des Video-Cutters).
 */

/**
 * Formatiert Sekunden als `[h:]mm:ss.mmm`.
 * Beispiel: 65.432 -> "01:05.432", 3600 -> "1:00:00.000"
 */
export function formatTimeMs(seconds: number): string {
  const safe = Math.max(0, Math.round((Number.isFinite(seconds) ? seconds : 0) * 1000))
  const millis = safe % 1000
  const totalSec = Math.floor(safe / 1000)
  const sec = totalSec % 60
  const totalMin = Math.floor(totalSec / 60)
  const min = totalMin % 60
  const hours = Math.floor(totalMin / 60)
  const pad = (n: number, len = 2) => String(n).padStart(len, '0')
  const base = `${pad(min)}:${pad(sec)}.${pad(millis, 3)}`
  return hours > 0 ? `${hours}:${base}` : base
}

/** Sekunden -> ganze Millisekunden (für Zahlenfelder). */
export function toMs(seconds: number): number {
  return Math.round(Math.max(0, seconds) * 1000)
}

/**
 * Parst `[hh:]mm:ss[.mmm]`, `ss[.mmm]` oder eine reine Zahl (= Sekunden)
 * nach Sekunden. Dezimaltrennzeichen `,` wird akzeptiert. `null` bei
 * ungültiger Eingabe.
 *
 * Hinweis: Anders als im Audio-Cutter zählt eine reine Zahl als Sekunden –
 * Millisekunden werden über das separate ms-Zahlenfeld eingegeben.
 */
export function parseTimeInput(input: string): number | null {
  const raw = input.trim().replace(',', '.')
  if (raw === '') return null

  if (/^\d+(\.\d+)?$/.test(raw)) {
    const n = Number(raw)
    return Number.isFinite(n) ? n : null
  }

  const parts = raw.split(':')
  if (parts.length < 2 || parts.length > 3) return null
  if (!parts.every((p) => /^\d+(\.\d+)?$/.test(p))) return null

  const nums = parts.map(Number)
  let hours = 0
  let minutes = 0
  let seconds = 0
  if (parts.length === 3) {
    ;[hours, minutes, seconds] = nums
  } else {
    ;[minutes, seconds] = nums
  }
  if (seconds >= 60 || minutes >= 60) return null
  return (hours * 60 + minutes) * 60 + seconds
}
