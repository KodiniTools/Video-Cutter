import { API_BASE } from './apiBase'
import { fallbackErrorMessage, retryAfterOf } from './httpError'
import type { TimelineDoc } from '@/timeline/model'

/**
 * Client für die Server-Vorschau des Timeline-Editors. Der Server rendert die
 * Timeline in kurzen Abschnitten (fragmentiertes MP4); der Plan nennt je
 * Abschnitt einen Schlüssel, der sich nur ändert, wenn sich der Inhalt ändert.
 */

/** Fehler-Kennung: Das Backend kennt die Timeline-Vorschau noch nicht (veraltet). */
export const PREVIEW_UNSUPPORTED = 'PREVIEW_UNSUPPORTED'

export interface PreviewSegment {
  index: number
  /** Beginn in µs. */
  start: number
  /** Länge in µs. */
  duration: number
  key: string
}

export interface PreviewPlan {
  width: number
  height: number
  fps: number
  /** Länge der Timeline in µs. */
  duration: number
  segments: PreviewSegment[]
}

export interface PreviewStats {
  rendered: number
  avgMs: number
  /** Sekunden Timeline je Sekunde Renderzeit. */
  speed: number
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)
const obj = (v: unknown) => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {})

/**
 * Prüft und normalisiert einen Plan. Abschnitte ohne Schlüssel oder Länge
 * werden verworfen; ab der ersten Lücke ist Schluss, damit die Position in
 * der Liste immer dem Index entspricht.
 */
export function parsePreviewPlan(data: unknown): PreviewPlan {
  const d = obj(data)
  const segments: PreviewSegment[] = []
  for (const raw of Array.isArray(d.segments) ? d.segments : []) {
    const s = obj(raw)
    const duration = num(s.duration)
    if (typeof s.key !== 'string' || !s.key || !duration) break
    segments.push({ index: segments.length, start: num(s.start), duration, key: s.key })
  }
  return {
    width: num(d.width),
    height: num(d.height),
    fps: num(d.fps),
    duration: num(d.duration),
    segments,
  }
}

async function errorFrom(res: Response): Promise<Error> {
  let msg = ''
  try {
    msg = ((await res.json()) as { error?: string }).error ?? ''
  } catch {
    /* keine JSON-Antwort */
  }
  // Altes Backend: Route unbekannt -> generisches „Nicht gefunden.“ bzw. HTML.
  if (res.status === 404 && (!msg || msg === 'Nicht gefunden.'))
    return new Error(PREVIEW_UNSUPPORTED)
  return new Error(msg || fallbackErrorMessage(res.status, retryAfterOf(res)))
}

/**
 * Plan für das Dokument holen. Der Server beginnt, fehlende Abschnitte ab der
 * Zeit `at` (µs) zu rendern.
 */
export async function fetchPreviewPlan(
  doc: TimelineDoc,
  at: number,
  signal?: AbortSignal,
): Promise<PreviewPlan> {
  const res = await fetch(`${API_BASE}/api/preview/plan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ doc, at: Math.max(0, Math.round(at)) }),
    signal,
  })
  if (!res.ok) throw await errorFrom(res)
  return parsePreviewPlan(await res.json())
}

/** So oft wird höchstens auf einen Abschnitt gewartet (je Versuch bis zu 25 s). */
const MAX_WAITS = 12

/**
 * Abschnitt laden. Der Server hält die Anfrage offen, bis der Abschnitt
 * gerendert ist; meldet er „noch in Arbeit“, wird erneut gefragt.
 * `null`: Der Abschnitt gehört zu keinem aktuellen Plan mehr (neu planen).
 */
export async function fetchPreviewSegment(
  key: string,
  signal?: AbortSignal,
): Promise<ArrayBuffer | null> {
  const url = `${API_BASE}/api/preview/segment/${encodeURIComponent(key)}`
  for (let attempt = 0; attempt < MAX_WAITS; attempt++) {
    const res = await fetch(url, { signal })
    if (res.status === 200) return res.arrayBuffer()
    if (res.status === 404) return null
    if (res.status !== 202) throw await errorFrom(res)
  }
  throw new Error(fallbackErrorMessage(504, null))
}

export async function fetchPreviewStats(signal?: AbortSignal): Promise<PreviewStats> {
  const res = await fetch(`${API_BASE}/api/preview/stats`, { signal })
  if (!res.ok) throw await errorFrom(res)
  const d = obj(await res.json())
  return { rendered: num(d.rendered), avgMs: num(d.avgMs), speed: num(d.speed) }
}
