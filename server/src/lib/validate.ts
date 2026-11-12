import {
  computeKeepRanges,
  type TrimMode,
  type CutOperation,
  type Segment,
  type Transition,
  type TransitionPreset,
  type CropRect,
  type AppendPosition,
  type OutputAspect,
  type OutputFill,
  OUTPUT_ASPECTS,
  OUTPUT_FILLS,
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

/** Kürzung + Position eines angehängten Videos, wie vom Client gesendet. */
export interface AppendMeta {
  /** Startpunkt in Sekunden (≥ 0). */
  start: number
  /** Gewünschte Länge in Sekunden; `undefined` = bis zum Ende. */
  duration?: number
  position: AppendPosition
  /** Nur bei 'after': hinter dem n-ten Bereich des Hauptvideos (1-basiert); fehlt = am Ende. */
  slot?: number
}

/** Höchster sinnvoller Slot-Wert (größere Werte bedeuten ohnehin „am Ende"). */
const MAX_APPEND_SLOT = 10_000

/**
 * Liest das Ausgabeformat (`outputAspect`, `outputFill`). Fehlende Felder =
 * Standard (auto / Balken); unbekannte Werte werden abgelehnt.
 */
export function parseOutputFormat(body: Record<string, unknown>): {
  aspect: OutputAspect
  fill: OutputFill
} {
  const a = body.outputAspect
  const f = body.outputFill
  const aspect = a === undefined || a === '' ? 'auto' : a
  const fill = f === undefined || f === '' ? 'pad' : f
  if (typeof aspect !== 'string' || !OUTPUT_ASPECTS.includes(aspect as OutputAspect)) {
    throw new ValidationError('Ungültiges Ausgabeformat.')
  }
  if (typeof fill !== 'string' || !OUTPUT_FILLS.includes(fill as OutputFill)) {
    throw new ValidationError('Ungültiger Füllmodus.')
  }
  return { aspect: aspect as OutputAspect, fill: fill as OutputFill }
}

/** Einstellungen der Hintergrundmusik (ohne Datei). */
export interface MusicParams {
  volume: number
  originalVolume: number
  fade: boolean
  loop: boolean
}

function parseFraction(v: unknown, fallback: number, label: string): number {
  if (v === undefined || v === null || v === '') return fallback
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    throw new ValidationError(`Ungültige ${label} (erlaubt: 0–1).`)
  }
  return n
}

function parseFlag(v: unknown, fallback: boolean): boolean {
  if (v === undefined || v === null || v === '') return fallback
  return v === true || v === '1' || v === 'true'
}

/**
 * Liest die Musik-Einstellungen: `musicVolume` (0–1, Standard 0,3),
 * `musicOriginalVolume` (0–1, Standard 1), `musicFade`/`musicLoop` (Standard an).
 */
export function parseMusicParams(body: Record<string, unknown>): MusicParams {
  return {
    volume: parseFraction(body.musicVolume, 0.3, 'Musik-Lautstärke'),
    originalVolume: parseFraction(body.musicOriginalVolume, 1, 'Originalton-Lautstärke'),
    fade: parseFlag(body.musicFade, true),
    loop: parseFlag(body.musicLoop, true),
  }
}

/** Liest den Schalter „Lautstärke angleichen" (`normalizeAudio`: '1'/'true'). */
export function parseNormalizeAudio(body: Record<string, unknown>): boolean {
  const v = body.normalizeAudio
  return v === true || v === '1' || v === 'true'
}

const DEFAULT_APPEND_META: AppendMeta = { start: 0, position: 'after' }

/**
 * Liest `appendMeta` (JSON-Array, ein Eintrag je angehängter Datei, gleiche
 * Reihenfolge). Fehlt das Feld, gelten die Standardwerte (vollständig, danach).
 */
export function parseAppendMeta(body: Record<string, unknown>, count: number): AppendMeta[] {
  let raw: unknown = body.appendMeta
  if (raw === undefined || raw === null || raw === '') {
    return Array.from({ length: count }, () => ({ ...DEFAULT_APPEND_META }))
  }
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw)
    } catch {
      throw new ValidationError('Ungültige Angaben zu den angehängten Videos.')
    }
  }
  if (!Array.isArray(raw) || raw.length !== count) {
    throw new ValidationError('Angaben passen nicht zu den angehängten Videos.')
  }
  return raw.map((item) => {
    const m = (item ?? {}) as Record<string, unknown>
    const start = m.start === undefined ? 0 : Number(m.start)
    if (!Number.isFinite(start) || start < 0) {
      throw new ValidationError('Ungültiger Startwert eines angehängten Videos.')
    }
    let duration: number | undefined
    if (m.duration !== undefined && m.duration !== null) {
      duration = Number(m.duration)
      if (!Number.isFinite(duration) || duration <= 0) {
        throw new ValidationError('Ungültige Länge eines angehängten Videos.')
      }
    }
    const position: AppendPosition = m.position === 'before' ? 'before' : 'after'
    if (m.position !== undefined && m.position !== 'before' && m.position !== 'after') {
      throw new ValidationError('Ungültige Position eines angehängten Videos.')
    }
    let slot: number | undefined
    if (m.slot !== undefined && m.slot !== null) {
      slot = Number(m.slot)
      if (!Number.isInteger(slot) || slot < 1 || slot > MAX_APPEND_SLOT) {
        throw new ValidationError('Ungültige Einfügestelle eines angehängten Videos.')
      }
      if (position === 'before') slot = undefined
    }
    return slot === undefined ? { start, duration, position } : { start, duration, position, slot }
  })
}

/** Mindestlänge eines gekürzten angehängten Videos (Sekunden). */
const MIN_APPEND_SEC = 0.05

/**
 * Wendet die Kürzung auf die (per ffprobe ermittelte) echte Dauer an.
 * Liefert Start + tatsächlich verwendete Länge oder wirft, wenn nichts übrig bleibt.
 */
export function resolveAppendRange(
  meta: AppendMeta,
  realDuration: number,
): { start: number; duration: number } {
  const rest = realDuration - meta.start
  if (!(rest >= MIN_APPEND_SEC)) {
    throw new ValidationError('Startwert liegt hinter dem Ende des angehängten Videos.')
  }
  const duration = Math.min(meta.duration ?? rest, rest)
  if (!(duration >= MIN_APPEND_SEC)) {
    throw new ValidationError('Gekürztes angehängtes Video ist zu kurz.')
  }
  return { start: meta.start, duration }
}
