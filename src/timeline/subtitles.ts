import { DEFAULT_TEXT_STYLE, MIN_TEXT_DURATION } from '@/lib/textOverlay'
import type { TextDefault } from './textDefault'
import {
  clipEnd,
  createId,
  secondsToTime,
  snapToFrame,
  type AudioClip,
  type OverlayClip,
  type Time,
  type TimelineDoc,
  type VideoClip,
} from './model'

/** Untertitel aus der KI: Zeiten in Sekunden der Quelldatei. */
export interface Cue {
  start: number
  end: number
  text: string
}

/** Darstellung neuer Untertitel: unten, ohne Animation. */
export const SUBTITLE_STYLE: Record<string, unknown> = {
  ...DEFAULT_TEXT_STYLE,
  animation: 'none',
  animSpeed: 1,
}

const STYLE_KEYS = ['x', 'y', 'font', 'size', 'color', 'style', 'accent', 'animation', 'animSpeed']

/**
 * Vorlage für neue Untertitel: der gespeicherte Text-Standard, sonst das
 * Design des letzten Textes im Dokument (damit weitere Untertitel gleich
 * aussehen), sonst der Untertitel-Standard.
 */
export function subtitleStyle(
  doc: TimelineDoc,
  textDefault?: TextDefault | null,
): Record<string, unknown> {
  // Gespeicherter Text-Standard geht vor: alle neuen Texte sehen so aus.
  if (textDefault) return { ...SUBTITLE_STYLE, ...textDefault }
  const texts = doc.tracks
    .flatMap((t) => (t.kind === 'overlay' ? t.clips : []))
    .filter((c) => c.kind === 'text')
    .sort((a, b) => a.start - b.start)
  const last = texts[texts.length - 1]
  if (!last) return { ...SUBTITLE_STYLE }
  const style: Record<string, unknown> = { ...SUBTITLE_STYLE }
  for (const key of STYLE_KEYS) if (last.data[key] !== undefined) style[key] = last.data[key]
  return style
}

/**
 * Untertitel eines Clips als Text-Clips auf der Timeline. Die Zeiten der
 * Quelle werden über Beginn, Quell-Beginn und Tempo des Clips umgerechnet und
 * auf dessen Bereich begrenzt; was außerhalb liegt (weggeschnitten), entfällt.
 * Die Texte überschneiden sich nicht und liegen auf dem Bildraster.
 */
export function cuesToClips(
  clip: VideoClip | AudioClip,
  cues: readonly Cue[],
  fps: number,
  style: Record<string, unknown>,
  ids: () => string = createId,
): OverlayClip[] {
  const minDuration = secondsToTime(MIN_TEXT_DURATION)
  const end = clipEnd(clip)
  const toTimeline = (sec: number): Time =>
    clip.start + Math.round((secondsToTime(sec) - clip.sourceIn) / clip.speed)
  const out: OverlayClip[] = []
  let cursor = clip.start
  const sorted = cues
    .filter((c) => Number.isFinite(c.start) && Number.isFinite(c.end) && c.text.trim() !== '')
    .slice()
    .sort((a, b) => a.start - b.start)
  for (const cue of sorted) {
    const from = snapToFrame(Math.max(cursor, toTimeline(cue.start)), fps)
    const to = snapToFrame(Math.min(end, toTimeline(cue.end)), fps)
    if (from < cursor || to - from < minDuration) continue
    out.push({
      id: ids(),
      kind: 'text',
      start: from,
      duration: to - from,
      data: { ...style, text: cue.text.trim() },
    })
    cursor = to
  }
  return out
}
