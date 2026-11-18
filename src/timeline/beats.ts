/**
 * Schnitt im Takt: Raster aus den erkannten Schlägen einer Tonspur und die
 * Befehle, die es auf die Timeline anwenden (Marker setzen, Clips auf den Takt
 * legen, an jedem Rasterpunkt teilen). Reines TypeScript ohne Vue.
 *
 * Die Schläge selbst erkennt der Server (`GET /api/media/:id/beats`), ihre
 * Zeiten gelten in der Quelle; hier werden sie über Beginn, Quell-Anfang und
 * Tempo des Clips auf die Timeline umgerechnet.
 */
import type { BeatAnalysis } from '@/lib/beatsApi'
import {
  addMarker,
  clipEnd,
  findClip,
  isTime,
  MAX_MARKERS,
  MIN_CLIP_DURATION,
  removeMarker,
  setMarkerEffect,
  snapToFrame,
  splitClip,
  validateDoc,
  type Clip,
  type MarkerEffectKind,
  type OpError,
  type Time,
  type TimelineDoc,
} from './model'

/** Raster: halbe Schläge, jeder Schlag, jeder 2., jeder Takt (4), alle 2 Takte (8). */
export const BEAT_GRIDS = ['half', 'beat', 'two', 'bar', 'twoBars'] as const
export type BeatGrid = (typeof BEAT_GRIDS)[number]

/** Schläge je Rasterpunkt (`half` = ein halber). */
export const GRID_STEP: Record<BeatGrid, number> = {
  half: 0.5,
  beat: 1,
  two: 2,
  bar: 4,
  twoBars: 8,
}

/** Größte Verschiebung des Rasters gegen die erkannten Schläge (µs). */
export const MAX_BEAT_OFFSET: Time = 250_000

export interface BeatGridOptions {
  grid: BeatGrid
  /**
   * Rasterpunkt beginnt beim wievielten Schlag nach dem erkannten Takt-Anfang
   * (0 … Schritt − 1). Nur für Raster mit mehr als einem Schlag.
   */
  shift: number
  /** Verschiebung aller Punkte (µs), z. B. wenn der Schlag etwas zu früh liegt. */
  offset: Time
}

/** Der Teil eines Clips, der für die Umrechnung zählt. */
export type BeatSourceClip = Pick<Clip, 'start' | 'duration'> & {
  sourceIn: Time
  speed: number
}

/**
 * Rasterpunkte als Zeiten auf der Timeline, innerhalb des Clips, aufsteigend,
 * auf Bilder gerundet (`fps`) und ohne doppelte.
 */
export function beatGridTimes(
  analysis: BeatAnalysis,
  clip: BeatSourceClip,
  opts: BeatGridOptions,
  fps = 0,
): Time[] {
  const beats = analysis.beats
  if (beats.length === 0 || !(clip.speed > 0)) return []
  const step = GRID_STEP[opts.grid]
  const sourceTimes: number[] = []
  if (step < 1) {
    beats.forEach((b, i) => {
      sourceTimes.push(b)
      if (i + 1 < beats.length) sourceTimes.push((b + beats[i + 1]) / 2)
    })
  } else {
    const shift = Math.max(0, Math.min(step - 1, Math.trunc(opts.shift)))
    beats.forEach((b, i) => {
      const k = (((i - analysis.downbeat - shift) % step) + step) % step
      if (k === 0) sourceTimes.push(b)
    })
  }
  const offset = Math.max(-MAX_BEAT_OFFSET, Math.min(MAX_BEAT_OFFSET, Math.round(opts.offset)))
  const end = clipEnd(clip)
  const out: Time[] = []
  for (const s of sourceTimes.sort((a, b) => a - b)) {
    const source = Math.round(s * 1_000_000) + offset
    let t = clip.start + Math.round((source - clip.sourceIn) / clip.speed)
    if (fps > 0) t = snapToFrame(t, fps)
    if (t < clip.start || t >= end || !isTime(t)) continue
    if (out.length === 0 || t > out[out.length - 1]) out.push(t)
  }
  return out
}

export type BeatResult<T> = { ok: true; doc: TimelineDoc; info: T } | { ok: false; error: OpError }

/**
 * Takt-Marker setzen (ohne Namen, zählen nicht als Kapitel), auf Wunsch mit
 * Drop-Effekt. Wo schon ein Marker liegt, kommt keiner dazu. Mehr als
 * `MAX_MARKERS` Marker gibt es nicht; was nicht mehr passt, zählt `dropped`.
 */
export function addBeatMarkers(
  doc: TimelineDoc,
  times: readonly Time[],
  opts: { effect?: MarkerEffectKind | null; ids?: () => string } = {},
): BeatResult<{ added: number; dropped: number }> {
  let next = doc
  let added = 0
  let dropped = 0
  for (const at of times) {
    if (next.markers.some((m) => m.at === at)) continue
    if (next.markers.length >= MAX_MARKERS) {
      dropped++
      continue
    }
    const r = addMarker(next, { at, beat: true, id: opts.ids?.() })
    if (!r.ok) return r
    next = r.doc
    added++
    if (opts.effect) {
      const marker = next.markers.find((m) => m.at === at)
      if (marker) {
        const e = setMarkerEffect(next, marker.id, { kind: opts.effect })
        if (!e.ok) return e
        next = e.doc
      }
    }
  }
  return { ok: true, doc: next, info: { added, dropped } }
}

/** Anzahl der Takt-Marker. */
export function beatMarkerCount(doc: TimelineDoc): number {
  return doc.markers.filter((m) => m.beat).length
}

/** Alle Takt-Marker entfernen (gebundene Clips bleiben liegen). */
export function removeBeatMarkers(doc: TimelineDoc): BeatResult<{ removed: number }> {
  let next = doc
  let removed = 0
  for (const m of doc.markers) {
    if (!m.beat) continue
    const r = removeMarker(next, m.id)
    if (!r.ok) return r
    next = r.doc
    removed++
  }
  return { ok: true, doc: next, info: { removed } }
}

/** Neue Probleme, die `next` gegenüber `doc` hat (erstes davon), sonst `null`. */
function newIssue(doc: TimelineDoc, next: TimelineDoc): OpError | null {
  const before = new Set(validateDoc(doc).map((i) => `${i.error}:${i.id}`))
  const issue = validateDoc(next).find((i) => !before.has(`${i.error}:${i.id}`))
  return issue ? issue.error : null
}

/** Längste Dauer eines Clips auf der Timeline (Quelle begrenzt), `null` = beliebig. */
function maxDuration(doc: TimelineDoc, clip: Clip): Time | null {
  if (clip.kind !== 'video' && clip.kind !== 'audio') return null
  const limit = doc.assets[clip.asset]?.duration
  if (limit === null || limit === undefined) return null
  return Math.floor((limit - clip.sourceIn) / clip.speed)
}

/** Nächster Rasterpunkt zu `time` (bei Gleichstand der frühere), `null` ohne Punkte. */
function nearest(points: readonly Time[], time: Time): Time | null {
  let best: Time | null = null
  for (const p of points) if (best === null || Math.abs(p - time) < Math.abs(best - time)) best = p
  return best
}

/**
 * Clips einer Video-Spur auf den Takt legen: Jeder Clip endet am nächsten
 * Rasterpunkt (kürzer oder, soweit die Quelle reicht, länger), die folgenden
 * rücken entsprechend nach – so liegt jeder Schnitt auf einem Schlag. Lücken
 * zwischen Clips bleiben gleich lang. Verknüpfter Ton (Bild + Ton) wird
 * genauso gekürzt und verschoben. Andere Spuren (Musik, Texte) und Marker
 * bleiben stehen. Clips hinter dem letzten Rasterpunkt rücken nur nach.
 */
export function fitClipsToBeats(
  doc: TimelineDoc,
  trackId: string,
  times: readonly Time[],
): BeatResult<{ fitted: number; unchanged: number }> {
  const trackIndex = doc.tracks.findIndex((t) => t.id === trackId)
  if (trackIndex < 0) return { ok: false, error: 'track-not-found' }
  const track = doc.tracks[trackIndex]
  if (track.kind !== 'video') return { ok: false, error: 'kind-mismatch' }
  if (track.locked) return { ok: false, error: 'track-locked' }
  const clips = (track.clips as Clip[]).slice().sort((a, b) => a.start - b.start)

  // Neue Lage je Clip-ID (auch verknüpfte Clips auf anderen Spuren).
  const placed = new Map<string, { start: Time; duration: Time }>()
  let shift = 0
  let fitted = 0
  let unchanged = 0
  for (const clip of clips) {
    const start = clip.start + shift
    const end = start + clip.duration
    const longest = maxDuration(doc, clip)
    // Rasterpunkte, die als Ende taugen (Mindestlänge, Quelle).
    const usable = times.filter(
      (t) =>
        t - start >= MIN_CLIP_DURATION &&
        (longest === null || t - start <= longest) &&
        Math.abs(t - end) <= Math.max(clip.duration, MIN_CLIP_DURATION),
    )
    const target = nearest(usable, end)
    const newEnd = target ?? end
    if (target === null) unchanged++
    else if (target !== end) fitted++
    const duration = newEnd - start
    const dStart = start - clip.start
    const dDuration = duration - clip.duration
    placed.set(clip.id, { start, duration })
    if (clip.linkGroup) {
      for (const other of doc.tracks)
        for (const c of other.clips as Clip[])
          if (c.linkGroup === clip.linkGroup && c.id !== clip.id) {
            if (other.locked) return { ok: false, error: 'track-locked' }
            placed.set(c.id, { start: c.start + dStart, duration: c.duration + dDuration })
          }
    }
    shift = newEnd - clipEnd(clip)
  }
  if (fitted === 0) return { ok: true, doc, info: { fitted, unchanged } }

  const tracks = doc.tracks.map((t) => {
    if (!(t.clips as Clip[]).some((c) => placed.has(c.id))) return t
    const moved = (t.clips as Clip[]).map((c) => {
      const p = placed.get(c.id)
      return p ? { ...c, start: p.start, duration: p.duration } : c
    })
    return { ...t, clips: moved.sort((a, b) => a.start - b.start) } as typeof t
  })
  const next = { ...doc, tracks }
  const issue = newIssue(doc, next)
  if (issue) return { ok: false, error: issue }
  return { ok: true, doc: next, info: { fitted, unchanged } }
}

/**
 * Alle Clips einer Spur an jedem Rasterpunkt teilen (verknüpfter Ton wird
 * mitgeteilt). Punkte zu nah an einem Rand werden übergangen.
 */
export function splitClipsAtBeats(
  doc: TimelineDoc,
  trackId: string,
  times: readonly Time[],
  opts: { ids?: () => string } = {},
): BeatResult<{ cuts: number }> {
  const track = doc.tracks.find((t) => t.id === trackId)
  if (!track) return { ok: false, error: 'track-not-found' }
  if (track.locked) return { ok: false, error: 'track-locked' }
  let next = doc
  let cuts = 0
  for (const at of times) {
    const current = next.tracks.find((t) => t.id === trackId)
    const clip = (current?.clips as Clip[] | undefined)?.find(
      (c) => c.start < at && at < clipEnd(c),
    )
    if (!clip) continue
    const r = splitClip(next, clip.id, at, { ids: opts.ids })
    if (!r.ok) {
      if (r.error === 'too-short') continue
      return r
    }
    next = r.doc
    cuts++
  }
  return { ok: true, doc: next, info: { cuts } }
}

/** Clip, dessen Ton analysiert wird (Video oder Ton mit Tonspur), sonst `null`. */
export function beatSourceClip(doc: TimelineDoc, clipId: string | null): Clip | null {
  if (!clipId) return null
  const loc = findClip(doc, clipId)
  if (!loc) return null
  const c = loc.clip
  if (c.kind !== 'audio' && c.kind !== 'video') return null
  return doc.assets[c.asset]?.hasAudio ? c : null
}
