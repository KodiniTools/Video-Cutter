import type { MediaView } from '@/lib/mediaApi'
import { assetFromMedia } from './assets'
import {
  TIMELINE_DOC_VERSION,
  type AssetRef,
  type Clip,
  type Marker,
  type TimelineDoc,
  type TimelineSettings,
  type Track,
} from './model'

/**
 * Gespeicherter Stand eines Projekts des Timeline-Editors (reines TypeScript).
 *
 * Der Server bewahrt den Stand unverändert auf. Er kennt nur die Videos (IDs
 * der Bibliothek) und die Zusatzdateien (Originale der Bild-Clips, per
 * SHA-256). Beim Öffnen meldet er die Videos neu an – sie bekommen dabei neue
 * IDs – und `rebindProject` schreibt das Dokument auf diese IDs um.
 */

/** Kennzeichen im Stand: daran erkennt der Server ein Timeline-Projekt. */
export const TIMELINE_PROJECT_FORMAT = 'timeline'
export const TIMELINE_PROJECT_VERSION = 2

/** Verweis auf eine Zusatzdatei des Projekts (wie im bisherigen Editor). */
export interface ProjectImageRef {
  /** SHA-256 der Datei. */
  asset: string
  name: string
  type: string
}

export interface TimelineProjectState {
  format: typeof TIMELINE_PROJECT_FORMAT
  version: typeof TIMELINE_PROJECT_VERSION
  doc: TimelineDoc
  /** Originale der Bild-Clips. Schlüssel = Bild-ID, die im Dokument steht. */
  images: Record<string, ProjectImageRef>
}

/** Warum ein Stand nicht gelesen werden kann. */
export type TimelineProjectIssue = 'format' | 'version' | 'invalid'

export class TimelineProjectError extends Error {
  constructor(public readonly code: TimelineProjectIssue) {
    super(`Projekt nicht lesbar (${code}).`)
    this.name = 'TimelineProjectError'
  }
}

type Obj = Record<string, unknown>

const HASH_RE = /^[0-9a-f]{64}$/
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isId = (v: unknown): v is string => typeof v === 'string' && v !== ''

function invalid(): never {
  throw new TimelineProjectError('invalid')
}

function parseSettings(v: unknown): TimelineSettings {
  if (!isObj(v)) invalid()
  const { width, height, fps, background, sampleRate } = v
  if (!isNum(width) || !isNum(height) || !isNum(fps) || !isNum(sampleRate)) invalid()
  if (width <= 0 || height <= 0 || fps <= 0 || sampleRate <= 0) invalid()
  if (typeof background !== 'string') invalid()
  return { width, height, fps, background, sampleRate }
}

function parseAsset(key: string, v: unknown): AssetRef {
  if (!isObj(v) || v.id !== key) invalid()
  if (v.kind !== 'video' && v.kind !== 'audio' && v.kind !== 'image') invalid()
  if (v.duration !== null && !isNum(v.duration)) invalid()
  const asset: AssetRef = {
    id: key,
    kind: v.kind,
    name: typeof v.name === 'string' ? v.name : '',
    duration: v.duration,
  }
  if (isNum(v.width)) asset.width = v.width
  if (isNum(v.height)) asset.height = v.height
  if (isNum(v.fps)) asset.fps = v.fps
  if (typeof v.hasAudio === 'boolean') asset.hasAudio = v.hasAudio
  return asset
}

/** Nur die Form prüfen; die Regeln des Modells prüft danach `validateDoc`. */
function parseClip(v: unknown): Clip {
  if (!isObj(v) || !isId(v.id) || !isNum(v.start) || !isNum(v.duration)) invalid()
  if (v.linkGroup !== undefined && typeof v.linkGroup !== 'string') invalid()
  switch (v.kind) {
    case 'video':
    case 'still':
    case 'audio':
      if (!isId(v.asset) || !isNum(v.sourceIn) || !isNum(v.speed)) invalid()
      if (v.kind === 'audio' && !isNum(v.gain)) invalid()
      if (v.kind !== 'audio' && v.crop != null && !isObj(v.crop)) invalid()
      if (v.kind !== 'audio' && v.transitionIn !== undefined && !isObj(v.transitionIn)) invalid()
      break
    case 'text':
    case 'graphic':
    case 'image':
      if (!isObj(v.data)) invalid()
      if (v.asset !== undefined && !isId(v.asset)) invalid()
      break
    default:
      invalid()
  }
  return v as unknown as Clip
}

function parseTrack(v: unknown): Track {
  if (!isObj(v) || !isId(v.id) || typeof v.name !== 'string') invalid()
  if (typeof v.locked !== 'boolean' || !Array.isArray(v.clips)) invalid()
  if (v.kind === 'audio') {
    if (typeof v.muted !== 'boolean' || typeof v.solo !== 'boolean' || !isNum(v.volume)) invalid()
  } else if (v.kind === 'video' || v.kind === 'overlay') {
    if (typeof v.hidden !== 'boolean') invalid()
  } else invalid()
  return { ...v, clips: v.clips.map(parseClip) } as unknown as Track
}

function parseMarker(v: unknown): Marker {
  if (!isObj(v) || !isId(v.id) || !isNum(v.at)) invalid()
  return { id: v.id, at: v.at, label: typeof v.label === 'string' ? v.label : '' }
}

function parseDoc(v: unknown): TimelineDoc {
  if (!isObj(v) || !isObj(v.assets) || !Array.isArray(v.tracks)) invalid()
  if (v.version !== TIMELINE_DOC_VERSION) throw new TimelineProjectError('version')
  const assets: Record<string, AssetRef> = {}
  for (const [key, a] of Object.entries(v.assets)) assets[key] = parseAsset(key, a)
  return {
    version: TIMELINE_DOC_VERSION,
    settings: parseSettings(v.settings),
    assets,
    tracks: v.tracks.map(parseTrack),
    markers: Array.isArray(v.markers) ? v.markers.map(parseMarker) : [],
  }
}

/** Ist das ein Stand des Timeline-Editors (und kein Projekt der bisherigen App)? */
export function isTimelineProject(raw: unknown): boolean {
  return isObj(raw) && raw.format === TIMELINE_PROJECT_FORMAT
}

/** Liest einen Stand vom Server. Wirft `TimelineProjectError`. */
export function parseTimelineProject(raw: unknown): TimelineProjectState {
  if (!isTimelineProject(raw)) throw new TimelineProjectError('format')
  const r = raw as Obj
  if (r.version !== TIMELINE_PROJECT_VERSION) throw new TimelineProjectError('version')
  const images: Record<string, ProjectImageRef> = {}
  if (isObj(r.images)) {
    for (const [id, ref] of Object.entries(r.images)) {
      if (!isObj(ref) || typeof ref.asset !== 'string' || !HASH_RE.test(ref.asset)) continue
      images[id] = {
        asset: ref.asset,
        name: typeof ref.name === 'string' && ref.name ? ref.name : 'bild',
        type: typeof ref.type === 'string' ? ref.type : '',
      }
    }
  }
  return {
    format: TIMELINE_PROJECT_FORMAT,
    version: TIMELINE_PROJECT_VERSION,
    doc: parseDoc(r.doc),
    images,
  }
}

/** Bild-ID eines Bild-Clips (Grafik der Art `image`), sonst `null`. */
function clipImage(clip: Clip): string | null {
  if (clip.kind !== 'graphic' || clip.data.kind !== 'image') return null
  return typeof clip.data.image === 'string' ? clip.data.image : ''
}

/** IDs der Bilder, die das Dokument verwendet (jede einmal). */
export function usedImageIds(doc: TimelineDoc): string[] {
  const ids = new Set<string>()
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      const id = clipImage(clip)
      if (id) ids.add(id)
    }
  }
  return [...ids]
}

export function buildTimelineProject(
  doc: TimelineDoc,
  images: Record<string, ProjectImageRef>,
): TimelineProjectState {
  return { format: TIMELINE_PROJECT_FORMAT, version: TIMELINE_PROJECT_VERSION, doc, images }
}

export interface ReboundProject {
  doc: TimelineDoc
  /** Videos des Dokuments in der Reihenfolge des Stands (für die Medienliste). */
  media: MediaView[]
  /** So viele Videos bzw. Bilder ließen sich nicht wiederherstellen. */
  missing: number
}

/**
 * Schreibt ein geladenes Dokument auf die neu angemeldeten Videos und die neu
 * geladenen Bilder um.
 *
 * @param media   je gespeicherter Video-ID das jetzt angemeldete Video
 * @param images  je gespeicherter Bild-ID die ID des jetzt geladenen Bildes
 *
 * Clips, deren Video fehlt, entfallen. Bild-Clips, deren Bild fehlt, bleiben
 * mit leerem Verweis stehen (der Editor zeigt dann „Bild fehlt“).
 */
export function rebindProject(
  doc: TimelineDoc,
  media: Readonly<Record<string, MediaView>>,
  images: ReadonlyMap<string, string>,
): ReboundProject {
  let missing = 0
  const assets: Record<string, AssetRef> = {}
  const ids = new Map<string, string>()
  const list: MediaView[] = []
  for (const oldId of Object.keys(doc.assets)) {
    const view = media[oldId]
    if (!view) {
      missing++
      continue
    }
    ids.set(oldId, view.id)
    if (!assets[view.id]) list.push(view)
    assets[view.id] = assetFromMedia(view)
  }
  for (const id of usedImageIds(doc)) if (!images.has(id)) missing++

  const tracks = doc.tracks.map((track) => {
    const clips = (track.clips as Clip[]).flatMap((clip): Clip[] => {
      if ('asset' in clip && clip.asset !== undefined) {
        const next = ids.get(clip.asset)
        return next === undefined ? [] : [{ ...clip, asset: next }]
      }
      if (clip.kind !== 'graphic' || clip.data.kind !== 'image') return [clip]
      const image = typeof clip.data.image === 'string' ? clip.data.image : ''
      return [{ ...clip, data: { ...clip.data, image: images.get(image) ?? '' } }]
    })
    return { ...track, clips } as Track
  })
  return { doc: { ...doc, assets, tracks }, media: list, missing }
}
