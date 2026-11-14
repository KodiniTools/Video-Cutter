import { parseAudioFadeSettings, type AudioFadeSettings } from './audioFade'
import {
  clampGraphic,
  defaultGraphic,
  GRAPHIC_KINDS,
  type GraphicKind,
  type GraphicOverlay,
} from './graphicOverlay'
import {
  DEFAULT_TEXT_STYLE,
  MAX_TEXT_SIZE,
  MIN_TEXT_SIZE,
  TEXT_ANIMATIONS,
  TEXT_STYLES,
  type TextOverlay,
} from './textOverlay'
import type { CropRect, EditorSnapshot, OutputAspect, OutputFill } from '@/stores/videoEditor'
import type { SeamPreset } from '@/stores/library'
import { ANIMATIONS, type AnimationId } from '@/composables/useAnimationPref'

/**
 * Gespeicherter Bearbeitungsstand eines Projekts (reines JSON). Videos und
 * Zusatzdateien stehen nur als Verweis drin:
 *  - `media`: Bibliotheks-ID zum Zeitpunkt des Speicherns (der Server ordnet
 *    sie beim Öffnen einem neu angemeldeten Video zu),
 *  - `asset`: SHA-256 der Datei (Bild, Musik).
 * Der Rückgängig-Verlauf wird nicht gespeichert.
 */

export const PROJECT_STATE_VERSION = 1

export interface ProjectItemState {
  media: string
  name: string
  start: number
  end: number | null
  include: boolean
  /** Von im Gesamtvideo; fehlt/`null` = direkt nach dem vorigen Clip. */
  at?: number | null
  texts: TextOverlay[]
  /** Bild-Grafiken verweisen per `image` auf einen Schlüssel in `images`. */
  graphics: GraphicOverlay[]
}

export interface ProjectFileRef {
  asset: string
  name: string
  type: string
}

export interface ProjectMusicState extends ProjectFileRef {
  volume: number
  originalVolume: number
  fade: boolean
  loop: boolean
}

export interface ProjectState {
  version: typeof PROJECT_STATE_VERSION
  items: ProjectItemState[]
  /** Index des markierten Videos. */
  selected: number | null
  /** Übergang je Nahtstelle (Indizes der beiden Nachbarn). */
  seams: { from: number; to: number; preset: SeamPreset }[]
  normalizeAudio: boolean
  /** Auswahl/Ausschnitte/Zuschnitt des markierten Videos. */
  editor: EditorSnapshot | null
  output: { aspect: OutputAspect; fill: OutputFill }
  music: ProjectMusicState | null
  audioFade: AudioFadeSettings
  anim: { animation: AnimationId; duration: number }
  /** Bilder der Bild-Grafiken (Schlüssel = Bild-ID beim Speichern). */
  images: Record<string, ProjectFileRef>
}

const SEAMS: readonly SeamPreset[] = ['none', 'fade', 'slide', 'scale', 'flip']
const ASPECTS: readonly OutputAspect[] = ['auto', '16:9', '9:16', '1:1']
const FILLS: readonly OutputFill[] = ['pad', 'blur', 'crop']
const HASH_RE = /^[0-9a-f]{64}$/

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v)
const fin = (v: unknown, fb = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fb)
const str = (v: unknown, fb = ''): string => (typeof v === 'string' ? v : fb)
const oneOf = <T extends string>(v: unknown, list: readonly T[], fb: T): T =>
  typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : fb
const unit = (v: unknown, fb: number) => Math.min(1, Math.max(0, fin(v, fb)))

function parseText(v: unknown): TextOverlay | null {
  if (!isObj(v) || typeof v.text !== 'string') return null
  const d = DEFAULT_TEXT_STYLE
  return {
    id: fin(v.id),
    text: v.text,
    start: Math.max(0, fin(v.start)),
    end: fin(v.end),
    x: unit(v.x, d.x),
    y: unit(v.y, d.y),
    font: str(v.font, d.font) as TextOverlay['font'],
    size: Math.min(MAX_TEXT_SIZE, Math.max(MIN_TEXT_SIZE, fin(v.size, d.size))),
    color: str(v.color, d.color),
    style: oneOf(v.style, TEXT_STYLES, d.style),
    accent: str(v.accent, d.accent),
    animation: oneOf(v.animation, TEXT_ANIMATIONS, d.animation),
  }
}

function parseGraphic(v: unknown): GraphicOverlay | null {
  if (!isObj(v)) return null
  const kind = oneOf(v.kind, GRAPHIC_KINDS, 'rect' as GraphicKind)
  if (kind !== v.kind) return null
  // Fehlende Felder aus den Standardwerten; clampGraphic bringt Zahlen in Bereiche.
  return clampGraphic({
    ...defaultGraphic(kind),
    ...v,
    kind,
    id: fin(v.id),
    start: fin(v.start),
    end: fin(v.end),
    x: fin(v.x, 0.5),
    y: fin(v.y, 0.5),
    emoji: str(v.emoji),
    image: str(v.image),
  } as GraphicOverlay)
}

function parseCrop(v: unknown): CropRect | null {
  if (!isObj(v)) return null
  return { x: unit(v.x, 0), y: unit(v.y, 0), width: unit(v.width, 1), height: unit(v.height, 1) }
}

function parseEditor(v: unknown): EditorSnapshot | null {
  if (!isObj(v)) return null
  const segments = Array.isArray(v.segments)
    ? v.segments
        .filter(isObj)
        .map((s) => ({ start: Math.max(0, fin(s.start)), end: fin(s.end) }))
        .filter((s) => s.end > s.start)
    : []
  return {
    startTime: Math.max(0, fin(v.startTime)),
    endTime: Math.max(0, fin(v.endTime)),
    mode: v.mode === 'reencode' ? 'reencode' : 'copy',
    operation: v.operation === 'remove' ? 'remove' : 'keep',
    segments,
    crop: parseCrop(v.crop),
  }
}

function parseFileRef(v: unknown): ProjectFileRef | null {
  if (!isObj(v) || typeof v.asset !== 'string' || !HASH_RE.test(v.asset)) return null
  return { asset: v.asset, name: str(v.name, 'datei'), type: str(v.type) }
}

/**
 * Liest einen gespeicherten Stand robust ein (fehlende/kaputte Felder ->
 * Standardwerte). Wirft nur, wenn es gar kein Projektstand ist.
 */
export function parseProjectState(raw: unknown): ProjectState {
  if (!isObj(raw) || !Array.isArray(raw.items)) throw new Error('Ungültiger Projektstand.')
  const items: ProjectItemState[] = raw.items.filter(isObj).map((it) => ({
    media: str(it.media),
    name: str(it.name, 'video'),
    start: Math.max(0, fin(it.start)),
    end: typeof it.end === 'number' && Number.isFinite(it.end) ? it.end : null,
    include: it.include !== false,
    at: typeof it.at === 'number' && Number.isFinite(it.at) && it.at >= 0 ? it.at : null,
    texts: Array.isArray(it.texts)
      ? it.texts.map(parseText).filter((t): t is TextOverlay => t !== null)
      : [],
    graphics: Array.isArray(it.graphics)
      ? it.graphics.map(parseGraphic).filter((g): g is GraphicOverlay => g !== null)
      : [],
  }))
  const n = items.length
  const idx = (v: unknown) => (Number.isInteger(v) && fin(v) >= 0 && fin(v) < n ? fin(v) : null)
  const seams = Array.isArray(raw.seams)
    ? raw.seams.filter(isObj).flatMap((s) => {
        const from = idx(s.from)
        const to = idx(s.to)
        const preset = oneOf(s.preset, SEAMS, 'none')
        return from !== null && to !== null && SEAMS.includes(s.preset as SeamPreset)
          ? [{ from, to, preset }]
          : []
      })
    : []
  const output = isObj(raw.output) ? raw.output : {}
  const anim = isObj(raw.anim) ? raw.anim : {}
  const animIds = ANIMATIONS.map((a) => a.id)
  let music: ProjectMusicState | null = null
  const ref = parseFileRef(raw.music)
  if (ref && isObj(raw.music)) {
    const m = raw.music
    music = {
      ...ref,
      volume: unit(m.volume, 0.3),
      originalVolume: unit(m.originalVolume, 1),
      fade: m.fade !== false,
      loop: m.loop !== false,
    }
  }
  const images: Record<string, ProjectFileRef> = {}
  if (isObj(raw.images)) {
    for (const [k, v] of Object.entries(raw.images)) {
      const r = parseFileRef(v)
      if (r) images[k] = r
    }
  }
  return {
    version: PROJECT_STATE_VERSION,
    items,
    selected: idx(raw.selected),
    seams,
    normalizeAudio: raw.normalizeAudio === true,
    editor: parseEditor(raw.editor),
    output: {
      aspect: oneOf(output.aspect, ASPECTS, 'auto'),
      fill: oneOf(output.fill, FILLS, 'pad'),
    },
    music,
    audioFade: parseAudioFadeSettings(JSON.stringify(raw.audioFade ?? null)),
    anim: {
      animation: oneOf(anim.animation, animIds, 'fade'),
      duration: Math.min(10, Math.max(1, Math.round(fin(anim.duration, 2)))),
    },
    images,
  }
}

/** Passt eine gespeicherte Auswahl an die tatsächliche Videodauer an. */
export function fitEditorSnapshot(s: EditorSnapshot, duration: number): EditorSnapshot {
  if (!(duration > 0)) return s
  const c = (v: number) => Math.min(duration, Math.max(0, v))
  const segments = s.segments
    .map((seg) => ({ start: c(seg.start), end: c(seg.end) }))
    .filter((seg) => seg.end - seg.start > 0.01)
  const startTime = c(s.startTime)
  return { ...s, startTime, endTime: Math.max(startTime, c(s.endTime)), segments }
}
