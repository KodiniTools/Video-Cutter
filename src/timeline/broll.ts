import {
  addTrack,
  clipEnd,
  createId,
  insertClip,
  MIN_CLIP_DURATION,
  nextTrackName,
  secondsToTime,
  snapToFrame,
  type Clip,
  type OpResult,
  type Time,
  type TimelineDoc,
} from './model'

/**
 * Zwischenbilder (B-Roll): KI-Bilder oder -Videos, die über dem Video liegen,
 * während weitergesprochen wird. Hier steht, wo sie auf der Timeline landen.
 * Reines TypeScript, ohne Vue.
 */

/** Weiche Blende am Anfang und Ende eines Zwischenbilds. */
export const BROLL_FADE: Time = 400_000
/** Wählbare Videolängen beim Erzeugen (Server: 3–15 s, ganze Sekunden). */
export const BROLL_VIDEO_MIN = 3
export const BROLL_VIDEO_MAX = 15

/** Länge des KI-Videos für eine Stelle: ganze Sekunden, mindestens so lang wie die Stelle. */
export function brollVideoSeconds(seconds: number): number {
  const n = Math.ceil(seconds - 0.001)
  return Math.min(BROLL_VIDEO_MAX, Math.max(BROLL_VIDEO_MIN, Number.isFinite(n) ? n : 4))
}

function overlaps(clips: readonly Clip[], start: Time, end: Time): boolean {
  return clips.some((c) => c.start < end && start < clipEnd(c))
}

/**
 * Spur für ein Zwischenbild von `start` bis `end`: Gesucht wird oberhalb der
 * obersten Video-Spur, die dort Bild zeigt, eine nicht gesperrte Video-Spur,
 * die an der Stelle frei ist (die nächstgelegene zuerst). `index` = Position
 * für eine neue Spur, wenn keine passt (direkt über dem Bild darunter).
 */
export function brollTrack(
  doc: TimelineDoc,
  start: Time,
  end: Time,
): { trackId: string } | { index: number } {
  const base = doc.tracks.findIndex(
    (t) => t.kind === 'video' && !t.hidden && overlaps(t.clips, start, end),
  )
  const limit = base < 0 ? doc.tracks.length : base
  for (let i = limit - 1; i >= 0; i--) {
    const t = doc.tracks[i]
    if (t.kind === 'video' && !t.locked && !overlaps(t.clips, start, end)) return { trackId: t.id }
  }
  return { index: base < 0 ? 0 : base }
}

/**
 * Zwischenbild einfügen: Das Bild des Mediums (ohne Ton, das Gesprochene läuft
 * weiter) liegt ab `at` (aufs Bildraster gerundet) für höchstens `duration`
 * auf einer Video-Spur über dem Video, mit weicher Blende. Fehlt eine freie
 * Spur, entsteht direkt über dem Video eine neue.
 */
export function insertBrollClip(
  doc: TimelineDoc,
  assetId: string,
  at: Time,
  duration: Time,
  opts: { ids?: () => string } = {},
): OpResult & { clipId?: string } {
  const asset = doc.assets[assetId]
  if (!asset) return { ok: false, error: 'asset-not-found' }
  if (asset.kind !== 'video' || asset.duration === null)
    return { ok: false, error: 'kind-mismatch' }
  const fps = doc.settings.fps
  const start = snapToFrame(Math.max(0, at), fps)
  const length = Math.min(asset.duration, Math.max(0, Math.round(duration)))
  if (length < MIN_CLIP_DURATION) return { ok: false, error: 'too-short' }
  const ids = opts.ids ?? createId
  let next = doc
  const place = brollTrack(doc, start, start + length)
  let trackId: string
  if ('trackId' in place) trackId = place.trackId
  else {
    trackId = ids()
    const added = addTrack(
      next,
      { id: trackId, kind: 'video', name: nextTrackName(next, 'V') },
      place.index,
    )
    if (!added.ok) return added
    next = added.doc
  }
  // Blende nur, wenn der Clip lang genug ist (sonst bliebe kaum etwas stehen).
  const fade = length >= 4 * BROLL_FADE ? BROLL_FADE : 0
  const clipId = ids()
  const r = insertClip(next, trackId, {
    id: clipId,
    kind: 'video',
    asset: assetId,
    start,
    duration: length,
    sourceIn: 0,
    speed: 1,
    ...(fade
      ? { transitionIn: { preset: 'fade', duration: fade }, fadeOut: { duration: fade } }
      : {}),
  })
  return r.ok ? { ...r, clipId } : r
}

/** Zeitspanne einer Stelle (Sekunden der Timeline) als Timeline-Zeit. */
export function brollSpan(at: number, end: number): { start: Time; duration: Time } {
  const start = secondsToTime(Math.max(0, at))
  return { start, duration: Math.max(0, secondsToTime(Math.max(at, end)) - start) }
}
