import type { TrimMode, CutOperation } from './args'

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
  operation: CutOperation
  /** Gesamtdauer des Videos – nur bei operation 'remove' gesetzt. */
  total?: number
}

/**
 * Validiert die Multipart-Felder streng.
 * Wirft `ValidationError` (HTTP 400) bei ungültigen Werten.
 */
export function parseCutParams(body: Record<string, unknown>, maxDurationSec: number): CutParams {
  const start = Number(body.start)
  const duration = Number(body.duration)
  const mode = body.mode
  const operation: CutOperation = body.operation === 'remove' ? 'remove' : 'keep'

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

  let total: number | undefined
  if (operation === 'remove') {
    total = Number(body.total)
    if (!Number.isFinite(total) || total <= 0) {
      throw new ValidationError('Ungültige Gesamtdauer.')
    }
    if (start + duration > total + 0.5) {
      throw new ValidationError('Der zu entfernende Bereich liegt außerhalb des Videos.')
    }
    if (total - duration < 0.05) {
      throw new ValidationError('Nach dem Entfernen bliebe kein Video übrig.')
    }
  }

  return { start, duration, mode, operation, total }
}

/** Endung in Kleinbuchstaben (1–5 Zeichen), Fallback `mp4`. */
export function safeExt(filename: string): string {
  const m = /\.([a-zA-Z0-9]{1,5})$/.exec(filename ?? '')
  return m ? m[1].toLowerCase() : 'mp4'
}

/** Basisname ohne Endung, auf sichere Zeichen reduziert. */
export function safeBaseName(filename: string): string {
  const withoutExt = (filename ?? '').replace(/\.[^.]+$/, '')
  const cleaned = withoutExt
    .replace(/[^a-zA-Z0-9-_ ]+/g, '')
    .trim()
    .slice(0, 80)
  return cleaned || 'video'
}
