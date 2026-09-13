import {
  computeKeepRanges,
  type TrimMode,
  type CutOperation,
  type Segment,
  type Transition,
  type TransitionPreset,
  type CropRect,
} from './args'

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
  /** Übergang beim Zusammenfügen mehrerer Ausschnitte. */
  transition?: Transition
  /** Optionaler Bildausschnitt (Anteile 0–1 der Originalbreite/-höhe). */
  crop?: CropRect
}

const TRANSITION_PRESETS: TransitionPreset[] = ['none', 'fade', 'slide', 'scale', 'flip']
/** Höchste erlaubte Übergangsdauer in Sekunden. */
const MAX_TRANSITION_SEC = 10

/** Liest optionalen Übergang (Preset + Dauer 1–10 s). */
function parseTransition(body: Record<string, unknown>): Transition | undefined {
  const preset = body.transitionPreset
  if (typeof preset !== 'string' || !TRANSITION_PRESETS.includes(preset as TransitionPreset)) {
    return undefined
  }
  if (preset === 'none') return undefined
  let duration = Number(body.transitionDuration)
  if (!Number.isFinite(duration)) duration = 1
  duration = Math.min(MAX_TRANSITION_SEC, Math.max(1, duration))
  return { preset: preset as TransitionPreset, duration }
}

/** Toleranz für Rundungsfehler bei den 0–1-Anteilswerten des Bildausschnitts. */
const CROP_EPS = 1e-6

/** Liest den optionalen Bildausschnitt (JSON: {x,y,width,height}, Anteile 0–1). */
function parseCrop(body: Record<string, unknown>): CropRect | undefined {
  let raw: unknown = body.crop
  if (typeof raw === 'string') {
    if (!raw.trim()) return undefined
    try {
      raw = JSON.parse(raw)
    } catch {
      throw new ValidationError('Ungültiger Bildausschnitt.')
    }
  }
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'object') throw new ValidationError('Ungültiger Bildausschnitt.')

  const { x, y, width, height } = raw as Record<string, unknown>
  const nx = Number(x)
  const ny = Number(y)
  const nWidth = Number(width)
  const nHeight = Number(height)
  if (![nx, ny, nWidth, nHeight].every(Number.isFinite)) {
    throw new ValidationError('Ungültiger Bildausschnitt.')
  }
  if (nWidth <= 0 || nHeight <= 0 || nWidth > 1 || nHeight > 1) {
    throw new ValidationError('Ungültige Größe des Bildausschnitts.')
  }
  if (
    nx < -CROP_EPS ||
    ny < -CROP_EPS ||
    nx + nWidth > 1 + CROP_EPS ||
    ny + nHeight > 1 + CROP_EPS
  ) {
    throw new ValidationError('Bildausschnitt liegt außerhalb des Bildes.')
  }
  return {
    x: Math.max(0, nx),
    y: Math.max(0, ny),
    width: nWidth,
    height: nHeight,
  }
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

  const transition = parseTransition(body)
  const crop = parseCrop(body)

  return { segments, mode, operation, total, transition, crop }
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
