import {
  addTrack,
  createId,
  findClip,
  frameTime,
  insertClip,
  linkGroupIds,
  MIN_CLIP_DURATION,
  normalizeCrop,
  secondsToTime,
  type AssetRef,
  type AudioClip,
  type ClipCrop,
  type OpResult,
  type Time,
  type TimelineDoc,
  type VideoClip,
} from './model'
import type { SourceRange, TimeRange } from './cutSuggestions'

/**
 * Highlights als kurzen Clip (Short): Aus ausgewählten Stellen eines Clips
 * entsteht eine neue Timeline mit nur diesen Stellen hintereinander, im
 * gewählten Format und mittig zugeschnitten. Reine Funktionen ohne Vue.
 */

/** Formate für den Short; `keep` lässt das Projektformat, wie es ist. */
export const SHORT_FORMATS = {
  '9:16': { width: 1080, height: 1920 },
  '1:1': { width: 1080, height: 1080 },
  '4:5': { width: 1080, height: 1350 },
  keep: null,
} as const
export type ShortFormat = keyof typeof SHORT_FORMATS

/**
 * Zuschnitt, der das Bild mittig auf das Seitenverhältnis `width:height`
 * bringt – innerhalb eines schon vorhandenen Zuschnitts. Ohne bekannte
 * Größe der Quelle bleibt der vorhandene Zuschnitt (das Bild wird eingepasst).
 */
export function shortCrop(
  asset: Pick<AssetRef, 'width' | 'height'>,
  crop: ClipCrop | null | undefined,
  width: number,
  height: number,
): ClipCrop | null {
  const base = crop ?? { x: 0, y: 0, width: 1, height: 1 }
  const sw = asset.width ?? 0
  const sh = asset.height ?? 0
  if (!(sw > 0 && sh > 0 && width > 0 && height > 0)) return normalizeCrop(crop)
  const visibleRatio = (base.width * sw) / (base.height * sh)
  const target = width / height
  if (Math.abs(visibleRatio - target) < 0.005) return normalizeCrop(base)
  if (visibleRatio > target) {
    // Zu breit: links und rechts abschneiden.
    const w = (base.height * sh * target) / sw
    return normalizeCrop({ ...base, x: base.x + (base.width - w) / 2, width: w })
  }
  const h = (base.width * sw) / target / sh
  return normalizeCrop({ ...base, y: base.y + (base.height - h) / 2, height: h })
}

/**
 * Lücken zwischen den Bereichen (sortiert): Beim Ansehen aller Highlights
 * hintereinander springt die Vorschau darüber.
 */
export function gapsBetween(ranges: readonly TimeRange[]): TimeRange[] {
  const sorted = ranges.slice().sort((a, b) => a.start - b.start)
  const gaps: TimeRange[] = []
  for (let i = 1; i < sorted.length; i++) {
    const start = sorted[i - 1].end
    const end = sorted[i].start
    if (end > start) gaps.push({ start, end })
  }
  return gaps
}

/**
 * Neue Timeline aus den Stellen (Sekunden der Quelle) eines Clips: Bild und
 * verknüpfter Ton jeder Stelle liegen chronologisch ohne Lücke auf V1/A1,
 * Tempo, Lautstärke und Farbe des Clips bleiben. Mit Format wird das Projekt
 * darauf umgestellt und jedes Bild mittig zugeschnitten. Andere Spuren und
 * Marker fallen weg; die Medien bleiben angemeldet. Stellen außerhalb des
 * verwendeten Teils des Clips werden beschnitten bzw. übergangen.
 */
export function buildShortDoc(
  doc: TimelineDoc,
  clipId: string,
  ranges: readonly SourceRange[],
  format: ShortFormat,
  opts: { ids?: () => string } = {},
): OpResult {
  const ids = opts.ids ?? createId
  const loc = findClip(doc, clipId)
  if (!loc) return { ok: false, error: 'clip-not-found' }
  const group = linkGroupIds(doc, clipId)
    .map((id) => findClip(doc, id)?.clip)
    .filter((c) => c !== undefined)
  const video = group.find((c): c is VideoClip => c.kind === 'video')
  if (!video) return { ok: false, error: 'kind-mismatch' }
  const audio = group.find((c): c is AudioClip => c.kind === 'audio' && c.asset === video.asset)
  const asset = doc.assets[video.asset]
  if (!asset) return { ok: false, error: 'asset-not-found' }

  const size = SHORT_FORMATS[format]
  const settings = size ? { ...doc.settings, width: size.width, height: size.height } : doc.settings
  const crop = size ? shortCrop(asset, video.crop, size.width, size.height) : (video.crop ?? null)
  const fps = settings.fps

  // Verwendeter Teil der Quelle (µs).
  const spanStart = video.sourceIn
  const spanEnd = Math.min(
    video.sourceIn + Math.round(video.duration * video.speed),
    asset.duration ?? Infinity,
  )
  const pieces = ranges
    .map((r) => ({
      from: Math.max(spanStart, secondsToTime(r.start)),
      to: Math.min(spanEnd, secondsToTime(r.end)),
    }))
    .filter((r) => r.to > r.from)
    .sort((a, b) => a.from - b.from)

  const videoTrack = ids()
  const audioTrack = audio ? ids() : null
  let added = addTrack(
    { ...doc, settings, tracks: [], markers: [] },
    { id: videoTrack, kind: 'video', name: 'V1' },
  )
  if (!added.ok) return added
  if (audioTrack) {
    added = addTrack(added.doc, { id: audioTrack, kind: 'audio', name: 'A1' }, 1)
    if (!added.ok) return added
  }
  let next = added.doc

  let frame = 0
  let count = 0
  for (const p of pieces) {
    let frames = Math.floor(((p.to - p.from) / video.speed) * (fps / 1_000_000))
    const start: Time = frameTime(frame, fps)
    let duration = frameTime(frame + frames, fps) - start
    // Rundung darf nicht über das Ende der Stelle hinausreichen.
    while (frames > 0 && p.from + Math.round(duration * video.speed) > p.to) {
      frames--
      duration = frameTime(frame + frames, fps) - start
    }
    if (duration < MIN_CLIP_DURATION) continue
    const linkGroup = audioTrack ? ids() : undefined
    const base = { asset: video.asset, start, duration, sourceIn: p.from, speed: video.speed }
    const v = insertClip(next, videoTrack, {
      ...base,
      id: ids(),
      kind: 'video',
      ...(crop ? { crop } : {}),
      ...(video.color ? { color: video.color } : {}),
      ...(linkGroup ? { linkGroup } : {}),
    })
    if (!v.ok) return v
    next = v.doc
    if (audioTrack && audio) {
      const a = insertClip(next, audioTrack, {
        ...base,
        id: ids(),
        kind: 'audio',
        gain: audio.gain,
        linkGroup,
      })
      if (!a.ok) return a
      next = a.doc
    }
    frame += frames
    count++
  }
  if (count === 0) return { ok: false, error: 'too-short' }
  return { ok: true, doc: next }
}
