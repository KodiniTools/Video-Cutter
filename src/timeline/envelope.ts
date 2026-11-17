import { MAX_CLIP_GAIN, type AudioClip, type Time, type VolumePoint } from './model'

/** Faktor der Kurve an einer Quellzeit: linear zwischen den Punkten, außen gehalten. */
export function envelopeAt(points: readonly VolumePoint[] | undefined, at: Time): number {
  if (!points || points.length === 0) return 1
  if (at <= points[0].at) return points[0].gain
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    if (at < b.at) return a.gain + ((b.gain - a.gain) * (at - a.at)) / (b.at - a.at)
  }
  return points[points.length - 1].gain
}

/** Quellzeit zu einer Zeit im Clip (ab Clip-Anfang, auf der Timeline gemessen). */
export function clipToSource(clip: Pick<AudioClip, 'sourceIn' | 'speed'>, offset: Time): Time {
  return Math.max(0, Math.round(clip.sourceIn + offset * clip.speed))
}

/** Zeit im Clip (ab Clip-Anfang) zu einer Quellzeit; kann außerhalb des Clips liegen. */
export function sourceToClip(clip: Pick<AudioClip, 'sourceIn' | 'speed'>, at: Time): Time {
  return Math.round((at - clip.sourceIn) / clip.speed)
}

/** Punkte, die im sichtbaren Teil des Clips liegen, mit ihrer Zeit im Clip. */
export function visiblePoints(
  clip: Pick<AudioClip, 'sourceIn' | 'speed' | 'duration' | 'envelope'>,
): Array<{ index: number; offset: Time; gain: number }> {
  return (clip.envelope ?? [])
    .map((p, index) => ({ index, offset: sourceToClip(clip, p.at), gain: p.gain }))
    .filter((p) => p.offset >= 0 && p.offset <= clip.duration)
}

/**
 * Linie der Kurve über die Clip-Länge als Punkte `[Anteil 0…1, Faktor]`:
 * Anfang, jeder sichtbare Punkt, Ende.
 */
export function envelopeLine(
  clip: Pick<AudioClip, 'sourceIn' | 'speed' | 'duration' | 'envelope'>,
): Array<[number, number]> {
  if (!clip.envelope?.length || clip.duration <= 0) return []
  const line: Array<[number, number]> = [[0, envelopeAt(clip.envelope, clipToSource(clip, 0))]]
  for (const p of visiblePoints(clip)) {
    if (p.offset > 0 && p.offset < clip.duration) line.push([p.offset / clip.duration, p.gain])
  }
  line.push([1, envelopeAt(clip.envelope, clipToSource(clip, clip.duration))])
  return line
}

/** Kleinster Abstand zweier Punkte beim Ziehen (Quellzeit). */
export const MIN_POINT_GAP: Time = 10_000
/** Nahe an 100 % rastet ein gezogener Punkt dort ein. */
const UNITY_SNAP = 0.04

/**
 * Punkt `index` auf eine neue Stelle im Clip ziehen: `offset` ist die Zeit ab
 * Clip-Anfang, `gain` der Faktor. Der Punkt bleibt im Clip und zwischen
 * seinen Nachbarn; nahe 100 % rastet er ein. Liefert die neuen Punkte.
 */
export function movePoint(
  clip: Pick<AudioClip, 'sourceIn' | 'speed' | 'duration' | 'envelope'>,
  index: number,
  to: { offset: Time; gain: number },
): VolumePoint[] {
  const points = clip.envelope ?? []
  if (index < 0 || index >= points.length) return points.slice()
  const offset = Math.min(clip.duration, Math.max(0, to.offset))
  let at = clipToSource(clip, offset)
  const prev = points[index - 1]
  const next = points[index + 1]
  if (prev) at = Math.max(at, prev.at + MIN_POINT_GAP)
  if (next) at = Math.min(at, next.at - MIN_POINT_GAP)
  // Liegen die Nachbarn enger als der Mindestabstand, bleibt die Zeit stehen.
  if ((prev && at <= prev.at) || (next && at >= next.at)) at = points[index].at
  let gain = Math.min(MAX_CLIP_GAIN, Math.max(0, to.gain))
  if (Math.abs(gain - 1) < UNITY_SNAP) gain = 1
  gain = Math.round(gain * 100) / 100
  return points.map((p, i) => (i === index ? { at, gain } : p))
}
