/**
 * Befehle auf dem Timeline-Dokument. Alle Funktionen sind rein: Sie verändern
 * ihre Eingabe nie, sondern liefern ein neues Dokument oder einen Ablehnungsgrund.
 */
import { isTime, MAX_SPEED, MIN_CLIP_DURATION, MIN_SPEED } from './time'
import {
  TIMELINE_DOC_VERSION,
  type AssetRef,
  type Clip,
  type ClipKind,
  type OpError,
  type OpResult,
  type OverlayClip,
  type Time,
  type TimelineDoc,
  type TimelineSettings,
  type Track,
  type TrackKind,
} from './types'

export const DEFAULT_SETTINGS: TimelineSettings = {
  width: 1920,
  height: 1080,
  fps: 30,
  background: '#000000',
  sampleRate: 48000,
}

/** Größte Seitenlänge eines Projekts in Pixel (wie auf dem Server). */
export const MAX_PROJECT_SIDE = 3840
export const MIN_PROJECT_SIDE = 16
export const MIN_FPS = 1
export const MAX_FPS = 60

export type SettingsPatch = Partial<
  Pick<TimelineSettings, 'width' | 'height' | 'fps' | 'background'>
>

const validSide = (v: number) =>
  Number.isInteger(v) && v >= MIN_PROJECT_SIDE && v <= MAX_PROJECT_SIDE && v % 2 === 0

/**
 * Projektformat ändern (Größe, Bildrate, Hintergrund). Die Regeln entsprechen
 * der Prüfung auf dem Server: gerade Seitenlängen von 16 bis 3840 Pixel,
 * 1 bis 60 Bilder je Sekunde, Farbe als `#rrggbb`. Clips bleiben unverändert;
 * sie werden beim Rendern in das neue Format eingepasst.
 */
export function updateSettings(doc: TimelineDoc, patch: SettingsPatch): OpResult {
  const next = { ...doc.settings }
  if (patch.width !== undefined) next.width = patch.width
  if (patch.height !== undefined) next.height = patch.height
  if (patch.fps !== undefined) next.fps = patch.fps
  if (patch.background !== undefined) next.background = patch.background.toLowerCase()
  if (
    !validSide(next.width) ||
    !validSide(next.height) ||
    !Number.isFinite(next.fps) ||
    next.fps < MIN_FPS ||
    next.fps > MAX_FPS ||
    !/^#[0-9a-f]{6}$/.test(next.background)
  )
    return fail('invalid-settings')
  const same = (Object.keys(next) as Array<keyof TimelineSettings>).every(
    (k) => next[k] === doc.settings[k],
  )
  // Nichts geändert: kein neuer Stand (und damit kein leerer Rückgängig-Schritt).
  return same ? ok(doc) : ok({ ...doc, settings: next })
}

/** Erzeugt eine neue, eindeutige ID. */
export function createId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
    return crypto.randomUUID()
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export function createDoc(settings: Partial<TimelineSettings> = {}): TimelineDoc {
  return {
    version: TIMELINE_DOC_VERSION,
    settings: { ...DEFAULT_SETTINGS, ...settings },
    assets: {},
    tracks: [],
    markers: [],
  }
}

const ok = (doc: TimelineDoc): OpResult => ({ ok: true, doc })
const fail = (error: OpError): OpResult => ({ ok: false, error })

export function clipEnd(clip: Pick<Clip, 'start' | 'duration'>): Time {
  return clip.start + clip.duration
}

/** Ende des letzten Clips (Länge des Gesamtvideos). */
export function docDuration(doc: TimelineDoc): Time {
  let end = 0
  for (const t of doc.tracks) for (const c of t.clips) end = Math.max(end, clipEnd(c))
  return end
}

const TRACK_CLIP_KINDS: Record<TrackKind, readonly ClipKind[]> = {
  video: ['video', 'still'],
  audio: ['audio'],
  overlay: ['text', 'graphic', 'image'],
}

/** Darf ein Clip dieser Art auf eine Spur dieser Art? */
export function trackAccepts(trackKind: TrackKind, clipKind: ClipKind): boolean {
  return TRACK_CLIP_KINDS[trackKind].includes(clipKind)
}

export interface ClipLocation {
  track: Track
  trackIndex: number
  clip: Clip
}

export function findClip(doc: TimelineDoc, clipId: string): ClipLocation | null {
  for (let trackIndex = 0; trackIndex < doc.tracks.length; trackIndex++) {
    const track = doc.tracks[trackIndex]
    const clip = track.clips.find((c) => c.id === clipId)
    if (clip) return { track, trackIndex, clip }
  }
  return null
}

/** Der Clip selbst plus alle Clips derselben Verknüpfungsgruppe. */
function linkedClips(doc: TimelineDoc, loc: ClipLocation, linked: boolean): ClipLocation[] {
  const group = loc.clip.linkGroup
  if (!linked || !group) return [loc]
  const out: ClipLocation[] = []
  doc.tracks.forEach((track, trackIndex) => {
    for (const clip of track.clips)
      if (clip.linkGroup === group) out.push({ track, trackIndex, clip })
  })
  return out
}

/** IDs des Clips und aller mit ihm verknüpften Clips (leer, wenn es ihn nicht gibt). */
export function linkGroupIds(doc: TimelineDoc, clipId: string): string[] {
  const loc = findClip(doc, clipId)
  return loc ? linkedClips(doc, loc, true).map((m) => m.clip.id) : []
}

function hasId(doc: TimelineDoc, id: string): boolean {
  return (
    doc.tracks.some((t) => t.id === id || t.clips.some((c) => c.id === id)) ||
    doc.markers.some((m) => m.id === id)
  )
}

function overlaps(clips: readonly Clip[], start: Time, end: Time): boolean {
  return clips.some((c) => c.start < end && start < clipEnd(c))
}

/** Hat der Clip eine begrenzte Quelle (Video/Audio)? Bilder sind beliebig lang. */
function sourceLimit(doc: TimelineDoc, clip: Clip): Time | null {
  if (clip.kind !== 'video' && clip.kind !== 'audio') return null
  return doc.assets[clip.asset]?.duration ?? null
}

/** Verbrauchte Quell-Länge für eine Timeline-Dauer bei gegebenem Tempo. */
function sourceSpan(duration: Time, speed: number): Time {
  return Math.round(duration * speed)
}

/** Prüft einen Clip für sich (Zeiten, Tempo, Quelle) – ohne Nachbarn. */
function checkClip(doc: TimelineDoc, clip: Clip): OpError | null {
  if (!isTime(clip.start) || !isTime(clip.duration)) return 'invalid-time'
  if (clip.duration < MIN_CLIP_DURATION) return 'too-short'
  if (clip.kind === 'video' || clip.kind === 'still' || clip.kind === 'audio') {
    if (!doc.assets[clip.asset]) return 'asset-not-found'
    if (!isTime(clip.sourceIn)) return 'invalid-time'
    if (!(clip.speed >= MIN_SPEED && clip.speed <= MAX_SPEED)) return 'invalid-time'
    const limit = sourceLimit(doc, clip)
    if (limit !== null && clip.sourceIn + sourceSpan(clip.duration, clip.speed) > limit)
      return 'out-of-source'
  } else if (clip.asset !== undefined && !doc.assets[clip.asset]) {
    return 'asset-not-found'
  }
  return null
}

function byStart(a: Clip, b: Clip): number {
  return a.start - b.start
}

/** Neues Dokument mit ersetzten Clips einer Spur (nach Beginn sortiert). */
function withClips(doc: TimelineDoc, trackIndex: number, clips: Clip[]): TimelineDoc {
  const tracks = doc.tracks.slice()
  tracks[trackIndex] = { ...tracks[trackIndex], clips: clips.slice().sort(byStart) } as Track
  return { ...doc, tracks }
}

// --- Medien ----------------------------------------------------------------

/** Medium anmelden bzw. dessen Metadaten aktualisieren. */
export function putAsset(doc: TimelineDoc, asset: AssetRef): TimelineDoc {
  return { ...doc, assets: { ...doc.assets, [asset.id]: asset } }
}

/** Wird das Medium von einem Clip verwendet? */
export function assetInUse(doc: TimelineDoc, assetId: string): boolean {
  return doc.tracks.some((t) => t.clips.some((c) => 'asset' in c && c.asset === assetId))
}

/** Medium abmelden; abgelehnt, solange ein Clip es verwendet. */
export function removeAsset(doc: TimelineDoc, assetId: string): OpResult {
  if (!doc.assets[assetId]) return fail('asset-not-found')
  if (assetInUse(doc, assetId)) return fail('asset-in-use')
  const assets = { ...doc.assets }
  delete assets[assetId]
  return ok({ ...doc, assets })
}

// --- Spuren ----------------------------------------------------------------

export interface NewTrack {
  id?: string
  kind: TrackKind
  name: string
}

/** Spur anlegen; `index` 0 = ganz oben. Ohne Angabe wird sie oben eingefügt. */
export function addTrack(doc: TimelineDoc, track: NewTrack, index = 0): OpResult {
  const id = track.id ?? createId()
  if (hasId(doc, id)) return fail('duplicate-id')
  const base = { id, name: track.name, locked: false }
  let created: Track
  switch (track.kind) {
    case 'video':
      created = { ...base, kind: 'video', hidden: false, clips: [] }
      break
    case 'audio':
      created = { ...base, kind: 'audio', muted: false, solo: false, volume: 1, clips: [] }
      break
    case 'overlay':
      created = { ...base, kind: 'overlay', hidden: false, clips: [] }
      break
  }
  const at = Math.min(Math.max(0, Math.trunc(index)), doc.tracks.length)
  const tracks = doc.tracks.slice()
  tracks.splice(at, 0, created)
  return ok({ ...doc, tracks })
}

/** Spur samt Clips entfernen (gesperrte Spuren bleiben). */
export function removeTrack(doc: TimelineDoc, trackId: string): OpResult {
  const track = doc.tracks.find((t) => t.id === trackId)
  if (!track) return fail('track-not-found')
  if (track.locked) return fail('track-locked')
  return ok({ ...doc, tracks: doc.tracks.filter((t) => t.id !== trackId) })
}

/** Spur an eine andere Stelle der Reihenfolge setzen (`index` 0 = ganz oben). */
export function moveTrack(doc: TimelineDoc, trackId: string, index: number): OpResult {
  const from = doc.tracks.findIndex((t) => t.id === trackId)
  if (from < 0) return fail('track-not-found')
  if (!Number.isFinite(index)) return fail('invalid-time')
  const to = Math.min(Math.max(0, Math.trunc(index)), doc.tracks.length - 1)
  if (to === from) return ok(doc)
  const tracks = doc.tracks.slice()
  const [track] = tracks.splice(from, 1)
  tracks.splice(to, 0, track)
  return ok({ ...doc, tracks })
}

export interface TrackPatch {
  name?: string
  locked?: boolean
  hidden?: boolean
  muted?: boolean
  solo?: boolean
  volume?: number
}

/** Spur-Eigenschaften ändern; Felder, die die Spur-Art nicht kennt, werden ignoriert. */
export function updateTrack(doc: TimelineDoc, trackId: string, patch: TrackPatch): OpResult {
  const index = doc.tracks.findIndex((t) => t.id === trackId)
  if (index < 0) return fail('track-not-found')
  const track = doc.tracks[index]
  const next: Record<string, unknown> = { ...track }
  let changed = false
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || !(key in track)) continue
    if ((track as unknown as Record<string, unknown>)[key] === value) continue
    next[key] = value
    changed = true
  }
  // Nichts geändert: kein neuer Stand (und damit kein leerer Rückgängig-Schritt).
  if (!changed) return ok(doc)
  const tracks = doc.tracks.slice()
  tracks[index] = next as unknown as Track
  return ok({ ...doc, tracks })
}

// --- Clips -----------------------------------------------------------------

/** Clip auf eine Spur legen. Abgelehnt bei Überlappung, falscher Spur-Art oder ungültigen Zeiten. */
export function insertClip(doc: TimelineDoc, trackId: string, clip: Clip): OpResult {
  const trackIndex = doc.tracks.findIndex((t) => t.id === trackId)
  if (trackIndex < 0) return fail('track-not-found')
  const track = doc.tracks[trackIndex]
  if (track.locked) return fail('track-locked')
  if (!trackAccepts(track.kind, clip.kind)) return fail('kind-mismatch')
  if (hasId(doc, clip.id)) return fail('duplicate-id')
  const error = checkClip(doc, clip)
  if (error) return fail(error)
  if (overlaps(track.clips, clip.start, clipEnd(clip))) return fail('overlap')
  return ok(withClips(doc, trackIndex, [...track.clips, clip]))
}

/**
 * Darstellungsdaten eines Clips auf einer Ebenen-Spur ändern (Text, später
 * Grafik/Bild). Felder mit `undefined` bleiben, wie sie sind.
 */
export function updateClipData(
  doc: TimelineDoc,
  clipId: string,
  patch: Record<string, unknown>,
): OpResult {
  const loc = findClip(doc, clipId)
  if (!loc) return fail('clip-not-found')
  if (loc.track.locked) return fail('track-locked')
  const clip = loc.clip
  if (!('data' in clip)) return fail('kind-mismatch')
  const data = { ...clip.data }
  let changed = false
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || data[key] === value) continue
    data[key] = value
    changed = true
  }
  if (!changed) return ok(doc)
  const clips = loc.track.clips.map((c) => (c.id === clipId ? { ...clip, data } : c))
  return ok(withClips(doc, loc.trackIndex, clips as Clip[]))
}

/** Setzt bzw. löscht die Verknüpfungsgruppe der genannten Clips (nur geänderte Spuren neu). */
function withLinkGroup(doc: TimelineDoc, ids: ReadonlySet<string>, group?: string): TimelineDoc {
  let changed = false
  const tracks = doc.tracks.map((track) => {
    if (!track.clips.some((c) => ids.has(c.id) && c.linkGroup !== group)) return track
    changed = true
    const clips = track.clips.map((c) => {
      if (!ids.has(c.id) || c.linkGroup === group) return c
      const next = { ...c }
      if (group === undefined) delete next.linkGroup
      else next.linkGroup = group
      return next
    })
    return { ...track, clips } as Track
  })
  return changed ? { ...doc, tracks } : doc
}

/**
 * Verknüpfung lösen: Die genannten Clips und alles, was mit ihnen verknüpft
 * ist, werden eigenständig (z. B. Ton getrennt vom Bild verschieben, kürzen
 * oder löschen). Ohne Verknüpfung bleibt das Dokument unverändert.
 */
export function unlinkClips(doc: TimelineDoc, clipIds: readonly string[]): OpResult {
  const ids = new Set<string>()
  for (const id of clipIds) {
    const loc = findClip(doc, id)
    if (!loc) return fail('clip-not-found')
    if (loc.clip.linkGroup) for (const m of linkedClips(doc, loc, true)) ids.add(m.clip.id)
  }
  return ok(withLinkGroup(doc, ids))
}

/**
 * Clips verknüpfen: Die genannten Clips (samt ihren bisherigen Gruppen) bilden
 * eine neue Gruppe und wandern künftig gemeinsam. Braucht mindestens zwei.
 */
export function linkClips(
  doc: TimelineDoc,
  clipIds: readonly string[],
  group: string = createId(),
): OpResult {
  const ids = new Set<string>()
  for (const id of clipIds) {
    const loc = findClip(doc, id)
    if (!loc) return fail('clip-not-found')
    for (const m of linkedClips(doc, loc, true)) ids.add(m.clip.id)
  }
  if (ids.size < 2) return ok(doc)
  return ok(withLinkGroup(doc, ids, group))
}

/**
 * Clip auf eine Ebenen-Spur legen: auf die oberste entsperrte Ebenen-Spur, die
 * an der Stelle frei ist – sonst entsteht ganz oben eine neue (`trackName`).
 */
export function insertOverlayClip(
  doc: TimelineDoc,
  clip: OverlayClip,
  trackName: string,
  trackId: string = createId(),
): OpResult {
  const free = doc.tracks.find(
    (t) => t.kind === 'overlay' && !t.locked && !overlaps(t.clips, clip.start, clipEnd(clip)),
  )
  if (free) return insertClip(doc, free.id, clip)
  const added = addTrack(doc, { kind: 'overlay', name: trackName, id: trackId }, 0)
  return added.ok ? insertClip(added.doc, trackId, clip) : added
}

export interface MoveTarget {
  start: Time
  /** Zielspur; fehlt = Spur bleibt. Gilt nur für den bewegten Clip, nicht für verknüpfte. */
  trackId?: string
}

/**
 * Clip verschieben. Verknüpfte Clips wandern um denselben Zeitversatz mit
 * (abschaltbar mit `linked: false`).
 */
export function moveClip(
  doc: TimelineDoc,
  clipId: string,
  to: MoveTarget,
  opts: { linked?: boolean } = {},
): OpResult {
  const loc = findClip(doc, clipId)
  if (!loc) return fail('clip-not-found')
  if (!isTime(to.start)) return fail('invalid-time')
  let targetIndex = loc.trackIndex
  if (to.trackId !== undefined) {
    targetIndex = doc.tracks.findIndex((t) => t.id === to.trackId)
    if (targetIndex < 0) return fail('track-not-found')
  }
  const target = doc.tracks[targetIndex]
  if (target.locked) return fail('track-locked')
  if (!trackAccepts(target.kind, loc.clip.kind)) return fail('kind-mismatch')

  const delta = to.start - loc.clip.start
  const members = linkedClips(doc, loc, opts.linked ?? true)
  const movingIds = new Set(members.map((m) => m.clip.id))
  if (members.some((m) => m.track.locked)) return fail('track-locked')

  // Erst alle bewegten Clips herausnehmen, dann an der neuen Stelle einsetzen.
  const lanes = doc.tracks.map((t) => t.clips.filter((c) => !movingIds.has(c.id)) as Clip[])
  for (const m of members) {
    const start = m.clip.start + delta
    if (!isTime(start)) return fail('invalid-time')
    const lane = lanes[m.clip.id === clipId ? targetIndex : m.trackIndex]
    if (overlaps(lane, start, start + m.clip.duration)) return fail('overlap')
    lane.push({ ...m.clip, start })
  }
  const touched = new Set([targetIndex, ...members.map((m) => m.trackIndex)])
  let next = doc
  for (const i of touched) next = withClips(next, i, lanes[i])
  return ok(next)
}

/**
 * Rand eines Clips ziehen. `start`: Beginn verschieben (Ende bleibt), bei
 * Video/Audio rückt der Quell-Beginn mit. `end`: Ende verschieben.
 * Verknüpfte Clips bleiben unberührt (ermöglicht versetzte Bild-/Ton-Schnitte).
 */
export function trimClip(
  doc: TimelineDoc,
  clipId: string,
  edge: 'start' | 'end',
  to: Time,
): OpResult {
  const loc = findClip(doc, clipId)
  if (!loc) return fail('clip-not-found')
  if (loc.track.locked) return fail('track-locked')
  if (!isTime(to)) return fail('invalid-time')
  const clip = loc.clip
  let next: Clip
  if (edge === 'start') {
    const duration = clipEnd(clip) - to
    if (duration < MIN_CLIP_DURATION) return fail('too-short')
    next = { ...clip, start: to, duration }
    if (next.kind === 'video' || next.kind === 'audio') {
      const sourceIn = next.sourceIn + Math.round((to - clip.start) * next.speed)
      if (sourceIn < 0) return fail('out-of-source')
      next = { ...next, sourceIn }
    }
  } else {
    const duration = to - clip.start
    if (duration < MIN_CLIP_DURATION) return fail('too-short')
    next = { ...clip, duration }
  }
  const error = checkClip(doc, next)
  if (error) return fail(error)
  const others = loc.track.clips.filter((c) => c.id !== clipId)
  if (overlaps(others, next.start, clipEnd(next))) return fail('overlap')
  return ok(withClips(doc, loc.trackIndex, [...others, next]))
}

/**
 * Erlaubter Bereich für einen Rand beim Trimmen: begrenzt durch die Nachbarn
 * auf der Spur, die Mindestlänge und (bei Video/Ton) die Länge der Quelle.
 * `null`, wenn es den Clip nicht gibt.
 */
export function trimRange(
  doc: TimelineDoc,
  clipId: string,
  edge: 'start' | 'end',
): { min: Time; max: Time } | null {
  const loc = findClip(doc, clipId)
  if (!loc) return null
  const clip = loc.clip
  const end = clipEnd(clip)
  const others = loc.track.clips.filter((c) => c.id !== clipId)
  const media = clip.kind === 'video' || clip.kind === 'audio' ? clip : null
  if (edge === 'start') {
    let min = 0
    for (const c of others) if (clipEnd(c) <= clip.start) min = Math.max(min, clipEnd(c))
    // Weiter nach links als bis zum Anfang der Quelle geht es nicht.
    if (media) min = Math.max(min, clip.start - Math.floor(media.sourceIn / media.speed))
    return { min, max: Math.max(min, end - MIN_CLIP_DURATION) }
  }
  let max = Number.MAX_SAFE_INTEGER
  for (const c of others) if (c.start >= end) max = Math.min(max, c.start)
  const limit = sourceLimit(doc, clip)
  if (media && limit !== null)
    max = Math.min(max, clip.start + Math.floor((limit - media.sourceIn) / media.speed))
  const min = clip.start + MIN_CLIP_DURATION
  return { min, max: Math.max(min, max) }
}

/**
 * Clip an der Zeit `at` teilen. Verknüpfte Clips, die `at` ebenfalls
 * überdecken, werden mitgeteilt; ihre rechten Hälften bilden eine neue Gruppe.
 */
export function splitClip(
  doc: TimelineDoc,
  clipId: string,
  at: Time,
  opts: { linked?: boolean; ids?: () => string } = {},
): OpResult {
  const loc = findClip(doc, clipId)
  if (!loc) return fail('clip-not-found')
  if (!isTime(at)) return fail('invalid-time')
  const spans = (c: Clip) => c.start < at && at < clipEnd(c)
  if (!spans(loc.clip)) return fail('invalid-time')
  const members = linkedClips(doc, loc, opts.linked ?? true).filter((m) => spans(m.clip))
  if (members.some((m) => m.track.locked)) return fail('track-locked')
  if (
    members.some(
      (m) => at - m.clip.start < MIN_CLIP_DURATION || clipEnd(m.clip) - at < MIN_CLIP_DURATION,
    )
  )
    return fail('too-short')

  const ids = opts.ids ?? createId
  const rightGroup = members.length > 1 ? ids() : undefined
  let next = doc
  for (const m of members) {
    const left = { ...m.clip, duration: at - m.clip.start } as Clip
    let right = { ...m.clip, id: ids(), start: at, duration: clipEnd(m.clip) - at } as Clip
    if (right.kind === 'video' || right.kind === 'audio')
      right = { ...right, sourceIn: right.sourceIn + sourceSpan(left.duration, right.speed) }
    if (rightGroup) right.linkGroup = rightGroup
    else delete right.linkGroup
    if (hasId(next, right.id)) return fail('duplicate-id')
    const lane = next.tracks[m.trackIndex].clips.filter((c) => c.id !== m.clip.id)
    next = withClips(next, m.trackIndex, [...lane, left, right])
  }
  return ok(next)
}

/**
 * Clip löschen (samt verknüpften Clips, abschaltbar). Mit `ripple` rücken alle
 * späteren Clips nach vorn – auf allen nicht gesperrten Spuren um denselben
 * Betrag, damit Bild und Ton zusammenbleiben. Der Betrag ist die Länge des
 * gelöschten Bereichs, höchstens aber so viel, wie auf jeder Spur frei ist.
 */
export function removeClip(
  doc: TimelineDoc,
  clipId: string,
  opts: { ripple?: boolean; linked?: boolean } = {},
): OpResult {
  const loc = findClip(doc, clipId)
  if (!loc) return fail('clip-not-found')
  const members = linkedClips(doc, loc, opts.linked ?? true)
  if (members.some((m) => m.track.locked)) return fail('track-locked')
  const removedIds = new Set(members.map((m) => m.clip.id))
  const lanes = doc.tracks.map((t) => t.clips.filter((c) => !removedIds.has(c.id)) as Clip[])

  let shift = 0
  let rangeEnd = 0
  if (opts.ripple) {
    const rangeStart = Math.min(...members.map((m) => m.clip.start))
    rangeEnd = Math.max(...members.map((m) => clipEnd(m.clip)))
    shift = rangeEnd - rangeStart
    doc.tracks.forEach((track, i) => {
      if (track.locked) return
      let firstLater: Time | null = null
      let earlierEnd = 0
      for (const c of lanes[i]) {
        if (c.start >= rangeEnd)
          firstLater = firstLater === null ? c.start : Math.min(firstLater, c.start)
        else earlierEnd = Math.max(earlierEnd, clipEnd(c))
      }
      if (firstLater !== null) shift = Math.min(shift, firstLater - earlierEnd)
    })
    shift = Math.max(0, shift)
  }

  let next = doc
  doc.tracks.forEach((track, i) => {
    const touched = lanes[i].length !== track.clips.length
    const ripple = shift > 0 && !track.locked && lanes[i].some((c) => c.start >= rangeEnd)
    if (!touched && !ripple) return
    const clips = ripple
      ? lanes[i].map((c) => (c.start >= rangeEnd ? { ...c, start: c.start - shift } : c))
      : lanes[i]
    next = withClips(next, i, clips)
  })
  return ok(next)
}

// --- Zusammengesetzte Befehle ----------------------------------------------

function trackEnd(track: Track): Time {
  let end = 0
  for (const c of track.clips) end = Math.max(end, clipEnd(c))
  return end
}

/** Nächster freier Name wie „V2“ für eine neue Spur. */
export function nextTrackName(doc: TimelineDoc, prefix: string): string {
  const names = new Set(doc.tracks.map((t) => t.name))
  let n = 1
  while (names.has(`${prefix}${n}`)) n++
  return `${prefix}${n}`
}

/**
 * Video aus der Medienliste ans Ende der Timeline legen: Bild auf die oberste
 * freie Video-Spur, Ton (falls vorhanden) verknüpft auf die oberste freie
 * Ton-Spur. Fehlende oder gesperrte Spuren werden neu angelegt. Ist die
 * Timeline noch leer, übernimmt das Projekt Größe und Bildrate des Videos.
 */
export function appendMedia(
  doc: TimelineDoc,
  assetId: string,
  opts: { ids?: () => string } = {},
): OpResult {
  const asset = doc.assets[assetId]
  if (!asset) return fail('asset-not-found')
  // Bilder und reine Tondateien folgen mit den Bild-Clips bzw. der Musik-Spur.
  if (asset.kind !== 'video' || asset.duration === null) return fail('kind-mismatch')
  if (asset.duration < MIN_CLIP_DURATION) return fail('too-short')
  const ids = opts.ids ?? createId
  let next = doc

  if (!doc.tracks.some((t) => t.clips.length > 0) && asset.width && asset.height) {
    next = {
      ...next,
      settings: {
        ...next.settings,
        width: asset.width,
        height: asset.height,
        fps: asset.fps && asset.fps > 0 ? asset.fps : next.settings.fps,
      },
    }
  }

  /** Oberste freie Spur dieser Art; sonst eine neue. `null` = Anlegen abgelehnt. */
  const useTrack = (kind: 'video' | 'audio', prefix: string): string | null => {
    const free = next.tracks.find((t) => t.kind === kind && !t.locked)
    if (free) return free.id
    const id = ids()
    // Bild-Spuren oben, Ton-Spuren unten einsortieren.
    const index = kind === 'video' ? 0 : next.tracks.length
    const added = addTrack(next, { id, kind, name: nextTrackName(next, prefix) }, index)
    if (!added.ok) return null
    next = added.doc
    return id
  }

  const videoTrackId = useTrack('video', 'V')
  const audioTrackId = asset.hasAudio ? useTrack('audio', 'A') : null
  if (videoTrackId === null || (asset.hasAudio && audioTrackId === null))
    return fail('duplicate-id')

  // Bild und Ton beginnen gemeinsam hinter dem letzten Clip beider Spuren.
  const used = next.tracks.filter((t) => t.id === videoTrackId || t.id === audioTrackId)
  const start = Math.max(0, ...used.map(trackEnd))
  const linkGroup = audioTrackId ? ids() : undefined
  const base = { asset: assetId, start, duration: asset.duration, sourceIn: 0, speed: 1 }
  const video = insertClip(next, videoTrackId, {
    ...base,
    id: ids(),
    kind: 'video',
    ...(linkGroup ? { linkGroup } : {}),
  })
  if (!video.ok || !audioTrackId) return video
  return insertClip(video.doc, audioTrackId, {
    ...base,
    id: ids(),
    kind: 'audio',
    gain: 1,
    linkGroup,
  })
}

// --- Einrasten --------------------------------------------------------------

/** Mögliche Einrastpunkte: 0, Clip-Ränder, Marker und (optional) der Abspielkopf. */
export function snapPoints(
  doc: TimelineDoc,
  opts: { exclude?: readonly string[]; playhead?: Time } = {},
): Time[] {
  const exclude = new Set(opts.exclude ?? [])
  const points = new Set<Time>([0])
  for (const t of doc.tracks)
    for (const c of t.clips) {
      if (exclude.has(c.id)) continue
      points.add(c.start)
      points.add(clipEnd(c))
    }
  for (const m of doc.markers) points.add(m.at)
  if (opts.playhead !== undefined && isTime(opts.playhead)) points.add(opts.playhead)
  return [...points].sort((a, b) => a - b)
}

/** Nächstgelegener Einrastpunkt innerhalb der Toleranz, sonst die Zeit selbst. */
export function snapTime(
  time: Time,
  points: readonly Time[],
  tolerance: Time,
): { time: Time; snapped: boolean } {
  let best: Time | null = null
  for (const p of points) {
    const d = Math.abs(p - time)
    if (d <= tolerance && (best === null || d < Math.abs(best - time))) best = p
  }
  return best === null ? { time, snapped: false } : { time: best, snapped: true }
}

// --- Prüfung ----------------------------------------------------------------

export interface DocIssue {
  error: OpError
  /** Betroffene Spur bzw. betroffener Clip. */
  id: string
}

/** Prüft die Regeln des Modells für ein ganzes Dokument (z. B. nach dem Laden). */
export function validateDoc(doc: TimelineDoc): DocIssue[] {
  const issues: DocIssue[] = []
  const seen = new Set<string>()
  const note = (id: string) => {
    if (seen.has(id)) issues.push({ error: 'duplicate-id', id })
    seen.add(id)
  }
  for (const m of doc.markers) {
    note(m.id)
    if (!isTime(m.at)) issues.push({ error: 'invalid-time', id: m.id })
  }
  for (const track of doc.tracks) {
    note(track.id)
    const sorted = (track.clips as Clip[]).slice().sort(byStart)
    sorted.forEach((clip, i) => {
      note(clip.id)
      if (!trackAccepts(track.kind, clip.kind)) issues.push({ error: 'kind-mismatch', id: clip.id })
      const error = checkClip(doc, clip)
      if (error) issues.push({ error, id: clip.id })
      if (i > 0 && clipEnd(sorted[i - 1]) > clip.start)
        issues.push({ error: 'overlap', id: clip.id })
    })
  }
  return issues
}
