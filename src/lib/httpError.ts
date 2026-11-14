/**
 * Gemeinsame Fehlermeldungen für Serverantworten ohne verwertbare
 * JSON-Meldung. Vor allem 429 („Too Many Requests“) bekommt statt
 * „Serverfehler (429).“ einen verständlichen Text mit Wartezeit.
 */

/**
 * Wartezeit aus dem `Retry-After`-Header in Sekunden (Sekundenzahl oder
 * HTTP-Datum). `null` = fehlt oder ungültig.
 */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | null {
  if (!value) return null
  const v = value.trim()
  if (/^\d+$/.test(v)) return Number(v)
  const at = Date.parse(v)
  if (Number.isNaN(at)) return null
  return Math.max(0, Math.ceil((at - now) / 1000))
}

/** „Zu viele Anfragen …“ mit gerundeter Wartezeit (falls bekannt). */
export function rateLimitMessage(retryAfterSec: number | null): string {
  if (retryAfterSec === null) {
    return 'Zu viele Anfragen in kurzer Zeit. Bitte ein paar Minuten warten und erneut versuchen.'
  }
  if (retryAfterSec < 60) {
    const s = Math.max(1, retryAfterSec)
    return `Zu viele Anfragen in kurzer Zeit. Bitte in ${s} ${s === 1 ? 'Sekunde' : 'Sekunden'} erneut versuchen.`
  }
  const m = Math.ceil(retryAfterSec / 60)
  return `Zu viele Anfragen in kurzer Zeit. Bitte in ${m} ${m === 1 ? 'Minute' : 'Minuten'} erneut versuchen.`
}

/**
 * Ersatzmeldung, wenn die Antwort keine eigene `error`-Meldung enthält.
 * @param retryAfter Roher `Retry-After`-Header (nur für 429 genutzt).
 */
export function fallbackErrorMessage(status: number, retryAfter?: string | null): string {
  if (status === 429) return rateLimitMessage(parseRetryAfter(retryAfter))
  return `Serverfehler (${status}).`
}

/** `Retry-After` einer fetch-Antwort; robust gegen Test-Attrappen ohne Header. */
export function retryAfterOf(res: {
  headers?: { get?: (name: string) => string | null }
}): string | null {
  return res.headers?.get?.('Retry-After') ?? null
}
