import { motionAt } from './layoutKeys'
import type { OverlayClip, Time } from './model'

/**
 * Keyframes für Formen, Symbole, Emojis und Bilder: Mitte und Größe ändern
 * sich über die Zeit. Sie liegen in `data.keys` des Clips; `at` zählt ab
 * Clip-Anfang (µs) und darf nach dem Kürzen auch davor oder dahinter liegen.
 * `data.x`/`data.y` spiegeln den ersten Keyframe.
 */
export interface GraphicKey {
  at: Time
  /** Mitte als Anteil des Projektformats (0…1). */
  x: number
  y: number
  /** Größe als Faktor der gezeichneten Grafik (1 = wie eingestellt). */
  scale: number
}
export type GraphicMotion = Omit<GraphicKey, 'at'>

export const MAX_GRAPHIC_KEYS = 32
export const MIN_KEY_SCALE = 0.1
export const MAX_KEY_SCALE = 3
/** So nah an einem Keyframe gilt der Abspielkopf als „auf dem Keyframe“. */
export const GRAPHIC_KEY_SNAP: Time = 20_000

type KeyedClip = Pick<OverlayClip, 'duration' | 'data'>

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v))
const round4 = (v: number) => Math.round(v * 10000) / 10000
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** Keyframes des Clips: gültig, in Grenzen, nach Zeit sortiert, je Zeit einer. */
export function graphicKeys(data: Record<string, unknown>): GraphicKey[] {
  if (!Array.isArray(data.keys)) return []
  const keys: GraphicKey[] = []
  for (const raw of data.keys as unknown[]) {
    if (typeof raw !== 'object' || raw === null) continue
    const k = raw as Record<string, unknown>
    if (!Number.isSafeInteger(k.at) || !finite(k.x) || !finite(k.y)) continue
    keys.push({
      at: k.at as number,
      x: round4(clamp(k.x, 0, 1)),
      y: round4(clamp(k.y, 0, 1)),
      scale: round4(clamp(finite(k.scale) ? k.scale : 1, MIN_KEY_SCALE, MAX_KEY_SCALE)),
    })
  }
  keys.sort((a, b) => a.at - b.at)
  return keys.filter((k, i) => i === 0 || k.at !== keys[i - 1].at).slice(0, MAX_GRAPHIC_KEYS)
}

/** Weiche Bewegung zwischen den Keyframes? */
export function graphicSmooth(data: Record<string, unknown>): boolean {
  return data.ease === 'smooth'
}

const basePosition = (data: Record<string, unknown>): GraphicMotion => ({
  x: finite(data.x) ? clamp(data.x, 0, 1) : 0.5,
  y: finite(data.y) ? clamp(data.y, 0, 1) : 0.5,
  scale: 1,
})

/** Mitte und Größe zur Zeit `offset` (ab Clip-Anfang). */
export function graphicMotionAt(clip: KeyedClip, offset: Time): GraphicMotion {
  const keys = graphicKeys(clip.data)
  if (keys.length === 0) return basePosition(clip.data)
  const { x, y, scale } = motionAt(keys, offset, 1, graphicSmooth(clip.data))
  return { x, y, scale }
}

/** Index des Keyframes an dieser Stelle des Clips, sonst −1. */
export function graphicKeyIndexAt(clip: KeyedClip, offset: Time): number {
  return graphicKeys(clip.data).findIndex((k) => Math.abs(k.at - offset) <= GRAPHIC_KEY_SNAP)
}

/** Keyframes im sichtbaren Teil des Clips. */
export function visibleGraphicKeys(clip: KeyedClip): Array<{ index: number; offset: Time }> {
  return graphicKeys(clip.data)
    .map((k, index) => ({ index, offset: k.at }))
    .filter((k) => k.offset >= 0 && k.offset <= clip.duration)
}

export function canAddGraphicKey(clip: KeyedClip, offset: Time): boolean {
  return graphicKeyIndexAt(clip, offset) < 0 && graphicKeys(clip.data).length < MAX_GRAPHIC_KEYS
}

/** Änderung an `data`, die diese Keyframes speichert (x/y spiegeln den ersten). */
function keysPatch(keys: GraphicKey[]): Record<string, unknown> {
  return keys.length > 0 ? { keys, x: keys[0].x, y: keys[0].y } : { keys: [] }
}

/**
 * Keyframe an dieser Stelle setzen: mit dem Stand, der dort gerade gilt, plus
 * `patch`. Liegt dort schon einer, wird er geändert. Liefert die Änderung für
 * `updateClipData`.
 */
export function withGraphicKeyAt(
  clip: KeyedClip,
  offset: Time,
  patch: Partial<GraphicMotion> = {},
): Record<string, unknown> {
  const keys = graphicKeys(clip.data)
  const index = graphicKeyIndexAt(clip, offset)
  // Auf einem Keyframe zählen dessen Werte, nicht die knapp daneben.
  const base = index >= 0 ? keys[index] : graphicMotionAt(clip, offset)
  const key: GraphicKey = {
    at: index >= 0 ? keys[index].at : Math.round(offset),
    x: round4(clamp(patch.x ?? base.x, 0, 1)),
    y: round4(clamp(patch.y ?? base.y, 0, 1)),
    scale: round4(clamp(patch.scale ?? base.scale, MIN_KEY_SCALE, MAX_KEY_SCALE)),
  }
  if (index >= 0) keys[index] = key
  else if (keys.length < MAX_GRAPHIC_KEYS) keys.push(key)
  keys.sort((a, b) => a.at - b.at)
  return keysPatch(keys)
}

/**
 * Mitte oder Größe an dieser Stelle ändern. Ohne Keyframes gilt die Mitte für
 * den ganzen Clip. Mit Keyframes landet die Änderung im Keyframe an dieser
 * Stelle (er entsteht, falls dort keiner liegt).
 */
export function withGraphicChange(
  clip: KeyedClip,
  offset: Time,
  patch: Partial<GraphicMotion>,
): Record<string, unknown> {
  if (graphicKeys(clip.data).length > 0) return withGraphicKeyAt(clip, offset, patch)
  const out: Record<string, unknown> = {}
  if (patch.x !== undefined) out.x = clamp(patch.x, 0, 1)
  if (patch.y !== undefined) out.y = clamp(patch.y, 0, 1)
  return out
}

/** Keyframe entfernen. Der letzte hinterlässt seine Mitte als feste Lage. */
export function withoutGraphicKey(clip: KeyedClip, index: number): Record<string, unknown> {
  const keys = graphicKeys(clip.data)
  if (index < 0 || index >= keys.length) return {}
  const rest = keys.filter((_, i) => i !== index)
  if (rest.length > 0) return keysPatch(rest)
  return { keys: [], x: keys[index].x, y: keys[index].y }
}
