import { API_BASE } from './apiBase'
import { fallbackErrorMessage, retryAfterOf } from './httpError'
import { parseMediaView, type MediaView } from './mediaApi'

/**
 * Client für gespeicherte Projekte (`/api/projects`): Bearbeitungsstand auf
 * dem Server ablegen, auflisten, öffnen und löschen.
 */

/** Fehler-Kennung: Das Backend kennt Projekte noch nicht (veraltet). */
export const PROJECTS_UNSUPPORTED = 'PROJECTS_UNSUPPORTED'

export interface ProjectSummary {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  videoCount: number
  size: number
}

/** Zusatzdatei (Bild, Musik), identifiziert per SHA-256. */
export interface AssetRef {
  hash: string
  size: number
  type: string
  name: string
}

export interface SaveRequest {
  id?: string
  name: string
  state: unknown
  media: string[]
  assets: AssetRef[]
}

/** Videos fehlen auf dem Server (Auto-Aufräumen/Neustart) -> neu hochladen. */
export class MissingMediaError extends Error {
  constructor(public readonly missing: string[]) {
    super('Einige Videos sind nicht mehr auf dem Server.')
    this.name = 'MissingMediaError'
  }
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0
}

export function parseSummary(data: unknown): ProjectSummary {
  const d = (data ?? {}) as Record<string, unknown>
  if (typeof d.id !== 'string' || !d.id) throw new Error('Ungültige Serverantwort (Projekt).')
  return {
    id: d.id,
    name: typeof d.name === 'string' && d.name ? d.name : 'Projekt',
    createdAt: num(d.createdAt),
    updatedAt: num(d.updatedAt),
    videoCount: num(d.videoCount),
    size: num(d.size),
  }
}

async function failure(res: Response): Promise<Error> {
  const text = await res.text().catch(() => '')
  let body: { error?: string; missingMedia?: unknown } = {}
  try {
    body = JSON.parse(text) as typeof body
  } catch {
    /* keine JSON-Antwort */
  }
  if (res.status === 409 && Array.isArray(body.missingMedia)) {
    return new MissingMediaError(body.missingMedia.filter((x) => typeof x === 'string'))
  }
  // Altes Backend: Route unbekannt -> generisches „Nicht gefunden." bzw. HTML.
  if (res.status === 404 && (!body.error || body.error === 'Nicht gefunden.')) {
    return new Error(PROJECTS_UNSUPPORTED)
  }
  return new Error(body.error || fallbackErrorMessage(res.status, retryAfterOf(res)))
}

const url = (p: string) => `${API_BASE}/api/projects${p}`
const enc = encodeURIComponent

export async function listProjects(signal?: AbortSignal): Promise<ProjectSummary[]> {
  const res = await fetch(url(''), { signal })
  if (!res.ok) throw await failure(res)
  const data = (await res.json()) as { projects?: unknown }
  return Array.isArray(data.projects) ? data.projects.map(parseSummary) : []
}

export async function saveProject(
  req: SaveRequest,
): Promise<{ project: ProjectSummary; missingAssets: string[] }> {
  const res = await fetch(url(''), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  })
  if (!res.ok) throw await failure(res)
  const data = (await res.json()) as { project?: unknown; missingAssets?: unknown }
  return {
    project: parseSummary(data.project),
    missingAssets: Array.isArray(data.missingAssets)
      ? data.missingAssets.filter((h): h is string => typeof h === 'string')
      : [],
  }
}

export async function uploadAsset(id: string, hash: string, file: Blob): Promise<void> {
  const res = await fetch(url(`/${enc(id)}/assets/${enc(hash)}`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file,
  })
  if (!res.ok) throw await failure(res)
}

export async function fetchProject(
  id: string,
): Promise<{ project: ProjectSummary; state: unknown }> {
  const res = await fetch(url(`/${enc(id)}`))
  if (!res.ok) throw await failure(res)
  const data = (await res.json()) as { project?: unknown; state?: unknown }
  return { project: parseSummary(data.project), state: data.state }
}

/** Meldet die Projektvideos in der Bibliothek an. Schlüssel = Verweis im Stand. */
export async function openProjectMedia(id: string): Promise<Record<string, MediaView>> {
  const res = await fetch(url(`/${enc(id)}/open`), { method: 'POST' })
  if (!res.ok) throw await failure(res)
  const data = (await res.json()) as { media?: Record<string, unknown> }
  const out: Record<string, MediaView> = {}
  for (const [k, v] of Object.entries(data.media ?? {})) out[k] = parseMediaView(v)
  return out
}

export async function fetchAsset(id: string, hash: string): Promise<Blob> {
  const res = await fetch(url(`/${enc(id)}/assets/${enc(hash)}`))
  if (!res.ok) throw await failure(res)
  return await res.blob()
}

export async function deleteProject(id: string): Promise<void> {
  const res = await fetch(url(`/${enc(id)}`), { method: 'DELETE' })
  if (!res.ok && res.status !== 404) throw await failure(res)
}

/** SHA-256 (hex) einer Datei – Kennung der Zusatzdateien. */
export async function sha256Hex(blob: Blob): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error('Prüfsumme nicht möglich (unsicherer Kontext).')
  const buf = await globalThis.crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('')
}
