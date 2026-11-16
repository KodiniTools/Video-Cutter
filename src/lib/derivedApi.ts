import { API_BASE } from './apiBase'
import { fallbackErrorMessage, retryAfterOf } from './httpError'

/**
 * Client für die abgeleiteten Dateien eines Videos (Timeline-Editor):
 * Wellenform, Filmstreifen und Vorschau-Kopie. Der Server erzeugt sie auf
 * Abruf im Hintergrund (`POST …/derived`) und meldet den Stand je Teil.
 */

/** Fehler-Kennung: Das Backend kennt die abgeleiteten Dateien noch nicht (veraltet). */
export const DERIVED_UNSUPPORTED = 'DERIVED_UNSUPPORTED'
/** Fehler-Kennung: Das Video gibt es auf dem Server nicht (mehr). */
export const DERIVED_MEDIA_GONE = 'DERIVED_MEDIA_GONE'

export const PART_STATES = [
  'missing',
  'queued',
  'running',
  'ready',
  'error',
  'unavailable',
] as const
export type PartState = (typeof PART_STATES)[number]

export interface PeaksStatus {
  state: PartState
  /** Abschnitte je Sekunde. */
  rate: number
  count: number
}

export interface StripStatus {
  state: PartState
  /** Abstand der Bilder in Sekunden; Bild `i` zeigt die Zeit `i * interval`. */
  interval: number
  count: number
  columns: number
  tileWidth: number
  tileHeight: number
}

export interface ProxyStatus {
  state: PartState
  /** 0–100, nur während der Berechnung. */
  progress: number
  width: number
  height: number
}

export interface DerivedStatus {
  peaks: PeaksStatus
  strip: StripStatus
  proxy: ProxyStatus
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)
const obj = (v: unknown) => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {})

function stateOf(v: unknown): PartState {
  return PART_STATES.includes(v as PartState) ? (v as PartState) : 'missing'
}

/** Prüft und normalisiert eine Server-Antwort; fehlende Zahlen werden 0. */
export function parseDerivedStatus(data: unknown): DerivedStatus {
  const d = obj(data)
  const peaks = obj(d.peaks)
  const strip = obj(d.strip)
  const proxy = obj(d.proxy)
  return {
    peaks: { state: stateOf(peaks.state), rate: num(peaks.rate), count: num(peaks.count) },
    strip: {
      state: stateOf(strip.state),
      interval: num(strip.interval),
      count: num(strip.count),
      columns: num(strip.columns),
      tileWidth: num(strip.tileWidth),
      tileHeight: num(strip.tileHeight),
    },
    proxy: {
      state: stateOf(proxy.state),
      progress: Math.min(100, num(proxy.progress)),
      width: num(proxy.width),
      height: num(proxy.height),
    },
  }
}

/** Wird (noch) gerechnet oder steht etwas in der Warteschlange? */
export function derivedBusy(status: DerivedStatus): boolean {
  return [status.peaks, status.strip, status.proxy].some(
    (p) => p.state === 'queued' || p.state === 'running',
  )
}

/** Ist ein Teil fehlgeschlagen? */
export function derivedFailed(status: DerivedStatus): boolean {
  return [status.peaks, status.strip, status.proxy].some((p) => p.state === 'error')
}

async function errorFrom(res: Response): Promise<Error> {
  let msg = ''
  try {
    msg = ((await res.json()) as { error?: string }).error ?? ''
  } catch {
    /* keine JSON-Antwort */
  }
  if (res.status === 404) {
    // Altes Backend: Route unbekannt -> generisches „Nicht gefunden.“ bzw. HTML.
    return new Error(!msg || msg === 'Nicht gefunden.' ? DERIVED_UNSUPPORTED : DERIVED_MEDIA_GONE)
  }
  return new Error(msg || fallbackErrorMessage(res.status, retryAfterOf(res)))
}

const base = (id: string) => `${API_BASE}/api/media/${encodeURIComponent(id)}`

/** Fehlende Teile im Hintergrund berechnen lassen; liefert den Stand. */
export async function ensureDerived(id: string, signal?: AbortSignal): Promise<DerivedStatus> {
  const res = await fetch(`${base(id)}/derived`, { method: 'POST', signal })
  if (!res.ok) throw await errorFrom(res)
  return parseDerivedStatus(await res.json())
}

export async function fetchDerivedStatus(id: string, signal?: AbortSignal): Promise<DerivedStatus> {
  const res = await fetch(`${base(id)}/derived`, { signal })
  if (!res.ok) throw await errorFrom(res)
  return parseDerivedStatus(await res.json())
}

/** Wellenform: ein Wert (0–255) je Abschnitt. */
export async function fetchPeaks(id: string, signal?: AbortSignal): Promise<Uint8Array> {
  const res = await fetch(`${base(id)}/peaks`, { signal })
  if (!res.ok) throw await errorFrom(res)
  return new Uint8Array(await res.arrayBuffer())
}

export const stripUrl = (id: string) => `${base(id)}/strip`
export const proxyUrl = (id: string) => `${base(id)}/proxy`

/**
 * CSS-Werte, um Bild `index` des Filmstreifens (Kachelbild) in einem Kasten
 * der Breite `boxWidth` zu zeigen. `null`, wenn der Streifen nicht bereit ist.
 */
export function stripTileStyle(
  id: string,
  strip: StripStatus,
  index: number,
  boxWidth: number,
): { backgroundImage: string; backgroundSize: string; backgroundPosition: string } | null {
  if (strip.state !== 'ready' || !strip.count || !strip.columns || !strip.tileWidth) return null
  const i = Math.min(strip.count - 1, Math.max(0, Math.trunc(index)))
  const scale = boxWidth / strip.tileWidth
  const rows = Math.ceil(strip.count / strip.columns)
  const col = i % strip.columns
  const row = Math.floor(i / strip.columns)
  const px = (n: number) => `${Math.round(n * 100) / 100}px`
  return {
    backgroundImage: `url("${stripUrl(id)}")`,
    backgroundSize: `${px(strip.columns * strip.tileWidth * scale)} ${px(rows * strip.tileHeight * scale)}`,
    backgroundPosition: `${px(-col * strip.tileWidth * scale)} ${px(-row * strip.tileHeight * scale)}`,
  }
}
