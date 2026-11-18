import {
  clipEnd,
  MIN_CLIP_DURATION,
  secondsToTime,
  snapToFrame,
  type AudioClip,
  type Time,
  type VideoClip,
} from './model'

/** Bereich in Sekunden der Quelldatei (Schnittvorschlag der KI). */
export interface SourceRange {
  start: number
  end: number
}

/**
 * Bereich der Quelle als Bereich auf der Timeline, über Beginn, Quell-Beginn
 * und Tempo des Clips umgerechnet, auf den Clip begrenzt und aufs Bildraster
 * gelegt. `null`, wenn (fast) nichts davon im Clip liegt.
 */
export function sourceRangeOnTimeline(
  clip: VideoClip | AudioClip,
  range: SourceRange,
  fps: number,
): { start: Time; end: Time } | null {
  if (!Number.isFinite(range.start) || !Number.isFinite(range.end)) return null
  const toTimeline = (sec: number): Time =>
    clip.start + Math.round((secondsToTime(sec) - clip.sourceIn) / clip.speed)
  const start = snapToFrame(Math.max(clip.start, toTimeline(range.start)), fps)
  const end = snapToFrame(Math.min(clipEnd(clip), toTimeline(range.end)), fps)
  return end - start >= MIN_CLIP_DURATION ? { start, end } : null
}

/** Bereich auf der Timeline (µs). */
export interface TimeRange {
  start: Time
  end: Time
}

/**
 * Bereiche sortieren und Überlappungen bzw. aneinanderstoßende Bereiche
 * zusammenfassen. Leere oder ungültige Bereiche fallen weg.
 */
export function mergeRanges(ranges: readonly TimeRange[]): TimeRange[] {
  const sorted = ranges
    .filter((r) => Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start)
    .map((r) => ({ start: r.start, end: r.end }))
    .sort((a, b) => a.start - b.start)
  const out: TimeRange[] = []
  for (const r of sorted) {
    const prev = out[out.length - 1]
    if (prev && r.start <= prev.end) prev.end = Math.max(prev.end, r.end)
    else out.push(r)
  }
  return out
}

/**
 * Probehören: Liegt `time` in einem der (zusammengefassten) Bereiche, das
 * Ende dieses Bereichs, sonst `null`. Dorthin springt die Wiedergabe.
 */
export function skipTarget(time: Time, ranges: readonly TimeRange[]): Time | null {
  for (const r of ranges) {
    if (time < r.start) return null
    if (time < r.end) return r.end
  }
  return null
}

/**
 * Lage eines Bereichs der Timeline auf einem Clip in Prozent seiner Breite
 * (für die Markierung auf dem Clip). `null`, wenn er nicht im Clip liegt.
 */
export function rangeOnClip(
  clip: { start: Time; duration: Time },
  range: TimeRange,
): { left: number; width: number } | null {
  if (clip.duration <= 0) return null
  const start = Math.max(clip.start, range.start)
  const end = Math.min(clip.start + clip.duration, range.end)
  if (end <= start) return null
  return {
    left: ((start - clip.start) / clip.duration) * 100,
    width: ((end - start) / clip.duration) * 100,
  }
}
