import type { NextFunction, Request, RequestHandler, Response } from 'express'
import rateLimit, { type Options, type RateLimitInfo } from 'express-rate-limit'

/**
 * Ratenlimits für /api, getrennt nach Art der Anfrage:
 * - „write“ (POST): Uploads, Schneiden, Einbrennen, KI, Projekte speichern –
 *   teuer, aber zusätzlich durch MAX_CONCURRENT und Größenlimits geschützt.
 * - „read“ (alles andere): Status, Fortschritt (SSE), Downloads, Löschen –
 *   billig und in normaler Nutzung sehr häufig.
 * Früher teilten sich alle Anfragen 60 pro 15 Minuten; ein paar Uploads,
 * Vorschauen und Speichervorgänge reichten für „Serverfehler (429)“.
 */
export interface RateLimitSettings {
  windowMs: number
  writeMax: number
  readMax: number
}

/** Verständliche Wartezeit für die Fehlermeldung. */
export function waitText(seconds: number): string {
  if (seconds < 60) {
    const s = Math.max(1, Math.ceil(seconds))
    return `${s} ${s === 1 ? 'Sekunde' : 'Sekunden'}`
  }
  const m = Math.ceil(seconds / 60)
  return `${m} ${m === 1 ? 'Minute' : 'Minuten'}`
}

/** JSON-Antwort statt Klartext; `Retry-After` setzt express-rate-limit selbst. */
function limitReached(req: Request, res: Response, _next: NextFunction, options: Options): void {
  const reset = (req as Request & { rateLimit?: RateLimitInfo }).rateLimit?.resetTime
  const seconds = reset ? Math.max(1, Math.ceil((reset.getTime() - Date.now()) / 1000)) : 60
  if (!res.getHeader('Retry-After')) res.setHeader('Retry-After', String(seconds))
  res.status(options.statusCode).json({
    error: `Zu viele Anfragen in kurzer Zeit. Bitte in ${waitText(seconds)} erneut versuchen.`,
    retryAfter: seconds,
  })
}

const isWrite = (req: Request) => req.method === 'POST'

/** Beide Limiter als eine Middleware (jede Anfrage zählt nur bei einem). */
export function createApiRateLimit(s: RateLimitSettings): RequestHandler[] {
  const common = {
    windowMs: s.windowMs,
    standardHeaders: true,
    legacyHeaders: false,
    handler: limitReached,
  } as const
  return [
    rateLimit({ ...common, limit: s.writeMax, skip: (req) => !isWrite(req) }),
    rateLimit({ ...common, limit: s.readMax, skip: (req) => isWrite(req) }),
  ]
}
