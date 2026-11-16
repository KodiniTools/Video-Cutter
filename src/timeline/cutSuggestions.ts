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
