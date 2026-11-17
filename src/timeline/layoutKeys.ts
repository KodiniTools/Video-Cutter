import { clipToSource, sourceToClip } from './envelope'
import {
  MAX_LAYOUT_KEYS,
  type ClipLayout,
  type LayoutKey,
  type Time,
  type VideoClip,
} from './model'

type KeyedClip = Pick<VideoClip, 'sourceIn' | 'speed' | 'duration' | 'layout'>
/** Was Keyframes ändern: Mitte, Größe und Deckkraft. */
export type LayoutMotion = Pick<ClipLayout, 'x' | 'y' | 'scale' | 'opacity'>

/** Volle Größe, volle Deckkraft: der Stand ohne Lage. */
export const FULL_LAYOUT: ClipLayout = { x: 0.5, y: 0.5, scale: 1, opacity: 1 }

/** So nah an einem Keyframe gilt der Abspielkopf als „auf dem Keyframe“ (Quellzeit). */
export const KEY_SNAP: Time = 20_000

/**
 * Lage an einer Quellzeit: gleichmäßig zwischen den Keyframes, außen gehalten.
 * `opacity` ist die Deckkraft des Clips für Keyframes ohne eigene.
 */
export function motionAt(keys: readonly LayoutKey[], at: Time, opacity = 1): LayoutMotion {
  const pick = (k: LayoutKey): LayoutMotion => ({
    x: k.x,
    y: k.y,
    scale: k.scale,
    opacity: k.opacity ?? opacity,
  })
  if (at <= keys[0].at) return pick(keys[0])
  for (let i = 1; i < keys.length; i++) {
    const a = pick(keys[i - 1])
    const b = pick(keys[i])
    if (at < keys[i].at) {
      const f = (at - keys[i - 1].at) / (keys[i].at - keys[i - 1].at)
      const mix = (from: number, to: number) => Math.round((from + (to - from) * f) * 10000) / 10000
      return {
        x: mix(a.x, b.x),
        y: mix(a.y, b.y),
        scale: mix(a.scale, b.scale),
        opacity: mix(a.opacity, b.opacity),
      }
    }
  }
  return pick(keys[keys.length - 1])
}

/** Lage des Clips zur Zeit `offset` (ab Clip-Anfang, auf der Timeline gemessen). */
export function layoutAt(clip: KeyedClip, offset: Time): ClipLayout {
  const layout = clip.layout
  if (!layout) return FULL_LAYOUT
  if (!layout.keys?.length) return layout
  return motionAt(layout.keys, clipToSource(clip, offset), layout.opacity)
}

/** Index des Keyframes an dieser Stelle des Clips, sonst −1. */
export function keyIndexAt(clip: KeyedClip, offset: Time): number {
  const at = clipToSource(clip, offset)
  return (clip.layout?.keys ?? []).findIndex((k) => Math.abs(k.at - at) <= KEY_SNAP)
}

/** Keyframes im sichtbaren Teil des Clips mit ihrer Zeit im Clip. */
export function visibleKeys(clip: KeyedClip): Array<{ index: number; offset: Time }> {
  return (clip.layout?.keys ?? [])
    .map((k, index) => ({ index, offset: sourceToClip(clip, k.at) }))
    .filter((k) => k.offset >= 0 && k.offset <= clip.duration)
}

/** Kann der Clip noch einen Keyframe an dieser Stelle bekommen? */
export function canAddKey(clip: KeyedClip, offset: Time): boolean {
  return keyIndexAt(clip, offset) < 0 && (clip.layout?.keys?.length ?? 0) < MAX_LAYOUT_KEYS
}

/**
 * Keyframe an dieser Stelle setzen: mit der Lage, die dort gerade gilt, plus
 * `patch`. Liegt dort schon einer, wird er geändert. Liefert die neue Lage.
 */
export function withKeyAt(
  clip: KeyedClip,
  offset: Time,
  patch: Partial<LayoutMotion> = {},
): ClipLayout {
  const now = layoutAt(clip, offset)
  const keys = (clip.layout?.keys ?? []).slice()
  const index = keyIndexAt(clip, offset)
  // Auf einem Keyframe zählen dessen Werte, nicht die knapp daneben.
  const base = index >= 0 ? keys[index] : now
  const key: LayoutKey = {
    at: index >= 0 ? keys[index].at : clipToSource(clip, offset),
    x: patch.x ?? base.x,
    y: patch.y ?? base.y,
    scale: patch.scale ?? base.scale,
    opacity: patch.opacity ?? base.opacity ?? now.opacity,
  }
  if (index >= 0) keys[index] = key
  else if (keys.length < MAX_LAYOUT_KEYS) keys.push(key)
  keys.sort((a, b) => a.at - b.at)
  return { ...now, keys }
}

/**
 * Lage an dieser Stelle ändern. Ohne Keyframes gilt die Änderung für den
 * ganzen Clip. Mit Keyframes landet sie im Keyframe an dieser Stelle (er
 * entsteht, falls dort keiner liegt).
 */
export function withLayoutChange(
  clip: KeyedClip,
  offset: Time,
  patch: Partial<LayoutMotion>,
): ClipLayout {
  const layout = clip.layout
  if (!layout?.keys?.length) return { ...(layout ?? FULL_LAYOUT), ...patch }
  return withKeyAt(clip, offset, patch)
}

/** Keyframe entfernen. Der letzte hinterlässt seine Werte als feste Lage. */
export function withoutKey(clip: KeyedClip, index: number): ClipLayout | null {
  const layout = clip.layout
  const keys = layout?.keys ?? []
  if (!layout || index < 0 || index >= keys.length) return layout ?? null
  const rest = keys.filter((_, i) => i !== index)
  if (rest.length > 0) return { ...layout, keys: rest }
  const last = keys[index]
  return { x: last.x, y: last.y, scale: last.scale, opacity: last.opacity ?? layout.opacity }
}
