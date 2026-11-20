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
  /**
   * `audio` = reine Tondatei (Musik, Sprachaufnahme), `image` = eigenes Bild für
   * Bild-Einblendungen; beide nur im Timeline-Editor. Fehlt = Video.
   */
  kind?: 'video' | 'audio' | 'image'
}

/** Fehler-Kennung: Das Backend nimmt noch keine Bilder an (veraltet). */
export const MEDIA_IMAGE_UNSUPPORTED = 'MEDIA_IMAGE_UNSUPPORTED'

/** Bildarten, die die Medienliste annimmt (wie `imageAssets`). */
const IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/webp'])

/** Ist die Datei ein Bild für Bild-Einblendungen (JPEG, PNG, WebP)? */
export function isImageFile(file: Pick<File, 'type'>): boolean {
  return IMAGE_MIME.has(file.type)
}

/** Fehler-Kennung: Das Backend nimmt noch keine Tondateien an (veraltet). */
export const MEDIA_AUDIO_UNSUPPORTED = 'MEDIA_AUDIO_UNSUPPORTED'

/** Meldung eines älteren Backends, das nur Videos annimmt. */
const VIDEO_ONLY_MESSAGE = 'Nur Videodateien werden akzeptiert.'
/** Meldung eines älteren Backends, das nur Videos und Tondateien annimmt. */
const VIDEO_AUDIO_ONLY_MESSAGE = 'Nur Video- und Tondateien werden akzeptiert.'

/** Endungen üblicher Tondateien (manche Browser melden dafür keinen Typ). */
const AUDIO_EXT = /\.(mp3|m4a|aac|wav|ogg|oga|opus|flac|wma|aiff?)$/i

/** Ist die Datei eine Tondatei (nach Typ, sonst nach Endung)? */
export function isAudioFile(file: Pick<File, 'type' | 'name'>): boolean {
  return file.type.startsWith('audio/') || (!file.type && AUDIO_EXT.test(file.name))
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
    kind: d.kind === 'audio' || d.kind === 'image' ? d.kind : 'video',
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
        const err = errorFrom(xhr.status, xhr.responseText, xhr.getResponseHeader?.('Retry-After'))
        const oldBackend =
          err.message === VIDEO_ONLY_MESSAGE || err.message === VIDEO_AUDIO_ONLY_MESSAGE
        reject(
          oldBackend && isImageFile(file)
            ? new Error(MEDIA_IMAGE_UNSUPPORTED)
            : err.message === VIDEO_ONLY_MESSAGE && isAudioFile(file)
              ? new Error(MEDIA_AUDIO_UNSUPPORTED)
              : err,
        )
      }
    }
    xhr.onerror = () => reject(new Error('Upload fehlgeschlagen (Netzwerkfehler).'))
    xhr.onabort = () => reject(new Error(UPLOAD_ABORTED))
    const form = new FormData()
    // Ohne Typ (manche Tondateien) würde der Server die Datei ablehnen.
    if (!file.type && isAudioFile(file))
      form.append('video', new Blob([file], { type: 'audio/mpeg' }), file.name)
    else form.append('video', file)
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
  /** `false` = ohne stille Tonspur (Timeline-Editor). */
  audio?: boolean
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
  if (req.audio === false) form.append('audio', '0')
  form.append('image', req.image, 'bild.png')
  const res = await fetch(`${API_BASE}/api/media/still`, { method: 'POST', body: form, signal })
  if (!res.ok) throw errorFrom(res.status, await res.text().catch(() => ''), retryAfterOf(res))
  return parseMediaView(await res.json())
}
