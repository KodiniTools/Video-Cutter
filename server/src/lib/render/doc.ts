/**
 * Timeline-Dokument (Version 2) auf dem Server: Typen und strenge Prüfung.
 *
 * Die Typen spiegeln `src/timeline/model/types.ts` des Frontends (der Server
 * baut getrennt und kann sie nicht importieren). Alles, was vom Client kommt,
 * läuft zuerst durch `parseTimelineDoc`; der Compiler vertraut dem Ergebnis.
 */

import { AUDIO_FADE_CURVES, type AudioFadeCurve } from '../args'
import {
  GRAPHIC_ANIMATIONS,
  GRAPHIC_LOOPS,
  type GraphicAnimation,
  type GraphicLoop,
} from '../graphicOverlay'
import {
  MIN_TEXT_DURATION,
  parseAnimSpeed,
  parseTextOverlays,
  type TextOverlay,
} from '../textOverlay'

/** Zeit bzw. Dauer in ganzen Mikrosekunden. */
export type Time = number

export const TIMELINE_DOC_VERSION = 2
export const MICROS_PER_SECOND = 1_000_000
/** Kürzeste erlaubte Clip-Länge (wie im Frontend). */
export const MIN_CLIP_DURATION: Time = 50_000
export const MIN_SPEED = 0.25
export const MAX_SPEED = 4
/** Höchste Verstärkung für Clip-Lautstärke und Spur-Lautstärke. */
export const MAX_GAIN = 4

export type AssetKind = 'video' | 'audio' | 'image'

export interface DocAsset {
  id: string
  kind: AssetKind
  /** Länge der Quelle; `null` bei Bildern. */
  duration: Time | null
}

export interface DocSettings {
  width: number
  height: number
  fps: number
  /** Farbe hinter allen Spuren, `#rrggbb`. */
  background: string
  sampleRate: number
}

export interface DocCrop {
  x: number
  y: number
  width: number
  height: number
}

interface DocClipBase {
  id: string
  start: Time
  duration: Time
}

/** Übergänge vom vorigen Clip (wie im bisherigen Editor, ohne „kein“). */
export const CLIP_TRANSITIONS = ['fade', 'slide', 'scale', 'flip'] as const
export type ClipTransitionPreset = (typeof CLIP_TRANSITIONS)[number]
export const MIN_TRANSITION: Time = 100_000
export const MAX_TRANSITION: Time = 10 * MICROS_PER_SECOND

/**
 * Übergang am Anfang eines Clips. `duration` ist die Gesamtdauer; die Hälfte
 * davon liegt am Anfang dieses Clips (bei `fade` die andere Hälfte am Ende des
 * vorigen).
 */
export interface DocTransition {
  preset: ClipTransitionPreset
  duration: Time
}

export interface DocColor {
  brightness: number
  contrast: number
  saturation: number
}

export interface DocLayout {
  x: number
  y: number
  scale: number
  opacity: number
}

/** Kleinste Größe eines Clips im Bild (wie im Editor). */
export const MIN_LAYOUT_SCALE = 0.05

export interface DocVideoClip extends DocClipBase {
  kind: 'video' | 'still'
  asset: string
  sourceIn: Time
  speed: number
  crop: DocCrop | null
  /** Lage im Bild (Bild-in-Bild): Mitte, Größe (Anteil des Projektformats), Deckkraft. */
  layout?: DocLayout
  /** Farbkorrektur: Helligkeit, Kontrast, Sättigung, je −1 … 1 (0 = unverändert). */
  color?: DocColor
  transitionIn?: DocTransition | null
  /** Letztes Bild halten, bis der nächste Clip der Spur beginnt. */
  hold?: boolean
}

export interface DocAudioClip extends DocClipBase {
  kind: 'audio'
  asset: string
  sourceIn: Time
  speed: number
  gain: number
  /** Ton am Clip-Anfang ein- bzw. am Clip-Ende ausblenden (`null` = aus). */
  fadeIn: DocFade | null
  fadeOut: DocFade | null
}

/** Blende eines Ton-Clips: Dauer auf der Timeline und Kurvenform (`afade`). */
export interface DocFade {
  duration: Time
  curve: AudioFadeCurve
}

/** Darstellung eines Textes (ohne Zeiten – die kommen vom Clip). */
export type DocTextStyle = Omit<TextOverlay, 'start' | 'end'>

/**
 * Grafik (Form, Symbol, Emoji): Der Browser zeichnet sie als PNG und lädt es
 * hoch; das Dokument nennt nur die ID des Bildes, Lage und Animation.
 */
export interface DocGraphic {
  /** ID des hochgeladenen PNGs (Hash des Inhalts). */
  png: string
  /** Projekthöhe, für die das PNG gezeichnet wurde (Maßstab). */
  refHeight: number
  /** Mittelpunkt als Anteil der Bildbreite/-höhe. */
  x: number
  y: number
  animation: GraphicAnimation
  loop: GraphicLoop
  animSpeed: number
}

/**
 * Text/Grafik/Bild über dem Video. Texte (`text`) und Grafiken (`graphic`)
 * werden gerendert, sobald ihr Inhalt da ist; Bilder werden geprüft, aber
 * erst später gerendert.
 */
export interface DocOverlayClip extends DocClipBase {
  kind: 'text' | 'graphic' | 'image'
  text?: DocTextStyle
  graphic?: DocGraphic
}

export interface DocVideoTrack {
  id: string
  kind: 'video'
  hidden: boolean
  clips: DocVideoClip[]
}

export interface DocAudioTrack {
  id: string
  kind: 'audio'
  muted: boolean
  solo: boolean
  volume: number
  clips: DocAudioClip[]
}

export interface DocOverlayTrack {
  id: string
  kind: 'overlay'
  hidden: boolean
  clips: DocOverlayClip[]
}

export type DocTrack = DocVideoTrack | DocAudioTrack | DocOverlayTrack

export interface RenderDoc {
  version: typeof TIMELINE_DOC_VERSION
  settings: DocSettings
  assets: Record<string, DocAsset>
  /** Reihenfolge = Stapel: Index 0 liegt oben (vorne). */
  tracks: DocTrack[]
}

/** Grenzen gegen übergroße Dokumente (schützen CPU und FFmpeg-Graph). */
export interface DocLimits {
  maxTracks: number
  maxClips: number
  maxDuration: Time
  maxSide: number
}

export const DEFAULT_DOC_LIMITS: DocLimits = {
  maxTracks: 16,
  maxClips: 500,
  maxDuration: 4 * 60 * 60 * MICROS_PER_SECOND,
  maxSide: 3840,
}

export interface DocError {
  /** Stelle im Dokument, z. B. `tracks[0].clips[2].speed`. */
  path: string
  message: string
}

export type ParseResult = { ok: true; doc: RenderDoc } | { ok: false; errors: DocError[] }

/** Mehr Fehler werden nicht gesammelt (ein kaputtes Dokument hat schnell Hunderte). */
const MAX_ERRORS = 20
const ID_MAX = 64
const SAMPLE_RATES = [44100, 48000]
const GRAPHIC_ID_RE = /^[0-9a-f]{32}$/

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isTime(v: unknown): v is Time {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
}

function isId(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= ID_MAX
}

function inRange(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max
}

export function clipEnd(clip: { start: Time; duration: Time }): Time {
  return clip.start + clip.duration
}

/** Ende des letzten Clips (alle Spuren). */
export function docDuration(doc: RenderDoc): Time {
  let end = 0
  for (const t of doc.tracks) for (const c of t.clips) end = Math.max(end, clipEnd(c))
  return end
}

/**
 * Prüft ein vom Client geschicktes Dokument und liefert eine bereinigte Kopie
 * (nur bekannte Felder). Unbekannte Felder werden ignoriert, alles Benötigte
 * muss stimmen – sonst gibt es Fehler mit Pfad.
 */
export function parseTimelineDoc(
  input: unknown,
  limits: DocLimits = DEFAULT_DOC_LIMITS,
): ParseResult {
  const errors: DocError[] = []
  const fail = (path: string, message: string): void => {
    if (errors.length < MAX_ERRORS) errors.push({ path, message })
  }
  const done = (): ParseResult => ({ ok: false, errors })

  if (!isObject(input)) {
    fail('', 'Das Dokument muss ein Objekt sein.')
    return done()
  }
  if (input.version !== TIMELINE_DOC_VERSION)
    fail('version', `Nur Version ${TIMELINE_DOC_VERSION} wird unterstützt.`)

  // --- Einstellungen -----------------------------------------------------
  const s = input.settings
  let settings: DocSettings | null = null
  if (!isObject(s)) fail('settings', 'Einstellungen fehlen.')
  else {
    const side = (v: unknown): v is number =>
      typeof v === 'number' && Number.isInteger(v) && v >= 16 && v <= limits.maxSide && v % 2 === 0
    if (!side(s.width))
      fail(
        'settings.width',
        `Breite muss gerade sein und zwischen 16 und ${limits.maxSide} liegen.`,
      )
    if (!side(s.height))
      fail('settings.height', `Höhe muss gerade sein und zwischen 16 und ${limits.maxSide} liegen.`)
    if (!inRange(s.fps, 1, 60)) fail('settings.fps', 'Bildrate muss zwischen 1 und 60 liegen.')
    if (typeof s.background !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(s.background))
      fail('settings.background', 'Hintergrund muss eine Farbe wie #000000 sein.')
    if (!SAMPLE_RATES.includes(s.sampleRate as number))
      fail('settings.sampleRate', `Abtastrate muss ${SAMPLE_RATES.join(' oder ')} sein.`)
    if (errors.length === 0)
      settings = {
        width: s.width as number,
        height: s.height as number,
        fps: s.fps as number,
        background: (s.background as string).toLowerCase(),
        sampleRate: s.sampleRate as number,
      }
  }

  // --- Medien ------------------------------------------------------------
  const assets: Record<string, DocAsset> = {}
  if (!isObject(input.assets)) fail('assets', 'Medienliste fehlt.')
  else
    for (const [key, raw] of Object.entries(input.assets)) {
      const path = `assets.${key}`
      if (!isObject(raw) || !isId(raw.id) || raw.id !== key) {
        fail(path, 'Ungültiger Medien-Eintrag.')
        continue
      }
      if (raw.kind !== 'video' && raw.kind !== 'audio' && raw.kind !== 'image') {
        fail(`${path}.kind`, 'Unbekannte Medien-Art.')
        continue
      }
      const duration = raw.duration ?? null
      if (raw.kind === 'image' ? duration !== null && !isTime(duration) : !isTime(duration)) {
        fail(`${path}.duration`, 'Ungültige Länge.')
        continue
      }
      assets[key] = { id: key, kind: raw.kind, duration: duration as Time | null }
    }

  // --- Spuren und Clips ----------------------------------------------------
  const tracks: DocTrack[] = []
  const ids = new Set<string>()
  let clipCount = 0
  const uniqueId = (v: unknown, path: string): v is string => {
    if (!isId(v)) {
      fail(path, 'Ungültige ID.')
      return false
    }
    if (ids.has(v)) {
      fail(path, 'ID kommt mehrfach vor.')
      return false
    }
    ids.add(v)
    return true
  }

  if (!Array.isArray(input.tracks)) fail('tracks', 'Spuren fehlen.')
  else if (input.tracks.length > limits.maxTracks)
    fail('tracks', `Höchstens ${limits.maxTracks} Spuren.`)
  else
    input.tracks.forEach((raw: unknown, ti: number) => {
      const tp = `tracks[${ti}]`
      if (!isObject(raw)) return fail(tp, 'Ungültige Spur.')
      if (!uniqueId(raw.id, `${tp}.id`)) return
      const kind = raw.kind
      if (kind !== 'video' && kind !== 'audio' && kind !== 'overlay')
        return fail(`${tp}.kind`, 'Unbekannte Spur-Art.')
      if (!Array.isArray(raw.clips)) return fail(`${tp}.clips`, 'Clips fehlen.')
      if (kind === 'audio' && !inRange(raw.volume, 0, MAX_GAIN))
        return fail(`${tp}.volume`, `Lautstärke muss zwischen 0 und ${MAX_GAIN} liegen.`)

      const clips: Array<DocVideoClip | DocAudioClip | DocOverlayClip> = []
      raw.clips.forEach((rc: unknown, ci: number) => {
        const cp = `${tp}.clips[${ci}]`
        clipCount++
        if (clipCount > limits.maxClips) {
          if (clipCount === limits.maxClips + 1)
            fail('tracks', `Höchstens ${limits.maxClips} Clips.`)
          return
        }
        if (!isObject(rc)) return fail(cp, 'Ungültiger Clip.')
        if (!uniqueId(rc.id, `${cp}.id`)) return
        if (!isTime(rc.start)) return fail(`${cp}.start`, 'Ungültiger Beginn.')
        if (!isTime(rc.duration) || rc.duration < MIN_CLIP_DURATION)
          return fail(`${cp}.duration`, 'Clip ist zu kurz oder die Länge ungültig.')
        if (rc.start + rc.duration > limits.maxDuration)
          return fail(cp, 'Die Timeline ist zu lang.')
        const base = { id: rc.id, start: rc.start, duration: rc.duration }
        const ck = rc.kind

        if (kind === 'overlay') {
          if (ck !== 'text' && ck !== 'graphic' && ck !== 'image')
            return fail(`${cp}.kind`, 'Clip passt nicht zur Spur-Art.')
          const data = isObject(rc.data) ? rc.data : {}
          if (ck === 'graphic') {
            // Noch nicht hochgeladen (wird gerade gezeichnet): gültig, aber nichts zu zeigen.
            if (data.png === undefined || data.png === null || data.png === '') {
              clips.push({ ...base, kind: ck })
              return
            }
            const gp = `${cp}.data`
            if (typeof data.png !== 'string' || !GRAPHIC_ID_RE.test(data.png))
              return fail(`${gp}.png`, 'Ungültige Grafik.')
            const ref = data.renderHeight
            if (
              typeof ref !== 'number' ||
              !Number.isInteger(ref) ||
              ref < 16 ||
              ref > limits.maxSide
            )
              return fail(`${gp}.renderHeight`, 'Ungültiger Maßstab der Grafik.')
            if (!inRange(data.x, 0, 1) || !inRange(data.y, 0, 1))
              return fail(gp, 'Ungültige Position der Grafik.')
            const animation = data.animation ?? 'none'
            if (!(GRAPHIC_ANIMATIONS as readonly unknown[]).includes(animation))
              return fail(`${gp}.animation`, 'Ungültige Animation der Grafik.')
            const loop = data.loop ?? 'none'
            if (!(GRAPHIC_LOOPS as readonly unknown[]).includes(loop))
              return fail(`${gp}.loop`, 'Ungültige Dauer-Animation der Grafik.')
            let animSpeed = 1
            try {
              animSpeed = parseAnimSpeed(data.animSpeed, 'Tempo der Grafik')
            } catch (e) {
              return fail(`${gp}.animSpeed`, e instanceof Error ? e.message : 'Ungültiges Tempo.')
            }
            clips.push({
              ...base,
              kind: ck,
              graphic: {
                png: data.png,
                refHeight: ref,
                x: data.x,
                y: data.y,
                animation: animation as GraphicAnimation,
                loop: loop as GraphicLoop,
                animSpeed,
              },
            })
            return
          }
          if (ck !== 'text') {
            clips.push({ ...base, kind: ck })
            return
          }
          // Noch leerer Text (wird gerade getippt): gültig, aber nichts zu zeigen.
          if (typeof data.text !== 'string' || !data.text.trim()) {
            clips.push({ ...base, kind: ck })
            return
          }
          // Sonst gleiche Regeln wie beim Einbrennen im bisherigen Editor.
          try {
            const seconds = Math.max(MIN_TEXT_DURATION, rc.duration / MICROS_PER_SECOND)
            const [parsed] = parseTextOverlays([{ ...data, start: 0, end: seconds }], Infinity)
            const text: Partial<TextOverlay> = { ...parsed }
            delete text.start
            delete text.end
            clips.push({ ...base, kind: ck, text: text as DocTextStyle })
          } catch (e) {
            fail(`${cp}.data`, e instanceof Error ? e.message : 'Text ist ungültig.')
          }
          return
        }
        const fits = kind === 'video' ? ck === 'video' || ck === 'still' : ck === 'audio'
        if (!fits) return fail(`${cp}.kind`, 'Clip passt nicht zur Spur-Art.')

        const asset = typeof rc.asset === 'string' ? assets[rc.asset] : undefined
        if (!asset) return fail(`${cp}.asset`, 'Medium ist im Dokument nicht bekannt.')
        // Standbild braucht ein Bild, Video ein Video; Ton kommt aus Video oder Audio.
        const matches =
          ck === 'still'
            ? asset.kind === 'image'
            : ck === 'video'
              ? asset.kind === 'video'
              : asset.kind !== 'image'
        if (!matches) return fail(`${cp}.asset`, 'Medium passt nicht zum Clip.')
        if (!isTime(rc.sourceIn)) return fail(`${cp}.sourceIn`, 'Ungültiger Quell-Beginn.')
        if (!inRange(rc.speed, MIN_SPEED, MAX_SPEED))
          return fail(`${cp}.speed`, `Tempo muss zwischen ${MIN_SPEED} und ${MAX_SPEED} liegen.`)
        if (
          asset.duration !== null &&
          rc.sourceIn + Math.round(rc.duration * rc.speed) > asset.duration
        )
          return fail(cp, 'Der Clip reicht über das Ende der Quelle hinaus.')

        if (ck === 'audio') {
          if (!inRange(rc.gain, 0, MAX_GAIN))
            return fail(`${cp}.gain`, `Lautstärke muss zwischen 0 und ${MAX_GAIN} liegen.`)
          const fades: (DocFade | null)[] = []
          for (const key of ['fadeIn', 'fadeOut'] as const) {
            const f = rc[key]
            if (f === undefined || f === null) {
              fades.push(null)
              continue
            }
            if (
              !isObject(f) ||
              !isTime(f.duration) ||
              typeof f.curve !== 'string' ||
              !(AUDIO_FADE_CURVES as readonly string[]).includes(f.curve)
            )
              return fail(`${cp}.${key}`, 'Ungültige Ton-Blende.')
            fades.push(
              f.duration > 0 ? { duration: f.duration, curve: f.curve as AudioFadeCurve } : null,
            )
          }
          clips.push({
            ...base,
            kind: 'audio',
            asset: asset.id,
            sourceIn: rc.sourceIn,
            speed: rc.speed,
            gain: rc.gain,
            fadeIn: fades[0],
            fadeOut: fades[1],
          })
          return
        }
        let crop: DocCrop | null = null
        if (rc.crop !== undefined && rc.crop !== null) {
          const c = rc.crop
          const okCrop =
            isObject(c) &&
            inRange(c.x, 0, 1) &&
            inRange(c.y, 0, 1) &&
            inRange(c.width, 0.01, 1) &&
            inRange(c.height, 0.01, 1) &&
            c.x + c.width <= 1 + 1e-9 &&
            c.y + c.height <= 1 + 1e-9
          if (!okCrop) return fail(`${cp}.crop`, 'Ungültiger Zuschnitt.')
          const r = c as unknown as DocCrop
          crop = { x: r.x, y: r.y, width: r.width, height: r.height }
        }
        let color: DocColor | null = null
        if (rc.color !== undefined && rc.color !== null) {
          const c = rc.color
          if (
            !isObject(c) ||
            !inRange(c.brightness, -1, 1) ||
            !inRange(c.contrast, -1, 1) ||
            !inRange(c.saturation, -1, 1)
          )
            return fail(`${cp}.color`, 'Ungültige Farbkorrektur.')
          // Alles auf 0 ist dasselbe wie keine Korrektur.
          if (c.brightness !== 0 || c.contrast !== 0 || c.saturation !== 0)
            color = { brightness: c.brightness, contrast: c.contrast, saturation: c.saturation }
        }
        let layout: DocLayout | null = null
        if (rc.layout !== undefined && rc.layout !== null) {
          const l = rc.layout
          if (
            !isObject(l) ||
            !inRange(l.x, 0, 1) ||
            !inRange(l.y, 0, 1) ||
            !inRange(l.scale, MIN_LAYOUT_SCALE, 1) ||
            !inRange(l.opacity, 0, 1)
          )
            return fail(`${cp}.layout`, 'Ungültige Lage im Bild.')
          // Volle Größe und Deckkraft ist dasselbe wie keine Lage.
          if (l.scale < 1 || l.opacity < 1)
            layout = { x: l.x, y: l.y, scale: l.scale, opacity: l.opacity }
        }
        if (rc.hold !== undefined && typeof rc.hold !== 'boolean')
          return fail(`${cp}.hold`, 'Ungültige Angabe zum Standbild.')
        let transitionIn: DocTransition | null = null
        if (rc.transitionIn !== undefined && rc.transitionIn !== null) {
          const t = rc.transitionIn
          if (
            !isObject(t) ||
            typeof t.preset !== 'string' ||
            !(CLIP_TRANSITIONS as readonly string[]).includes(t.preset) ||
            !isTime(t.duration) ||
            !inRange(t.duration, MIN_TRANSITION, MAX_TRANSITION)
          )
            return fail(`${cp}.transitionIn`, 'Ungültiger Übergang.')
          transitionIn = { preset: t.preset as ClipTransitionPreset, duration: t.duration }
        }
        clips.push({
          ...base,
          kind: ck as 'video' | 'still',
          asset: asset.id,
          sourceIn: rc.sourceIn,
          speed: rc.speed,
          crop,
          ...(layout ? { layout } : {}),
          ...(color ? { color } : {}),
          ...(transitionIn ? { transitionIn } : {}),
          ...(rc.hold === true ? { hold: true } : {}),
        })
      })

      clips.sort((a, b) => a.start - b.start)
      for (let i = 1; i < clips.length; i++)
        if (clips[i].start < clipEnd(clips[i - 1])) {
          fail(`${tp}.clips`, 'Clips einer Spur dürfen sich nicht überlappen.')
          break
        }

      if (kind === 'video')
        tracks.push({
          id: raw.id as string,
          kind,
          hidden: raw.hidden === true,
          clips: clips as DocVideoClip[],
        })
      else if (kind === 'audio')
        tracks.push({
          id: raw.id as string,
          kind,
          muted: raw.muted === true,
          solo: raw.solo === true,
          volume: raw.volume as number,
          clips: clips as DocAudioClip[],
        })
      else
        tracks.push({
          id: raw.id as string,
          kind,
          hidden: raw.hidden === true,
          clips: clips as DocOverlayClip[],
        })
    })

  if (errors.length > 0 || settings === null) return done()
  return { ok: true, doc: { version: TIMELINE_DOC_VERSION, settings, assets, tracks } }
}
