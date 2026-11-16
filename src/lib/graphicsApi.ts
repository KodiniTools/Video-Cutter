import { API_BASE } from './apiBase'
import { fallbackErrorMessage, retryAfterOf } from './httpError'

/**
 * Client für die Grafiken des Timeline-Editors. Der Browser zeichnet Formen,
 * Symbole und Emojis als PNG und lädt sie einmal hoch; im Dokument steht für
 * den Server nur die ID des Bildes.
 */

/** Fehler-Kennung: Das Backend kennt die Grafiken noch nicht (veraltet). */
export const GRAPHICS_UNSUPPORTED = 'GRAPHICS_UNSUPPORTED'

export interface UploadedGraphic {
  id: string
  width: number
  height: number
}

/** Der Server hat Bilder zu Grafiken nicht (mehr): erneut hochladen, dann wiederholen. */
export class MissingGraphicsError extends Error {
  readonly ids: string[]
  constructor(ids: string[], message: string) {
    super(message)
    this.name = 'MissingGraphicsError'
    this.ids = ids
  }
}

/** IDs aus einer Server-Antwort (`missingGraphics`); alles andere wird verworfen. */
export function parseMissingGraphics(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string' && v !== '')
    : []
}

/** PNG hochladen; dasselbe Bild ergibt immer dieselbe ID. */
export async function uploadGraphic(png: Blob, signal?: AbortSignal): Promise<UploadedGraphic> {
  const res = await fetch(`${API_BASE}/api/graphics`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/png' },
    body: png,
    signal,
  })
  let data: { id?: unknown; width?: unknown; height?: unknown; error?: unknown } = {}
  try {
    data = (await res.json()) as typeof data
  } catch {
    /* keine JSON-Antwort */
  }
  if (!res.ok) {
    const msg = typeof data.error === 'string' ? data.error : ''
    // Altes Backend: Route unbekannt -> generisches „Nicht gefunden.“ bzw. HTML.
    if (res.status === 404 && (!msg || msg === 'Nicht gefunden.'))
      throw new Error(GRAPHICS_UNSUPPORTED)
    throw new Error(msg || fallbackErrorMessage(res.status, retryAfterOf(res)))
  }
  if (typeof data.id !== 'string' || !data.id) throw new Error(fallbackErrorMessage(502, null))
  return {
    id: data.id,
    width: typeof data.width === 'number' ? data.width : 0,
    height: typeof data.height === 'number' ? data.height : 0,
  }
}
