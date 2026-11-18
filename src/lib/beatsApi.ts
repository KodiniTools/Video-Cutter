import { API_BASE } from './apiBase'
import { fallbackErrorMessage, retryAfterOf } from './httpError'

/**
 * Client für die Takt-Erkennung (`GET /api/media/:id/beats`). Der Server
 * rechnet beim ersten Abruf (bei langen Stücken einige Sekunden) und hebt das
 * Ergebnis danach auf.
 */

/** Fehler-Kennung: Das Backend kennt die Takt-Erkennung noch nicht (veraltet). */
export const BEATS_UNSUPPORTED = 'BEATS_UNSUPPORTED'

export interface BeatAnalysis {
  /** Tempo in Schlägen je Minute; 0 = kein Takt erkannt. */
  bpm: number
  /** Zeiten der Schläge in Sekunden ab Beginn der Quelle, aufsteigend. */
  beats: number[]
  /** Index (0–3) des ersten Schlags, der einen Takt beginnt. */
  downbeat: number
}

/** Prüft eine Server-Antwort; Unbrauchbares wird verworfen bzw. 0. */
export function parseBeatAnalysis(data: unknown): BeatAnalysis {
  const d = data && typeof data === 'object' ? (data as Record<string, unknown>) : {}
  const bpm = typeof d.bpm === 'number' && Number.isFinite(d.bpm) && d.bpm > 0 ? d.bpm : 0
  const raw = Array.isArray(d.beats) ? d.beats : []
  const beats: number[] = []
  for (const b of raw)
    if (typeof b === 'number' && Number.isFinite(b) && b >= 0)
      if (beats.length === 0 || b > beats[beats.length - 1]) beats.push(b)
  const db = d.downbeat
  const downbeat = typeof db === 'number' && Number.isInteger(db) && db >= 0 && db < 4 ? db : 0
  return { bpm, beats, downbeat }
}

export async function fetchBeats(mediaId: string, signal?: AbortSignal): Promise<BeatAnalysis> {
  const res = await fetch(`${API_BASE}/api/media/${encodeURIComponent(mediaId)}/beats`, { signal })
  if (!res.ok) {
    let msg = ''
    try {
      msg = ((await res.json()) as { error?: string }).error ?? ''
    } catch {
      /* keine JSON-Antwort */
    }
    // Altes Backend: Route unbekannt -> generisches „Nicht gefunden.“ bzw. HTML.
    if (res.status === 404 && (!msg || msg === 'Nicht gefunden.'))
      throw new Error(BEATS_UNSUPPORTED)
    throw new Error(msg || fallbackErrorMessage(res.status, retryAfterOf(res)))
  }
  return parseBeatAnalysis(await res.json())
}
