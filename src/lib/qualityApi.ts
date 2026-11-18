import { API_BASE } from './apiBase'
import { fallbackErrorMessage, retryAfterOf } from './httpError'
import { filmDuration, parseLoudness, type LoudnessMeasure } from '@/timeline/quality'
import type { TimelineDoc } from '@/timeline/model'

/** Fehler-Kennung: Das Backend kennt die Ton-Messung noch nicht (veraltet). */
export const QUALITY_UNSUPPORTED = 'QUALITY_UNSUPPORTED'

/**
 * Für die Messung genügen Bild- und Ton-Spuren (das Bild nur für die Länge).
 * Texte, Grafiken und Marker bleiben weg: Grafiken bräuchten sonst erst ein
 * hochgeladenes Bild, und am Ton ändern sie nichts.
 */
export function loudnessDoc(doc: TimelineDoc): TimelineDoc {
  return { ...doc, tracks: doc.tracks.filter((t) => t.kind !== 'overlay'), markers: [] }
}

/** Lautheit des Tons messen, so wie der Export ihn mischt. */
export async function measureLoudness(
  doc: TimelineDoc,
  signal?: AbortSignal,
): Promise<LoudnessMeasure> {
  const res = await fetch(`${API_BASE}/api/quality/loudness`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ doc: loudnessDoc(doc), duration: filmDuration(doc) }),
    signal,
  })
  let data: unknown = null
  try {
    data = await res.json()
  } catch {
    /* keine JSON-Antwort */
  }
  const msg =
    data && typeof (data as { error?: unknown }).error === 'string'
      ? (data as { error: string }).error
      : ''
  if (!res.ok) {
    // Altes Backend: Route unbekannt -> generisches „Nicht gefunden.“ bzw. HTML.
    if (res.status === 404 && (!msg || msg === 'Nicht gefunden.'))
      throw new Error(QUALITY_UNSUPPORTED)
    throw new Error(msg || fallbackErrorMessage(res.status, retryAfterOf(res)))
  }
  const parsed = parseLoudness(data)
  if (!parsed) throw new Error(fallbackErrorMessage(502, null))
  return parsed
}
