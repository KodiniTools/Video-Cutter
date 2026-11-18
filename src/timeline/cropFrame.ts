import {
  clipEnd,
  normalizeCrop,
  type AssetRef,
  type ClipCrop,
  type Time,
  type VideoClip,
} from '@/timeline/model'

/** Voreingestellter Ausschnitt beim Einschalten (zentriert, 80 %, wie im bisherigen Editor). */
export const DEFAULT_CLIP_CROP: ClipCrop = { x: 0.1, y: 0.1, width: 0.8, height: 0.8 }

/**
 * Quellzeit (µs), deren Bild der Ausschnitt-Rahmen zeigt: die am Abspielkopf,
 * liegt er außerhalb des Clips, die am nächsten Rand des Clips.
 */
export function cropFrameSourceTime(
  clip: Pick<VideoClip, 'start' | 'duration' | 'sourceIn' | 'speed'>,
  playhead: Time,
): Time {
  // Das letzte Bild liegt knapp vor dem Clip-Ende.
  const last = Math.max(0, clip.duration - 1)
  const offset = Math.min(last, Math.max(0, playhead - clip.start))
  return Math.max(0, Math.round(clip.sourceIn + offset * clip.speed))
}

/** Liegt der Abspielkopf im Clip? */
export function playheadInClip(
  clip: Pick<VideoClip, 'start' | 'duration'>,
  playhead: Time,
): boolean {
  return playhead >= clip.start && playhead < clipEnd(clip)
}

/** Größe des Ausschnitts in Pixeln der Quelle; `null` ohne bekannte Größe. */
export function cropPixelSize(
  asset: Pick<AssetRef, 'width' | 'height'> | undefined,
  crop: ClipCrop | null | undefined,
): { width: number; height: number } | null {
  const w = asset?.width ?? 0
  const h = asset?.height ?? 0
  if (!(w > 0 && h > 0)) return null
  return {
    width: Math.round(w * (crop?.width ?? 1)),
    height: Math.round(h * (crop?.height ?? 1)),
  }
}

/** Gleicher Ausschnitt, so wie er gespeichert würde (das ganze Bild = keiner)? */
export function sameCrop(a: ClipCrop | null | undefined, b: ClipCrop | null | undefined): boolean {
  const x = normalizeCrop(a)
  const y = normalizeCrop(b)
  if (!x || !y) return !x && !y
  return x.x === y.x && x.y === y.y && x.width === y.width && x.height === y.height
}
