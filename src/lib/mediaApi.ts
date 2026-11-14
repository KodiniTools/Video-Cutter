import { API_BASE } from './apiBase'
import { fallbackErrorMessage, retryAfterOf } from './httpError'

/**
 * Client für die Video-Bibliothek des Servers (`/api/media`): Videos werden
 * EINMAL hochgeladen und danach per ID geschnitten/zusammengefügt.
 */

/** Fehler-Kennung: Das Backend kennt die Video-Bibliothek noch nicht (veraltet). */
export const MEDIA_UNSUPPORTED = 'MEDIA_UNSUPPORTED'

/** Ein auf dem Server gespeichertes Video (Antwort von /api/media). */
export interface MediaView {
  id: string
  name: string
  size: number
  duration: number
  width: number
  height: number
  hasAudio: boolean
  /** Bildrate (Bilder/s), 0 = unbekannt (älteres Backend). */
  fps: number
}

/** Prüft und normalisiert eine Server-Antwort. Wirft bei fehlender ID. */
export function parseMediaView(data: unknown): MediaView {
  const d = (data ?? {}) as Record<string, unknown>
  if (typeof d.id !== 'string' || !d.id) throw new Error('Ungültige Serverantwort (keine ID).')
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)
  return {
    id: d.id,
    name: typeof d.name === 'string' && d.name ? d.name : 'video',
    size: num(d.size),
    duration: num(d.duration),
    width: num(d.width),
    height: num(d.height),
    hasAudio: d.hasAudio === true,
    fps: num(d.fps),
  }
}

/** Fehlermeldung aus einer JSON-Fehlerantwort; 404 auf die Route = altes Backend. */
function errorFrom(status: number, text: string, retryAfter?: string | null): Error {
  let msg = ''
  try {
    msg = (JSON.parse(text) as { error?: string }).error ?? ''
  } catch {
    /* keine JSON-Antwort */
  }
  // Altes Backend: Route unbekannt -> generisches „Nicht gefunden." bzw. HTML.
  if (status === 404 && (!msg || msg === 'Nicht gefunden.')) return new Error(MEDIA_UNSUPPORTED)
  return new Error(msg || fallbackErrorMessage(status, retryAfter))
}

/** Laufender Upload: Ergebnis-Promise + Abbruch. */
export interface MediaUpload {
  promise: Promise<MediaView>
  abort: () => void
}

/** Fehler-Kennung für einen abgebrochenen Upload. */
export const UPLOAD_ABORTED = 'UPLOAD_ABORTED'

/**
 * Lädt ein Video in die Bibliothek (XHR für echten Upload-Fortschritt).
 * @param onProgress Anteil 0–1.
 */
export function uploadMedia(file: File, onProgress?: (ratio: number) => void): MediaUpload {
  const xhr = new XMLHttpRequest()
  const promise = new Promise<MediaView>((resolve, reject) => {
    xhr.open('POST', `${API_BASE}/api/media`)
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onProgress?.(e.loaded / e.total)
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(parseMediaView(JSON.parse(xhr.responseText)))
        } catch (err) {
          reject(err instanceof Error ? err : new Error('Ungültige Serverantwort.'))
        }
      } else {
        reject(errorFrom(xhr.status, xhr.responseText, xhr.getResponseHeader?.('Retry-After')))
      }
    }
    xhr.onerror = () => reject(new Error('Upload fehlgeschlagen (Netzwerkfehler).'))
    xhr.onabort = () => reject(new Error(UPLOAD_ABORTED))
    const form = new FormData()
    form.append('video', file)
    xhr.send(form)
  })
  return { promise, abort: () => xhr.abort() }
}

/** Metadaten eines gespeicherten Videos. */
export async function fetchMediaInfo(id: string): Promise<MediaView> {
  const res = await fetch(`${API_BASE}/api/media/${encodeURIComponent(id)}`)
  if (!res.ok) throw errorFrom(res.status, await res.text().catch(() => ''), retryAfterOf(res))
  return parseMediaView(await res.json())
}

/** Lädt die Datei eines gespeicherten Videos (Wiedergabe/Download). */
export async function fetchMediaFile(id: string): Promise<Blob> {
  const res = await fetch(`${API_BASE}/api/media/${encodeURIComponent(id)}/file`)
  if (!res.ok) throw errorFrom(res.status, await res.text().catch(() => ''), retryAfterOf(res))
  return await res.blob()
}

/**
 * Löscht ein Video sofort vom Server. Ein bereits fehlendes Video (404)
 * gilt als gelöscht. Wirft nur bei Netzwerk-/Serverfehlern.
 */
export async function deleteMedia(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/media/${encodeURIComponent(id)}`, { method: 'DELETE' })
  if (!res.ok && res.status !== 404)
    throw errorFrom(res.status, await res.text().catch(() => ''), retryAfterOf(res))
}

/** Parameter eines Bild-Clips (POST /api/media/still). */
export interface StillClipRequest {
  /** Hintergrund in Zielgröße (PNG). */
  image: Blob
  duration: number
  width: number
  height: number
  fps: number
  name?: string
}

/**
 * Erzeugt auf dem Server aus einem Bild einen Video-Clip mit stiller Tonspur
 * und legt ihn in der Bibliothek ab. Altes Backend (Route fehlt) ->
 * MEDIA_UNSUPPORTED.
 */
export async function createStillClip(
  req: StillClipRequest,
  signal?: AbortSignal,
): Promise<MediaView> {
  const form = new FormData()
  form.append('duration', String(req.duration))
  form.append('width', String(req.width))
  form.append('height', String(req.height))
  form.append('fps', String(req.fps))
  if (req.name) form.append('name', req.name)
  form.append('image', req.image, 'bild.png')
  const res = await fetch(`${API_BASE}/api/media/still`, { method: 'POST', body: form, signal })
  if (!res.ok) throw errorFrom(res.status, await res.text().catch(() => ''), retryAfterOf(res))
  return parseMediaView(await res.json())
}
