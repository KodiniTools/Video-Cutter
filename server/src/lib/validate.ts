import type { TrimMode } from './args'

export class ValidationError extends Error {
  statusCode = 400
  constructor(message: string) {
    super(message)
    this.name = 'ValidationError'
  }
}

export interface CutParams {
  start: number
  duration: number
  mode: TrimMode
}

/**
 * Validiert die Multipart-Felder streng.
 * Wirft `ValidationError` (HTTP 400) bei ungültigen Werten.
 */
export function parseCutParams(
  body: Record<string, unknown>,
  maxDurationSec: number,
): CutParams {
  const start = Number(body.start)
  const duration = Number(body.duration)
  const mode = body.mode

  if (!Number.isFinite(start) || start < 0) {
    throw new ValidationError('Ungültiger Startwert.')
  }
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new ValidationError('Ungültige Dauer.')
  }
  if (duration > maxDurationSec) {
    throw new ValidationError(`Dauer überschreitet das Limit von ${maxDurationSec}s.`)
  }
  if (mode !== 'copy' && mode !== 'reencode') {
    throw new ValidationError('Ungültiger Modus (erlaubt: copy, reencode).')
  }

  return { start, duration, mode }
}

/** Endung in Kleinbuchstaben (1–5 Zeichen), Fallback `mp4`. */
export function safeExt(filename: string): string {
  const m = /\.([a-zA-Z0-9]{1,5})$/.exec(filename ?? '')
  return m ? m[1].toLowerCase() : 'mp4'
}

/** Basisname ohne Endung, auf sichere Zeichen reduziert. */
export function safeBaseName(filename: string): string {
  const withoutExt = (filename ?? '').replace(/\.[^.]+$/, '')
  const cleaned = withoutExt.replace(/[^a-zA-Z0-9-_ ]+/g, '').trim().slice(0, 80)
  return cleaned || 'video'
}
