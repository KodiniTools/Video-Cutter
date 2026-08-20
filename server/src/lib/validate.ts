import { computeKeepRanges, type TrimMode, type CutOperation, type Segment } from './args'

export class ValidationError extends Error {
  statusCode = 400
  constructor(message: string) {
    super(message)
    this.name = 'ValidationError'
  }
}

export interface CutParams {
  segments: Segment[]
  mode: TrimMode
  operation: CutOperation
  /** Gesamtdauer des Videos – nur bei operation 'remove' gesetzt. */
  total?: number
}

/** Liest die Segment-Liste (JSON) oder – als Fallback – das einzelne start/duration. */
function parseSegments(body: Record<string, unknown>, maxDurationSec: number): Segment[] {
  let raw: unknown = body.segments
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw)
    } catch {
      throw new ValidationError('Ungültige Segment-Liste.')
    }
  }

  const list: Array<{ start: unknown; duration: unknown }> = Array.isArray(raw)
    ? (raw as Array<{ start: unknown; duration: unknown }>)
    : [{ start: body.start, duration: body.duration }]

  if (list.length === 0) throw new ValidationError('Kein Ausschnitt ausgewählt.')

  return list.map((seg) => {
    const start = Number(seg.start)
    const duration = Number(seg.duration)
    if (!Number.isFinite(start) || start < 0) {
      throw new ValidationError('Ungültiger Startwert.')
    }
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new ValidationError('Ungültige Dauer.')
    }
    if (duration > maxDurationSec) {
      throw new ValidationError(`Dauer überschreitet das Limit von ${maxDurationSec}s.`)
    }
    return { start, duration }
  })
}

/**
 * Validiert die Multipart-Felder streng.
 * Wirft `ValidationError` (HTTP 400) bei ungültigen Werten.
 */
export function parseCutParams(body: Record<string, unknown>, maxDurationSec: number): CutParams {
  const mode = body.mode
  const operation: CutOperation = body.operation === 'remove' ? 'remove' : 'keep'

  if (mode !== 'copy' && mode !== 'reencode') {
    throw new ValidationError('Ungültiger Modus (erlaubt: copy, reencode).')
  }

  const segments = parseSegments(body, maxDurationSec)

  let total: number | undefined
  if (operation === 'remove') {
    total = Number(body.total)
    if (!Number.isFinite(total) || total <= 0) {
      throw new ValidationError('Ungültige Gesamtdauer.')
    }
  }

  // Sicherstellen, dass nach der Operation überhaupt Material übrig bleibt.
  const keepTotal = operation === 'keep' ? (total ?? Number.POSITIVE_INFINITY) : (total as number)
  if (computeKeepRanges(segments, operation, keepTotal).length === 0) {
    throw new ValidationError(
      operation === 'remove'
        ? 'Nach dem Entfernen bliebe kein Video übrig.'
        : 'Kein gültiger Ausschnitt ausgewählt.',
    )
  }

  return { segments, mode, operation, total }
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
