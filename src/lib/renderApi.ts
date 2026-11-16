import { API_BASE } from './apiBase'
import { MissingGraphicsError, parseMissingGraphics } from './graphicsApi'
import { fallbackErrorMessage, retryAfterOf } from './httpError'
import type { TimelineDoc } from '@/timeline/model'

/**
 * Client für den Export des Timeline-Editors. Der Server rendert die ganze
 * Timeline in voller Größe; Fortschritt, Download und Abbrechen laufen über
 * die Job-Endpunkte, die auch das Schneiden nutzt.
 */

/** Fehler-Kennung: Das Backend kennt den Export noch nicht (veraltet). */
export const RENDER_UNSUPPORTED = 'RENDER_UNSUPPORTED'

export const RENDER_QUALITIES = ['high', 'standard', 'small'] as const
export type RenderQuality = (typeof RENDER_QUALITIES)[number]

export interface RenderOptions {
  quality: RenderQuality
  /** Dateiname ohne Endung. */
  name: string
  /** Lautstärke des fertigen Tons angleichen (EBU R128). */
  normalizeAudio?: boolean
  /** Ohne Neu-Kodieren kopieren (nur im Sonderfall möglich, siehe `losslessCheck`). */
  lossless?: boolean
}

export interface RenderJob {
  jobId: string
  /** Hat der Server verlustfrei kopiert? `false` auch bei altem Backend, das die Option nicht kennt. */
  lossless: boolean
}

/** Export starten; liefert die Job-ID. */
export async function startRender(
  doc: TimelineDoc,
  options: RenderOptions,
  signal?: AbortSignal,
): Promise<string> {
  return (await startRenderJob(doc, options, signal)).jobId
}

/** Export starten; liefert die Job-ID und ob verlustfrei kopiert wird. */
export async function startRenderJob(
  doc: TimelineDoc,
  options: RenderOptions,
  signal?: AbortSignal,
): Promise<RenderJob> {
  const res = await fetch(`${API_BASE}/api/render`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      doc,
      quality: options.quality,
      name: options.name,
      normalizeAudio: options.normalizeAudio === true,
      ...(options.lossless === true ? { lossless: true } : {}),
    }),
    signal,
  })
  let data: { jobId?: unknown; error?: unknown; missingGraphics?: unknown; lossless?: unknown } = {}
  try {
    data = (await res.json()) as typeof data
  } catch {
    /* keine JSON-Antwort */
  }
  if (!res.ok) {
    const msg = typeof data.error === 'string' ? data.error : ''
    // Altes Backend: Route unbekannt -> generisches „Nicht gefunden.“ bzw. HTML.
    if (res.status === 404 && (!msg || msg === 'Nicht gefunden.'))
      throw new Error(RENDER_UNSUPPORTED)
    const missing = parseMissingGraphics(data.missingGraphics)
    if (res.status === 409 && missing.length > 0)
      throw new MissingGraphicsError(missing, msg || fallbackErrorMessage(409, null))
    throw new Error(msg || fallbackErrorMessage(res.status, retryAfterOf(res)))
  }
  if (typeof data.jobId !== 'string' || !data.jobId)
    throw new Error(fallbackErrorMessage(502, null))
  return { jobId: data.jobId, lossless: data.lossless === true }
}

export interface RenderWatch {
  /** Erfüllt, wenn der Export fertig ist; abgelehnt bei Fehler. */
  done: Promise<void>
  /** Beobachtung beenden (der Export läuft auf dem Server weiter). */
  stop: () => void
}

/** Fortschritt (0–100) eines Exports über Server-Sent Events verfolgen. */
export function watchRender(jobId: string, onProgress: (percent: number) => void): RenderWatch {
  const source = new EventSource(`${API_BASE}/api/cut/${encodeURIComponent(jobId)}/events`)
  const done = new Promise<void>((resolve, reject) => {
    source.onmessage = (ev) => {
      let data: { state?: unknown; progress?: unknown; error?: unknown }
      try {
        data = JSON.parse(String(ev.data)) as typeof data
      } catch {
        return
      }
      if (typeof data.progress === 'number' && Number.isFinite(data.progress))
        onProgress(Math.min(100, Math.max(0, data.progress)))
      if (data.state === 'done') {
        source.close()
        resolve()
      } else if (data.state === 'error') {
        source.close()
        reject(new Error(typeof data.error === 'string' ? data.error : 'Export fehlgeschlagen.'))
      }
    }
    source.onerror = () => {
      source.close()
      reject(new Error('Verbindung zum Server unterbrochen.'))
    }
  })
  return { done, stop: () => source.close() }
}

/** Laufenden Export abbrechen bzw. fertiges Ergebnis verwerfen. */
export async function cancelRender(jobId: string): Promise<void> {
  await fetch(`${API_BASE}/api/cut/${encodeURIComponent(jobId)}`, { method: 'DELETE' }).catch(
    () => undefined,
  )
}

/** Adresse zum Herunterladen; der Server räumt den Export danach auf. */
export const renderDownloadUrl = (jobId: string) =>
  `${API_BASE}/api/cut/${encodeURIComponent(jobId)}/download`
