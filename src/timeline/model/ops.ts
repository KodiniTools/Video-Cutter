/**
 * Befehle auf dem Timeline-Dokument. Alle Funktionen sind rein: Sie verändern
 * ihre Eingabe nie, sondern liefern ein neues Dokument oder einen Ablehnungsgrund.
 */
import { isTime, MAX_SPEED, MICROS_PER_SECOND, MIN_CLIP_DURATION, MIN_SPEED } from './time'
import {
  CLIP_TRANSITIONS,
  FADE_CURVES,
  type ClipColor,
  type ClipLayout,
  type LayoutKey,
  type ClipTransitionPreset,
  TIMELINE_DOC_VERSION,
  type AssetRef,
  type AudioClip,
  type Clip,
  type ClipCrop,
  type ClipFade,
  type ClipKind,
  type FadeCurve,
  MARKER_EFFECTS,
  type Marker,
  type MarkerEffect,
  type MarkerEffectKind,
  type OpError,
  type OpResult,
  type OverlayClip,
  type Time,
  type TimelineDoc,
  type TimelineSettings,
  type Track,
  type TrackKind,
  type VolumePoint,
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
  if (
    (clip.kind === 'video' || clip.kind === 'still') &&
    clip.hold !== undefined &&
    typeof clip.hold !== 'boolean'
  )
    return 'invalid-settings'
  if ((clip.kind === 'video' || clip.kind === 'still') && clip.layout !== undefined) {
    const l = clip.layout
    const unit = (v: unknown) => typeof v === 'number' && v >= 0 && v <= 1
    if (!l || !unit(l.x) || !unit(l.y) || !unit(l.opacity) || !unit(l.scale)) {
      return 'invalid-settings'
    }
    if (l.scale < MIN_LAYOUT_SCALE) return 'invalid-settings'
    if (l.ease !== undefined && l.ease !== 'smooth') return 'invalid-settings'
    if (l.keys !== undefined) {
      if (!Array.isArray(l.keys) || l.keys.length === 0 || l.keys.length > MAX_LAYOUT_KEYS)
        return 'invalid-settings'
      for (let i = 0; i < l.keys.length; i++) {
        const k = l.keys[i]
        if (!k || !isTime(k.at) || !unit(k.x) || !unit(k.y) || !unit(k.scale))
          return 'invalid-settings'
        if (k.scale < MIN_LAYOUT_SCALE) return 'invalid-settings'
        if (k.opacity !== undefined && !unit(k.opacity)) return 'invalid-settings'
        if (i > 0 && k.at <= l.keys[i - 1].at) return 'invalid-settings'
      }
    }
  }
  if ((clip.kind === 'video' || clip.kind === 'still') && clip.color !== undefined) {
    const c = clip.color
    const part = (v: unknown) => typeof v === 'number' && v >= -1 && v <= 1
    if (!c || !part(c.brightness) || !part(c.contrast) || !part(c.saturation)) {
      return 'invalid-settings'
    }
  }
  if ((clip.kind === 'video' || clip.kind === 'still') && clip.transitionIn !== undefined) {
    const t = clip.transitionIn
    if (
      !(CLIP_TRANSITIONS as readonly string[]).includes(t?.preset) ||
      !isTime(t.duration) ||
      t.duration < MIN_TRANSITION ||
      t.duration > MAX_TRANSITION
    )
      return 'invalid-settings'
  }
  if ((clip.kind === 'video' || clip.kind === 'still') && clip.fadeOut !== undefined) {
    const f = clip.fadeOut
    if (!f || !isTime(f.duration) || f.duration < MIN_TRANSITION || f.duration > MAX_TRANSITION)
      return 'invalid-settings'
  }
  if (clip.kind === 'audio') {
    for (const fade of [clip.fadeIn, clip.fadeOut]) {
      if (fade === undefined) continue
      if (!isTime(fade.duration) || fade.duration <= 0 || !isFadeCurve(fade.curve))
        return 'invalid-settings'
    }
    if (clip.envelope !== undefined) {
      const e = clip.envelope
      if (!Array.isArray(e) || e.length === 0 || e.length > MAX_ENVELOPE_POINTS)
        return 'invalid-settings'
      for (let i = 0; i < e.length; i++) {
        const p = e[i]
        if (!p || !isTime(p.at) || !(p.gain >= 0 && p.gain <= MAX_CLIP_GAIN))
          return 'invalid-settings'
        if (i > 0 && p.at <= e[i - 1].at) return 'invalid-settings'
      }
    }
  }
  return null
}

function isFadeCurve(v: unknown): v is FadeCurve {
  return typeof v === 'string' && (FADE_CURVES as readonly string[]).includes(v)
}

/**
 * Keyframes eines Ebenen-Clips (`data.keys`, Zeit ab Clip-Anfang) um `delta`
 * verschieben: Beim Kürzen vorn und beim Teilen bleiben sie so an ihrer Stelle
 * auf der Timeline.
 */
function shiftDataKeys<T extends Clip>(clip: T, delta: Time): T {
  if (!('data' in clip) || delta === 0 || !Array.isArray(clip.data.keys)) return clip
  const keys = (clip.data.keys as unknown[]).map((k) => {
    const at = (k as { at?: unknown } | null)?.at
    return typeof at === 'number' ? { ...(k as object), at: at + delta } : k
  })
  return { ...clip, data: { ...clip.data, keys } }
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

/** Spuren ohne Clips, die sich entfernen lassen (gesperrte bleiben). */
export function emptyTrackIds(doc: TimelineDoc): string[] {
  return doc.tracks.filter((t) => t.clips.length === 0 && !t.locked).map((t) => t.id)
}

/** Alle leeren, nicht gesperrten Spuren in einem Schritt entfernen. */
export function removeEmptyTracks(doc: TimelineDoc): OpResult {
  const empty = new Set(emptyTrackIds(doc))
  if (empty.size === 0) return ok(doc)
  return ok({ ...doc, tracks: doc.tracks.filter((t) => !empty.has(t.id)) })
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
  /** Automatisches Absenken einer Ton-Spur (0 … 1); 0 oder `null` schaltet es aus. */
  duck?: number | null
}

/** Voreinstellung fürs automatische Absenken: die Spur wird um 70 % leiser. */
export const DEFAULT_DUCK = 0.7

/** Gültige Stärke des Absenkens (auf 0,05 gerundet) oder `undefined` für „aus“. */
export function normalizeDuck(duck: number | null | undefined): number | undefined {
  if (duck === null || duck === undefined || !Number.isFinite(duck)) return undefined
  const value = Math.round(Math.min(1, Math.max(0, duck)) * 20) / 20
  return value > 0 ? value : undefined
}

/** Spur-Eigenschaften ändern; Felder, die die Spur-Art nicht kennt, werden ignoriert. */
export function updateTrack(doc: TimelineDoc, trackId: string, patch: TrackPatch): OpResult {
  const index = doc.tracks.findIndex((t) => t.id === trackId)
  if (index < 0) return fail('track-not-found')
  const track = doc.tracks[index]
  const next: Record<string, unknown> = { ...track }
  let changed = false
  if (patch.duck !== undefined && track.kind === 'audio') {
    const duck = normalizeDuck(patch.duck)
    if (duck !== track.duck) {
      if (duck === undefined) delete next.duck
      else next.duck = duck
      changed = true
    }
  }
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'duck' || value === undefined || !(key in track)) continue
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

/**
 * Mehrere Clips gemeinsam auf EINE Ebenen-Spur legen (z. B. Untertitel): auf
 * die oberste entsperrte, die für alle frei ist – sonst entsteht ganz oben
 * eine neue. Die Clips dürfen sich untereinander nicht überschneiden.
 */
export function insertOverlayClips(
  doc: TimelineDoc,
  clips: readonly OverlayClip[],
  trackName: string,
  trackId: string = createId(),
): OpResult {
  if (clips.length === 0) return ok(doc)
  const free = doc.tracks.find(
    (t) =>
      t.kind === 'overlay' &&
      !t.locked &&
      clips.every((c) => !overlaps(t.clips, c.start, clipEnd(c))),
  )
  let next = doc
  let target = free?.id
  if (target === undefined) {
    const added = addTrack(doc, { kind: 'overlay', name: trackName, id: trackId }, 0)
    if (!added.ok) return added
    next = added.doc
    target = trackId
  }
  for (const clip of clips) {
    const r = insertClip(next, target, clip)
    if (!r.ok) return r
    next = r.doc
  }
  return ok(next)
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
    next = shiftDataKeys({ ...clip, start: to, duration }, clip.start - to)
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

/** Größte Lautstärke eines Ton-Clips (2 = doppelt so laut). */
export const MAX_CLIP_GAIN = 2

/**
 * Marker beim Nachrücken mitnehmen: Marker ab `from` wandern um `shift` (µs,
 * negativ = nach vorn). Marker im geschlossenen Bereich davor landen an dessen
 * Anfang. Treffen dabei zwei Marker dieselbe Zeit, bleibt der mit Namen, sonst
 * der frühere.
 */
function shiftMarkers(doc: TimelineDoc, from: Time, shift: Time): TimelineDoc {
  if (shift === 0 || doc.markers.length === 0) return doc
  const floor = Math.max(0, from + shift)
  const moved = doc.markers.map((m) => {
    const at = m.at >= from ? m.at + shift : shift < 0 ? Math.min(m.at, floor) : m.at
    return at === m.at ? m : { ...m, at }
  })
  if (moved.every((m, i) => m === doc.markers[i])) return doc
  const kept: Marker[] = []
  for (const m of moved) {
    const last = kept[kept.length - 1]
    if (!last || last.at !== m.at) kept.push(m)
    else if (!last.label && m.label) kept[kept.length - 1] = m
  }
  return { ...doc, markers: kept }
}

/**
 * Tempo eines Video- oder Ton-Clips ändern. Der verwendete Bereich der Quelle
 * bleibt gleich, die Länge auf der Timeline ändert sich (schneller = kürzer).
 * Verknüpfte Clips (Bild + Ton) bekommen dasselbe Tempo (abschaltbar).
 *
 * Mit `ripple` rücken alle späteren Clips mit – auf allen nicht gesperrten
 * Spuren um denselben Betrag: nach hinten, wenn der Clip länger wird, nach
 * vorn (so weit frei ist), wenn er kürzer wird. Marker dahinter wandern mit.
 * Ohne `ripple` wird abgelehnt, wenn der längere Clip an seinen Nachbarn stößt.
 */
export function setClipSpeed(
  doc: TimelineDoc,
  clipId: string,
  speed: number,
  opts: { linked?: boolean; ripple?: boolean } = {},
): OpResult {
  const loc = findClip(doc, clipId)
  if (!loc) return fail('clip-not-found')
  if (loc.clip.kind !== 'video' && loc.clip.kind !== 'audio') return fail('kind-mismatch')
  if (!(speed >= MIN_SPEED && speed <= MAX_SPEED)) return fail('invalid-time')
  const members = linkedClips(doc, loc, opts.linked ?? true)
  if (members.some((m) => m.track.locked)) return fail('track-locked')

  const changed = new Map<string, Clip>()
  let oldEnd = 0
  let newEnd = 0
  for (const { clip } of members) {
    if ((clip.kind !== 'video' && clip.kind !== 'audio') || clip.speed === speed) continue
    // Abrunden: nie mehr Quelle verbrauchen als bisher (Ende der Quelle).
    const duration = Math.floor(sourceSpan(clip.duration, clip.speed) / speed)
    if (duration < MIN_CLIP_DURATION) return fail('too-short')
    const next: Clip = { ...clip, speed, duration }
    const error = checkClip(doc, next)
    if (error) return fail(error)
    changed.set(clip.id, next)
    oldEnd = Math.max(oldEnd, clipEnd(clip))
    newEnd = Math.max(newEnd, clipEnd(next))
  }
  if (changed.size === 0) return ok(doc)

  const lanes = doc.tracks.map((t) => (t.clips as Clip[]).map((c) => changed.get(c.id) ?? c))
  const later = (c: Clip) => !changed.has(c.id) && c.start >= oldEnd
  let shift = opts.ripple ? newEnd - oldEnd : 0
  if (shift < 0) {
    // Nach vorn nur so weit, wie auf jeder Spur frei ist.
    doc.tracks.forEach((track, i) => {
      if (track.locked) return
      let firstLater: Time | null = null
      let earlierEnd = 0
      for (const c of lanes[i]) {
        if (later(c)) firstLater = firstLater === null ? c.start : Math.min(firstLater, c.start)
        else earlierEnd = Math.max(earlierEnd, clipEnd(c))
      }
      if (firstLater !== null) shift = Math.max(shift, earlierEnd - firstLater)
    })
    shift = Math.min(0, shift)
  }

  let result = doc
  for (let i = 0; i < doc.tracks.length; i++) {
    const track = doc.tracks[i]
    const touched = lanes[i].some((c) => changed.has(c.id))
    const ripple = shift !== 0 && !track.locked && lanes[i].some(later)
    if (!touched && !ripple) continue
    const clips = ripple
      ? lanes[i].map((c) => (later(c) ? { ...c, start: c.start + shift } : c))
      : lanes[i]
    const sorted = clips.slice().sort(byStart)
    if (sorted.some((c, k) => k > 0 && clipEnd(sorted[k - 1]) > c.start)) return fail('overlap')
    result = withClips(result, i, clips)
  }
  return ok(shiftMarkers(result, oldEnd, shift))
}

/** Kleinster Zuschnitt: Anteil der Quelle, der mindestens sichtbar bleibt. */
export const MIN_CROP_SIZE = 0.1

/** Zuschnitt in gültige Grenzen bringen; das ganze Bild (oder Ungültiges) ergibt `null`. */
export function normalizeCrop(crop: ClipCrop | null | undefined): ClipCrop | null {
  if (!crop) return null
  const { x, y, width, height } = crop
  if (![x, y, width, height].every((v) => Number.isFinite(v))) return null
  const round = (v: number) => Math.round(v * 10000) / 10000
  const w = round(Math.min(1, Math.max(MIN_CROP_SIZE, width)))
  const h = round(Math.min(1, Math.max(MIN_CROP_SIZE, height)))
  const cx = round(Math.min(1 - w, Math.max(0, x)))
  const cy = round(Math.min(1 - h, Math.max(0, y)))
  if (cx === 0 && cy === 0 && w === 1 && h === 1) return null
  return { x: cx, y: cy, width: w, height: h }
}

/** Farbkorrektur in gültige Grenzen bringen; alles auf 0 (oder Ungültiges) ergibt `null`. */
export function normalizeColor(color: ClipColor | null | undefined): ClipColor | null {
  if (!color) return null
  const { brightness, contrast, saturation } = color
  if (![brightness, contrast, saturation].every((v) => Number.isFinite(v))) return null
  const part = (v: number) => Math.round(Math.min(1, Math.max(-1, v)) * 100) / 100 || 0
  const next = {
    brightness: part(brightness),
    contrast: part(contrast),
    saturation: part(saturation),
  }
  if (next.brightness === 0 && next.contrast === 0 && next.saturation === 0) return null
  return next
}

/**
 * Farbkorrektur eines Video-Clips: Helligkeit, Kontrast und Sättigung, je
 * −1 … 1. `null` oder alles auf 0 hebt sie auf.
 */
export function setClipColor(doc: TimelineDoc, clipId: string, color: ClipColor | null): OpResult {
  const loc = findClip(doc, clipId)
  if (!loc) return fail('clip-not-found')
  if (loc.track.locked) return fail('track-locked')
  const clip = loc.clip
  if (clip.kind !== 'video' && clip.kind !== 'still') return fail('kind-mismatch')
  const next = normalizeColor(color)
  const before = normalizeColor(clip.color)
  if (
    (next === null && before === null) ||
    (next !== null &&
      before !== null &&
      next.brightness === before.brightness &&
      next.contrast === before.contrast &&
      next.saturation === before.saturation)
  ) {
    return ok(doc)
  }
  const changed: Clip = { ...clip }
  if (next) changed.color = next
  else delete changed.color
  const clips = loc.track.clips.map((c) => (c.id === clipId ? changed : c))
  return ok(withClips(doc, loc.trackIndex, clips as Clip[]))
}

/** Kleinste Größe eines Clips im Bild (Anteil des Projektformats). */
export const MIN_LAYOUT_SCALE = 0.05

/** Höchstzahl der Keyframes einer Lage. */
export const MAX_LAYOUT_KEYS = 32

/**
 * Lage in gültige Grenzen bringen; volle Größe und Deckkraft ohne Keyframes
 * (oder Ungültiges) ergibt `null`. Keyframes werden sortiert, je Zeit bleibt
 * der letzte, fehlende Deckkraft kommt vom Clip; mit Keyframes trägt die Lage
 * die Werte des ersten.
 */
export function normalizeLayout(layout: ClipLayout | null | undefined): ClipLayout | null {
  if (!layout) return null
  const { x, y, scale, opacity } = layout
  if (![x, y, scale, opacity].every((v) => Number.isFinite(v))) return null
  const round = (v: number) => Math.round(v * 10000) / 10000
  const unit = (v: number) => round(Math.min(1, Math.max(0, v)))
  const size = (v: number) => round(Math.min(1, Math.max(MIN_LAYOUT_SCALE, v)))
  const o = unit(opacity)
  const byTime = new Map<Time, LayoutKey>()
  for (const k of Array.isArray(layout.keys) ? layout.keys : []) {
    if (!k || !isTime(k.at) || ![k.x, k.y, k.scale].every((v) => Number.isFinite(v))) continue
    byTime.set(k.at, {
      at: k.at,
      x: unit(k.x),
      y: unit(k.y),
      scale: size(k.scale),
      opacity: typeof k.opacity === 'number' && Number.isFinite(k.opacity) ? unit(k.opacity) : o,
    })
  }
  const keys = [...byTime.values()].sort((a, b) => a.at - b.at).slice(0, MAX_LAYOUT_KEYS)
  if (keys.length > 0) {
    const first = keys[0]
    return {
      x: first.x,
      y: first.y,
      scale: first.scale,
      opacity: first.opacity ?? o,
      keys,
      ...(layout.ease === 'smooth' ? { ease: 'smooth' as const } : {}),
    }
  }
  const s = size(scale)
  if (s === 1 && o === 1) return null
  return { x: unit(x), y: unit(y), scale: s, opacity: o }
}

/**
 * Lage eines Video-Clips im Bild (Bild-in-Bild): Größe, Mitte und Deckkraft.
 * `null` oder volle Größe mit voller Deckkraft hebt sie auf.
 */
export function setClipLayout(
  doc: TimelineDoc,
  clipId: string,
  layout: ClipLayout | null,
): OpResult {
  const loc = findClip(doc, clipId)
  if (!loc) return fail('clip-not-found')
  if (loc.track.locked) return fail('track-locked')
  const clip = loc.clip
  if (clip.kind !== 'video' && clip.kind !== 'still') return fail('kind-mismatch')
  const next = normalizeLayout(layout)
  const before = normalizeLayout(clip.layout)
  // Normalisiert haben beide dieselbe Feldfolge: Textvergleich genügt.
  if (JSON.stringify(next) === JSON.stringify(before)) return ok(doc)
  const changed: Clip = { ...clip }
  if (next) changed.layout = next
  else delete changed.layout
  const clips = loc.track.clips.map((c) => (c.id === clipId ? changed : c))
  return ok(withClips(doc, loc.trackIndex, clips as Clip[]))
}

/**
 * Zuschnitt eines Video-Clips (Anteile der Quelle). `null` oder das ganze Bild
 * hebt ihn auf. Das zugeschnittene Bild wird wie jedes Video ins Projektformat
 * eingepasst.
 */
export function setClipCrop(doc: TimelineDoc, clipId: string, crop: ClipCrop | null): OpResult {
  const loc = findClip(doc, clipId)
  if (!loc) return fail('clip-not-found')
  if (loc.track.locked) return fail('track-locked')
  const clip = loc.clip
  if (clip.kind !== 'video' && clip.kind !== 'still') return fail('kind-mismatch')
  const next = normalizeCrop(crop)
  const before = normalizeCrop(clip.crop)
  if (
    (next === null && before === null) ||
    (next !== null &&
      before !== null &&
      next.x === before.x &&
      next.y === before.y &&
      next.width === before.width &&
      next.height === before.height)
  ) {
    return ok(doc)
  }
  const changed: Clip = { ...clip }
  if (next) changed.crop = next
  else delete changed.crop
  const clips = loc.track.clips.map((c) => (c.id === clipId ? changed : c))
  return ok(withClips(doc, loc.trackIndex, clips as Clip[]))
}

/** Kürzester und längster Übergang (Gesamtdauer). */
export const MIN_TRANSITION: Time = 100_000
export const MAX_TRANSITION: Time = 10 * MICROS_PER_SECOND

/**
 * Übergang am Anfang eines Video-Clips setzen; `null` hebt ihn auf. Die Dauer
 * wird auf den erlaubten Bereich begrenzt; ohne `duration` bleibt die
 * bisherige (sonst 1 s).
 */
export function setClipTransition(
  doc: TimelineDoc,
  clipId: string,
  transition: { preset: ClipTransitionPreset; duration?: Time } | null,
): OpResult {
  const loc = findClip(doc, clipId)
  if (!loc) return fail('clip-not-found')
  if (loc.track.locked) return fail('track-locked')
  const clip = loc.clip
  if (clip.kind !== 'video' && clip.kind !== 'still') return fail('kind-mismatch')
  const before = clip.transitionIn
  const changed: Clip = { ...clip }
  if (transition === null) {
    if (!before) return ok(doc)
    delete changed.transitionIn
  } else {
    if (!(CLIP_TRANSITIONS as readonly string[]).includes(transition.preset))
      return fail('invalid-settings')
    const wanted = transition.duration ?? before?.duration ?? MICROS_PER_SECOND
    if (!Number.isFinite(wanted)) return fail('invalid-time')
    const duration = Math.min(MAX_TRANSITION, Math.max(MIN_TRANSITION, Math.round(wanted)))
    if (before && before.preset === transition.preset && before.duration === duration)
      return ok(doc)
    changed.transitionIn = { preset: transition.preset, duration }
  }
  const clips = loc.track.clips.map((c) => (c.id === clipId ? changed : c))
  return ok(withClips(doc, loc.trackIndex, clips as Clip[]))
}

/**
 * Bild am Ende eines Video-Clips ausblenden; `null` hebt es auf. Die Dauer
 * wird auf den erlaubten Bereich begrenzt; ohne `duration` bleibt die
 * bisherige (sonst 1 s).
 */
export function setClipFadeOut(
  doc: TimelineDoc,
  clipId: string,
  fade: { duration?: Time } | null,
): OpResult {
  const loc = findClip(doc, clipId)
  if (!loc) return fail('clip-not-found')
  if (loc.track.locked) return fail('track-locked')
  const clip = loc.clip
  if (clip.kind !== 'video' && clip.kind !== 'still') return fail('kind-mismatch')
  const before = clip.fadeOut
  const changed: Clip = { ...clip }
  if (fade === null) {
    if (!before) return ok(doc)
    delete changed.fadeOut
  } else {
    const wanted = fade.duration ?? before?.duration ?? MICROS_PER_SECOND
    if (!Number.isFinite(wanted)) return fail('invalid-time')
    const duration = Math.min(MAX_TRANSITION, Math.max(MIN_TRANSITION, Math.round(wanted)))
    if (before && before.duration === duration) return ok(doc)
    changed.fadeOut = { duration }
  }
  const clips = loc.track.clips.map((c) => (c.id === clipId ? changed : c))
  return ok(withClips(doc, loc.trackIndex, clips as Clip[]))
}

/**
 * Letztes Bild eines Video-Clips halten, bis der nächste Clip derselben Spur
 * beginnt: Die Lücke dazwischen zeigt dann ein Standbild statt des Hintergrunds.
 */
export function setClipHold(doc: TimelineDoc, clipId: string, hold: boolean): OpResult {
  const loc = findClip(doc, clipId)
  if (!loc) return fail('clip-not-found')
  if (loc.track.locked) return fail('track-locked')
  const clip = loc.clip
  if (clip.kind !== 'video' && clip.kind !== 'still') return fail('kind-mismatch')
  if ((clip.hold === true) === hold) return ok(doc)
  const changed: Clip = { ...clip }
  if (hold) changed.hold = true
  else delete changed.hold
  const clips = loc.track.clips.map((c) => (c.id === clipId ? changed : c))
  return ok(withClips(doc, loc.trackIndex, clips as Clip[]))
}

/** Längste Ton-Blende, die sich einstellen lässt. */
export const MAX_CLIP_FADE: Time = 10 * MICROS_PER_SECOND

/**
 * Ton eines Clips am Anfang (`in`) oder Ende (`out`) ein- bzw. ausblenden.
 * Dauer 0 oder `null` hebt die Blende auf. Beide Blenden zusammen sind
 * höchstens so lang wie der Clip; ohne `curve` bleibt die bisherige Kurve
 * (sonst linear).
 */
export function setClipFade(
  doc: TimelineDoc,
  clipId: string,
  side: 'in' | 'out',
  fade: { duration: Time; curve?: FadeCurve } | null,
): OpResult {
  const loc = findClip(doc, clipId)
  if (!loc) return fail('clip-not-found')
  if (loc.track.locked) return fail('track-locked')
  const clip = loc.clip
  if (clip.kind !== 'audio') return fail('kind-mismatch')
  const key = side === 'in' ? 'fadeIn' : 'fadeOut'
  const before = clip[key]
  const other = (side === 'in' ? clip.fadeOut : clip.fadeIn)?.duration ?? 0
  let next: ClipFade | undefined
  if (fade) {
    if (!Number.isFinite(fade.duration)) return fail('invalid-settings')
    if (fade.curve !== undefined && !isFadeCurve(fade.curve)) return fail('invalid-settings')
    const room = Math.max(0, Math.min(MAX_CLIP_FADE, clip.duration - other))
    const duration = Math.round(Math.min(room, Math.max(0, fade.duration)))
    if (duration > 0) next = { duration, curve: fade.curve ?? before?.curve ?? 'tri' }
  }
  if (next?.duration === before?.duration && next?.curve === before?.curve) return ok(doc)
  const changed: Clip = { ...clip }
  if (next) changed[key] = next
  else delete changed[key]
  const clips = loc.track.clips.map((c) => (c.id === clipId ? changed : c))
  return ok(withClips(doc, loc.trackIndex, clips as Clip[]))
}

/** Lautstärke eines Ton-Clips (0 = stumm, 1 = unverändert, höchstens `MAX_CLIP_GAIN`). */
export function setClipGain(doc: TimelineDoc, clipId: string, gain: number): OpResult {
  const loc = findClip(doc, clipId)
  if (!loc) return fail('clip-not-found')
  if (loc.track.locked) return fail('track-locked')
  const clip = loc.clip
  if (clip.kind !== 'audio') return fail('kind-mismatch')
  if (!Number.isFinite(gain)) return fail('invalid-settings')
  const next = Math.min(MAX_CLIP_GAIN, Math.max(0, gain))
  if (next === clip.gain) return ok(doc)
  const clips = loc.track.clips.map((c) => (c.id === clipId ? { ...clip, gain: next } : c))
  return ok(withClips(doc, loc.trackIndex, clips as Clip[]))
}

/** So viele Punkte kann eine Lautstärke-Kurve höchstens haben. */
export const MAX_ENVELOPE_POINTS = 32

/**
 * Punkte einer Lautstärke-Kurve bereinigen: sortiert, Werte begrenzt und auf
 * ganze Prozent gerundet, je Zeit nur ein Punkt (der letzte gewinnt).
 * `null`, wenn kein gültiger Punkt übrig bleibt.
 */
export function normalizeEnvelope(
  points: readonly VolumePoint[] | null | undefined,
): VolumePoint[] | null {
  if (!points) return null
  const byTime = new Map<Time, number>()
  for (const p of points) {
    if (!p || !Number.isFinite(p.at) || !Number.isFinite(p.gain)) continue
    const at = Math.max(0, Math.round(p.at))
    byTime.set(at, Math.round(Math.min(MAX_CLIP_GAIN, Math.max(0, p.gain)) * 100) / 100)
  }
  const out = [...byTime.entries()].sort((a, b) => a[0] - b[0]).map(([at, gain]) => ({ at, gain }))
  return out.length > 0 ? out.slice(0, MAX_ENVELOPE_POINTS) : null
}

/** Lautstärke-Kurve eines Ton-Clips setzen; `null` oder keine Punkte hebt sie auf. */
export function setClipEnvelope(
  doc: TimelineDoc,
  clipId: string,
  points: readonly VolumePoint[] | null,
): OpResult {
  const loc = findClip(doc, clipId)
  if (!loc) return fail('clip-not-found')
  if (loc.track.locked) return fail('track-locked')
  const clip = loc.clip
  if (clip.kind !== 'audio') return fail('kind-mismatch')
  if (points && points.length > MAX_ENVELOPE_POINTS) return fail('too-many')
  const next = normalizeEnvelope(points)
  const before = clip.envelope ?? null
  if (JSON.stringify(next) === JSON.stringify(before)) return ok(doc)
  const changed: Clip = { ...clip }
  if (next) changed.envelope = next
  else delete changed.envelope
  const clips = loc.track.clips.map((c) => (c.id === clipId ? changed : c))
  return ok(withClips(doc, loc.trackIndex, clips as Clip[]))
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
    right = shiftDataKeys(right, -left.duration)
    // Die Einblendung bleibt am Anfang, die Ausblendung am Ende.
    if (left.kind === 'audio' || left.kind === 'video' || left.kind === 'still') delete left.fadeOut
    if (right.kind === 'audio') delete right.fadeIn
    // Der Übergang gehört zum Anfang und bleibt am ersten Teil.
    if (right.kind === 'video' || right.kind === 'still') delete right.transitionIn
    // Das Standbild folgt auf das Ende und bleibt am letzten Teil.
    if (left.kind === 'video' || left.kind === 'still') delete left.hold
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
 * Marker dahinter wandern mit, Marker im gelöschten Bereich rücken an dessen
 * Anfang.
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
  return ok(shiftMarkers(next, rangeEnd, -shift))
}

// --- Zusammengesetzte Befehle ----------------------------------------------

/**
 * Bereiche (Zeiten auf der Timeline) aus einem Clip herausschneiden und die
 * Lücken schließen: Der Clip wird an den Rändern geteilt, das Stück dazwischen
 * samt verknüpften Clips gelöscht, und alles Spätere rückt nach. Bereiche
 * außerhalb des Clips werden beschnitten, überlappende zusammengefasst und zu
 * kurze übergangen. Wie viel nachrückt, begrenzt `removeClip` (ripple).
 */
export function cutClipRanges(
  doc: TimelineDoc,
  clipId: string,
  ranges: readonly { start: Time; end: Time }[],
  opts: { ids?: () => string } = {},
): OpResult {
  const loc = findClip(doc, clipId)
  if (!loc) return fail('clip-not-found')
  if (loc.track.locked) return fail('track-locked')
  const from = loc.clip.start
  const to = clipEnd(loc.clip)
  // Beschneiden, sortieren, zusammenfassen.
  const merged: { start: Time; end: Time }[] = []
  const sorted = ranges
    .filter((r) => isTime(r.start) && isTime(r.end))
    .map((r) => ({ start: Math.max(from, r.start), end: Math.min(to, r.end) }))
    .filter((r) => r.end - r.start >= MIN_CLIP_DURATION)
    .sort((a, b) => a.start - b.start)
  for (const r of sorted) {
    const last = merged[merged.length - 1]
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end)
    else merged.push({ ...r })
  }
  // Reste, die kürzer als ein Clip sein darf, gehören mit zum Schnitt.
  for (const r of merged) {
    if (r.start - from < MIN_CLIP_DURATION) r.start = from
    if (to - r.end < MIN_CLIP_DURATION) r.end = to
  }

  let next = doc
  // Von hinten nach vorn: Der vordere Teil behält die ID des Clips.
  for (const r of merged.reverse()) {
    const current = findClip(next, clipId)
    if (!current) break
    let target = clipId
    if (r.end < clipEnd(current.clip)) {
      const split = splitClip(next, clipId, r.end, opts)
      if (!split.ok) return split
      next = split.doc
    }
    if (r.start > current.clip.start) {
      const split = splitClip(next, clipId, r.start, opts)
      if (!split.ok) return split
      next = split.doc
      const middle = next.tracks[current.trackIndex].clips.find((c) => c.start === r.start)
      if (!middle) return fail('clip-not-found')
      target = middle.id
    }
    const removed = removeClip(next, target, { ripple: true })
    if (!removed.ok) return removed
    next = removed.doc
  }
  return ok(next)
}

/** So oft legt `repeatClip` einen Clip höchstens hintereinander. */
export const MAX_CLIP_REPEATS = 200

/**
 * Bis wohin `repeatClip` einen Ton-Clip wiederholen würde: bis zum Ende der
 * übrigen Spuren, höchstens bis zum nächsten Clip derselben Spur. `null`,
 * wenn es nichts zu füllen gibt oder der Clip sich nicht eignet (kein Ton,
 * mit einem Bild verknüpft, gesperrte Spur).
 */
export function repeatLimit(doc: TimelineDoc, clipId: string): Time | null {
  const loc = findClip(doc, clipId)
  if (!loc || loc.track.locked) return null
  const clip = loc.clip
  if (clip.kind !== 'audio' || clip.linkGroup) return null
  const end = clipEnd(clip)
  let limit = 0
  doc.tracks.forEach((t, i) => {
    if (i !== loc.trackIndex) limit = Math.max(limit, trackEnd(t))
  })
  for (const c of loc.track.clips) if (c.start >= end) limit = Math.min(limit, c.start)
  return limit - end >= MIN_CLIP_DURATION ? limit : null
}

/**
 * Ton-Clip (Musik) in Schleife legen: Kopien direkt dahinter, bis das Ende der
 * übrigen Spuren erreicht ist (`repeatLimit`); die letzte Kopie wird passend
 * gekürzt. Die Ausblendung wandert ans Ende der letzten Kopie, die
 * Einblendung bleibt am ersten Clip. Lautstärke, Tempo und Ausschnitt gelten
 * für alle Kopien.
 */
export function repeatClip(
  doc: TimelineDoc,
  clipId: string,
  opts: { ids?: () => string } = {},
): OpResult {
  const loc = findClip(doc, clipId)
  if (!loc) return fail('clip-not-found')
  if (loc.track.locked) return fail('track-locked')
  const clip = loc.clip
  if (clip.kind !== 'audio' || clip.linkGroup) return fail('kind-mismatch')
  const limit = repeatLimit(doc, clipId)
  if (limit === null) return fail('too-short')
  const ids = opts.ids ?? createId
  const copies: AudioClip[] = []
  let at = clipEnd(clip)
  while (limit - at >= MIN_CLIP_DURATION && copies.length < MAX_CLIP_REPEATS) {
    const copy: AudioClip = {
      ...clip,
      id: ids(),
      start: at,
      duration: Math.min(clip.duration, limit - at),
    }
    delete copy.fadeIn
    delete copy.fadeOut
    copies.push(copy)
    at += copy.duration
  }
  if (copies.length === 0) return fail('too-short')
  const first: AudioClip = { ...clip }
  if (clip.fadeOut) {
    delete first.fadeOut
    const last = copies[copies.length - 1]
    last.fadeOut = { ...clip.fadeOut, duration: Math.min(clip.fadeOut.duration, last.duration) }
  }
  const clips = [...loc.track.clips.map((c) => (c.id === clipId ? first : c)), ...copies].sort(
    (a, b) => a.start - b.start,
  )
  return ok(withClips(doc, loc.trackIndex, clips as Clip[]))
}

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

/** Ton-Spur, auf der nur Tondateien (Musik, Sprachaufnahmen) liegen. */
export function isMusicTrack(doc: TimelineDoc, track: Track): boolean {
  return (
    track.kind === 'audio' &&
    track.clips.length > 0 &&
    track.clips.every((c) => doc.assets[c.asset]?.kind === 'audio')
  )
}

/**
 * Tondatei auf die Timeline legen: hinter die letzte Tondatei der obersten
 * freien Musik-Spur. Gibt es noch keine, entsteht unten eine neue Ton-Spur
 * und die Tondatei beginnt bei 0, läuft also unter den Videos mit.
 */
function appendAudioFile(doc: TimelineDoc, asset: AssetRef, ids: () => string): OpResult {
  const duration = asset.duration ?? 0
  let next = doc
  let track = doc.tracks.find((t) => !t.locked && isMusicTrack(doc, t))
  if (!track) {
    const id = ids()
    const added = addTrack(
      next,
      { id, kind: 'audio', name: nextTrackName(next, 'A') },
      next.tracks.length,
    )
    if (!added.ok) return added
    next = added.doc
    track = next.tracks.find((t) => t.id === id)
    if (!track) return fail('track-not-found')
  }
  return insertClip(next, track.id, {
    id: ids(),
    kind: 'audio',
    asset: asset.id,
    start: trackEnd(track),
    duration,
    sourceIn: 0,
    speed: 1,
    gain: 1,
  })
}

/**
 * Tondatei (z. B. Sprachaufnahme) an einer festen Stelle einfügen. Sie kommt
 * auf die oberste nicht gesperrte Ton-Spur, die leer ist oder nur Tondateien
 * trägt, nicht automatisch abgesenkt wird und an der Stelle frei ist; sonst
 * entsteht unten eine neue Ton-Spur. So bleibt die Aufnahme neben der Musik
 * hörbar und steuert deren Absenken.
 */
export function insertAudioAt(
  doc: TimelineDoc,
  assetId: string,
  at: Time,
  opts: { ids?: () => string } = {},
): OpResult {
  const asset = doc.assets[assetId]
  if (!asset) return fail('asset-not-found')
  if (asset.kind !== 'audio' || asset.duration === null) return fail('kind-mismatch')
  if (asset.duration < MIN_CLIP_DURATION) return fail('too-short')
  if (!isTime(at)) return fail('invalid-time')
  const ids = opts.ids ?? createId
  const end = at + asset.duration
  let next = doc
  let trackId = doc.tracks.find(
    (t) =>
      t.kind === 'audio' &&
      !t.locked &&
      t.duck === undefined &&
      (t.clips.length === 0 || isMusicTrack(doc, t)) &&
      !overlaps(t.clips, at, end),
  )?.id
  if (trackId === undefined) {
    trackId = ids()
    const added = addTrack(
      next,
      { id: trackId, kind: 'audio', name: nextTrackName(next, 'A') },
      next.tracks.length,
    )
    if (!added.ok) return added
    next = added.doc
  }
  return insertClip(next, trackId, {
    id: ids(),
    kind: 'audio',
    asset: asset.id,
    start: at,
    duration: asset.duration,
    sourceIn: 0,
    speed: 1,
    gain: 1,
  })
}

/**
 * Medium aus der Medienliste auf die Timeline legen. Video: Bild ans Ende der
 * obersten freien Video-Spur, Ton (falls vorhanden) verknüpft auf die oberste
 * freie Ton-Spur, die keine Musik-Spur ist. Fehlende oder gesperrte Spuren
 * werden neu angelegt. Liegt noch kein Bild auf der Timeline, übernimmt das
 * Projekt Größe und Bildrate des Videos. Tondatei: siehe `appendAudioFile`.
 */
export function appendMedia(
  doc: TimelineDoc,
  assetId: string,
  opts: { ids?: () => string } = {},
): OpResult {
  const asset = doc.assets[assetId]
  if (!asset) return fail('asset-not-found')
  if (asset.kind === 'image' || asset.duration === null) return fail('kind-mismatch')
  if (asset.duration < MIN_CLIP_DURATION) return fail('too-short')
  const ids = opts.ids ?? createId
  if (asset.kind === 'audio') return appendAudioFile(doc, asset, ids)
  let next = doc

  // Musik, die schon liegt, zählt nicht: Das erste Video bestimmt das Format.
  const empty = !doc.tracks.some((t) => t.kind !== 'audio' && t.clips.length > 0)
  if (empty && asset.width && asset.height) {
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
    // Musik-Spuren bleiben frei: Sonst landete das Video hinter der Musik.
    const free = next.tracks.find((t) => t.kind === kind && !t.locked && !isMusicTrack(next, t))
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

// --- Marker -----------------------------------------------------------------

export const MAX_MARKERS = 200
export const MAX_MARKER_LABEL = 60

const markerLabel = (label: string | undefined): string =>
  (label ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_MARKER_LABEL)

const sortMarkers = (markers: Marker[]): Marker[] =>
  markers.slice().sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))

/**
 * Marker setzen. Liegt an der Stelle schon einer, bleibt das Dokument, wie es
 * ist (kein zweiter Marker auf derselben Zeit).
 */
export function addMarker(
  doc: TimelineDoc,
  marker: { id?: string; at: Time; label?: string },
): OpResult {
  if (!isTime(marker.at)) return fail('invalid-time')
  if (doc.markers.some((m) => m.at === marker.at)) return ok(doc)
  if (doc.markers.length >= MAX_MARKERS) return fail('too-many')
  const id = marker.id ?? createId()
  if (hasId(doc, id)) return fail('duplicate-id')
  const markers = sortMarkers([
    ...doc.markers,
    { id, at: marker.at, label: markerLabel(marker.label) },
  ])
  return ok({ ...doc, markers })
}

/** Marker umbenennen oder verschieben; auf einen anderen Marker lässt er sich nicht legen. */
export function updateMarker(
  doc: TimelineDoc,
  markerId: string,
  patch: { at?: Time; label?: string },
): OpResult {
  const before = doc.markers.find((m) => m.id === markerId)
  if (!before) return fail('marker-not-found')
  const at = patch.at ?? before.at
  if (!isTime(at)) return fail('invalid-time')
  if (doc.markers.some((m) => m.id !== markerId && m.at === at)) return fail('overlap')
  const label = patch.label === undefined ? before.label : markerLabel(patch.label)
  if (at === before.at && label === before.label) return ok(doc)
  // Gebundene Clips (samt verknüpften) wandern um denselben Betrag mit.
  let next = doc
  if (at !== before.at) {
    const moved = shiftClips(doc, markerClipIds(doc, markerId), at - before.at)
    if (!moved.ok) return moved
    next = moved.doc
  }
  const markers = sortMarkers(
    next.markers.map((m) => (m.id === markerId ? { ...m, at, label } : m)),
  )
  return ok({ ...next, markers })
}

export const MIN_EFFECT_DURATION = 100_000
export const MAX_EFFECT_DURATION = 5_000_000
export const MIN_EFFECT_INTENSITY = 0.05
export const MIN_STROBE_RATE = 1
export const MAX_STROBE_RATE = 20

/** Vorgaben je Art, wenn ein Effekt neu gewählt wird. */
export const DEFAULT_MARKER_EFFECTS: Record<MarkerEffectKind, MarkerEffect> = {
  flash: { kind: 'flash', color: '#ffffff', intensity: 0.8, duration: 400_000, rate: 8 },
  burst: { kind: 'burst', color: '#ff4400', intensity: 0.6, duration: 600_000, rate: 8 },
  strobe: { kind: 'strobe', color: '#ffffff', intensity: 0.8, duration: 1_000_000, rate: 8 },
  vignette: { kind: 'vignette', color: '#ff0044', intensity: 0.7, duration: 800_000, rate: 8 },
}

/** Gültiger Effekt (Grenzen wie auf dem Server)? */
export function isMarkerEffect(e: unknown): e is MarkerEffect {
  if (typeof e !== 'object' || e === null) return false
  const v = e as Record<string, unknown>
  const inRange = (n: unknown, min: number, max: number) =>
    typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max
  return (
    (MARKER_EFFECTS as readonly unknown[]).includes(v.kind) &&
    typeof v.color === 'string' &&
    /^#[0-9a-f]{6}$/.test(v.color) &&
    inRange(v.intensity, MIN_EFFECT_INTENSITY, 1) &&
    isTime(v.duration) &&
    inRange(v.duration, MIN_EFFECT_DURATION, MAX_EFFECT_DURATION) &&
    inRange(v.rate, MIN_STROBE_RATE, MAX_STROBE_RATE)
  )
}

/**
 * Drop-Effekt eines Markers setzen, ändern (`patch` mischt in den bisherigen
 * bzw. die Vorgabe der Art) oder entfernen (`null`).
 */
export function setMarkerEffect(
  doc: TimelineDoc,
  markerId: string,
  patch: Partial<MarkerEffect> | null,
): OpResult {
  const marker = doc.markers.find((m) => m.id === markerId)
  if (!marker) return fail('marker-not-found')
  let effect: MarkerEffect | undefined
  if (patch !== null) {
    const kind = patch.kind ?? marker.effect?.kind ?? 'flash'
    // Andere Art: deren Vorgaben, nur ausdrücklich Übergebenes bleibt.
    const base =
      marker.effect && marker.effect.kind === kind ? marker.effect : DEFAULT_MARKER_EFFECTS[kind]
    effect = { ...base, ...patch, kind }
    if (typeof effect.color === 'string') effect.color = effect.color.toLowerCase()
    if (!isMarkerEffect(effect)) return fail('invalid-time')
  }
  if (JSON.stringify(effect) === JSON.stringify(marker.effect)) return ok(doc)
  const markers = doc.markers.map((m) => {
    if (m.id !== markerId) return m
    const next: Marker = { id: m.id, at: m.at, label: m.label }
    if (effect) next.effect = effect
    return next
  })
  return ok({ ...doc, markers })
}

/** Marker löschen; seine Clips bleiben liegen und sind danach nicht mehr gebunden. */
export function removeMarker(doc: TimelineDoc, markerId: string): OpResult {
  if (!doc.markers.some((m) => m.id === markerId)) return fail('marker-not-found')
  const unbound = setClipMarker(doc, markerClipIds(doc, markerId), undefined)
  return ok({ ...unbound, markers: unbound.markers.filter((m) => m.id !== markerId) })
}

/** IDs der an den Marker gebundenen Clips (Reihenfolge der Spuren). */
export function markerClipIds(doc: TimelineDoc, markerId: string): string[] {
  return doc.tracks
    .flatMap((t) => (t.clips as Clip[]).filter((c) => c.marker === markerId))
    .map((c) => c.id)
}

/** Bindung der Clips setzen (`undefined` = lösen); unbekannte IDs werden übergangen. */
function setClipMarker(doc: TimelineDoc, clipIds: readonly string[], markerId: string | undefined) {
  const ids = new Set(clipIds)
  let next = doc
  doc.tracks.forEach((track, i) => {
    const clips = track.clips as Clip[]
    if (!clips.some((c) => ids.has(c.id) && c.marker !== markerId)) return
    next = withClips(
      next,
      i,
      clips.map((c) => {
        if (!ids.has(c.id) || c.marker === markerId) return c
        const copy = { ...c }
        if (markerId === undefined) delete copy.marker
        else copy.marker = markerId
        return copy
      }),
    )
  })
  return next
}

/**
 * Clips (samt verknüpften) gemeinsam um `delta` verschieben, jeder auf seiner
 * Spur. Abgelehnt, wenn eine Spur gesperrt ist, ein Clip vor 0 rutschen oder
 * auf einen nicht mitbewegten Clip stoßen würde.
 */
function shiftClips(doc: TimelineDoc, clipIds: readonly string[], delta: Time): OpResult {
  if (delta === 0 || clipIds.length === 0) return ok(doc)
  const moving = new Set<string>()
  for (const id of clipIds) {
    const loc = findClip(doc, id)
    if (loc) for (const m of linkedClips(doc, loc, true)) moving.add(m.clip.id)
  }
  let next = doc
  for (let i = 0; i < doc.tracks.length; i++) {
    const track = doc.tracks[i]
    const clips = track.clips as Clip[]
    if (!clips.some((c) => moving.has(c.id))) continue
    if (track.locked) return fail('track-locked')
    const kept = clips.filter((c) => !moving.has(c.id))
    const lane = [...kept]
    for (const c of clips) {
      if (!moving.has(c.id)) continue
      const start = c.start + delta
      if (!isTime(start)) return fail('invalid-time')
      if (overlaps(kept, start, start + c.duration)) return fail('overlap')
      lane.push({ ...c, start })
    }
    next = withClips(next, i, lane)
  }
  return ok(next)
}

/**
 * Clips an einen Marker binden. Die Clips rücken als Gruppe so, dass der
 * früheste genau am Marker beginnt (Abstände untereinander bleiben); danach
 * wandern sie mit dem Marker.
 */
export function bindClipsToMarker(
  doc: TimelineDoc,
  markerId: string,
  clipIds: readonly string[],
): OpResult {
  const marker = doc.markers.find((m) => m.id === markerId)
  if (!marker) return fail('marker-not-found')
  const locs = clipIds.map((id) => findClip(doc, id))
  if (locs.length === 0) return ok(doc)
  if (locs.some((l) => l === null)) return fail('clip-not-found')
  const first = Math.min(...locs.map((l) => (l as ClipLocation).clip.start))
  const moved = shiftClips(doc, clipIds, marker.at - first)
  if (!moved.ok) return moved
  return ok(setClipMarker(moved.doc, clipIds, markerId))
}

/** Bindung eines Clips an seinen Marker lösen (der Clip bleibt, wo er ist). */
export function unbindClip(doc: TimelineDoc, clipId: string): OpResult {
  const loc = findClip(doc, clipId)
  if (!loc) return fail('clip-not-found')
  if (loc.clip.marker === undefined) return ok(doc)
  return ok(setClipMarker(doc, [clipId], undefined))
}

// --- Zeitlich verschieben (Knopfleiste) ---------------------------------------

/** Wohin markierte Clips rücken: um einen Betrag, mit dem Anfang oder dem Ende an eine Zeit. */
export type NudgeTarget = { by: Time } | { startAt: Time } | { endAt: Time }

/** Was beim Verschieben mitwandert, mit gemeinsamem Anfang und Ende. */
export interface NudgeSpan {
  ids: string[]
  start: Time
  end: Time
}

/**
 * Clips, die beim Verschieben von `clipIds` gemeinsam wandern: die Clips
 * selbst samt verknüpften (Bild und Ton), mit `wholeTracks` zusätzlich alle
 * Clips ihrer Spuren. `null`, wenn keiner der Clips existiert.
 */
export function nudgeSpan(
  doc: TimelineDoc,
  clipIds: readonly string[],
  opts: { wholeTracks?: boolean } = {},
): NudgeSpan | null {
  const seeds = clipIds.flatMap((id) => {
    const loc = findClip(doc, id)
    return loc ? [loc] : []
  })
  if (seeds.length === 0) return null
  const roots = opts.wholeTracks
    ? [...new Set(seeds.map((l) => l.trackIndex))].flatMap((i) =>
        doc.tracks[i].clips.map((clip) => findClip(doc, clip.id) as ClipLocation),
      )
    : seeds
  const moving = new Map<string, Clip>()
  for (const loc of roots)
    for (const m of linkedClips(doc, loc, true)) moving.set(m.clip.id, m.clip)
  const clips = [...moving.values()]
  return {
    ids: clips.map((c) => c.id),
    start: Math.min(...clips.map((c) => c.start)),
    end: Math.max(...clips.map(clipEnd)),
  }
}

/**
 * Markierte Clips gemeinsam zeitlich verschieben (Abstände bleiben). `by`
 * wird an 0 begrenzt: Wer schon am Anfang liegt, bleibt dort. Bei `startAt`
 * und `endAt` wird abgelehnt (`invalid-time`), wenn ein Clip vor 0 beginnen
 * müsste. Stößt ein Clip auf einen nicht mitbewegten, bleibt alles, wie es ist
 * (`overlap`). Keyframes und Lautstärke-Kurven hängen am Clip und wandern mit;
 * Marker-Bindungen bleiben bestehen (wie beim Ziehen).
 */
export function nudgeClips(
  doc: TimelineDoc,
  clipIds: readonly string[],
  target: NudgeTarget,
  opts: { wholeTracks?: boolean } = {},
): OpResult {
  const span = nudgeSpan(doc, clipIds, opts)
  if (!span) return fail('clip-not-found')
  let delta: number
  if ('by' in target) {
    if (!Number.isFinite(target.by)) return fail('invalid-time')
    delta = Math.max(-span.start, Math.round(target.by))
  } else {
    const at = 'startAt' in target ? target.startAt : target.endAt
    if (!isTime(at)) return fail('invalid-time')
    delta = at - ('startAt' in target ? span.start : span.end)
    if (span.start + delta < 0) return fail('invalid-time')
  }
  return shiftClips(doc, span.ids, delta)
}

// --- Einrasten --------------------------------------------------------------

/** Mögliche Einrastpunkte: 0, Clip-Ränder, Marker und (optional) der Abspielkopf. */
export function snapPoints(
  doc: TimelineDoc,
  opts: { exclude?: readonly string[]; playhead?: Time } = {},
): Time[] {
  // `exclude` nimmt Clips und Marker aus (der gezogene Marker rastet nicht an sich selbst ein).
  const exclude = new Set(opts.exclude ?? [])
  const points = new Set<Time>([0])
  for (const t of doc.tracks)
    for (const c of t.clips) {
      if (exclude.has(c.id)) continue
      points.add(c.start)
      points.add(clipEnd(c))
    }
  for (const m of doc.markers) if (!exclude.has(m.id)) points.add(m.at)
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
