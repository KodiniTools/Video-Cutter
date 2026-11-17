import type { AudioClip, Time, VolumePoint } from './model'

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
