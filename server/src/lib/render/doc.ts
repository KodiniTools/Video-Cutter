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
  parseAnimOut,
  parseAnimSpeed,
  parseTextOverlays,
  type OutAnimation,
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
  /** Gesamtlautstärke nach dem Mischen, Faktor 0 … 2 (fehlt im Dokument = 1). */
  volume: number
}

/** Größte Gesamtlautstärke (Faktor), wie im Editor. */
export const MAX_MASTER_VOLUME = 2

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
  /**
   * Keyframes (mindestens zwei, nach Zeit aufsteigend): Mitte, Größe und
   * Deckkraft ändern sich dazwischen gleichmäßig, davor und dahinter gilt der
   * erste bzw. letzte. Die Werte oben sind dann die des ersten Keyframes.
   */
  keys?: DocLayoutKey[]
  /** `smooth`: Zwischen den Keyframes sanft anlaufen und abbremsen statt gleichmäßig. */
  ease?: 'smooth'
}

/** Keyframe der Lage: `at` ist die Zeit in der Quelle. */
export interface DocLayoutKey {
  at: Time
  x: number
  y: number
  scale: number
  /** Deckkraft; fehlt sie im Dokument, gilt die des Clips. */
  opacity: number
}

export const MAX_LAYOUT_KEYS = 32

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
  /** Bild am Clip-Ende ausblenden (Dauer auf der Timeline). */
  fadeOut?: { duration: Time }
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
  /**
   * Lautstärke-Kurve (`null` = keine): Punkte nach Quellzeit aufsteigend,
   * dazwischen linear, außen gilt der erste bzw. letzte Wert.
   */
  envelope: DocVolumePoint[] | null
}

/** Punkt einer Lautstärke-Kurve: Zeit in der Quelle und Faktor. */
export interface DocVolumePoint {
  at: Time
  gain: number
}

export const MAX_ENVELOPE_POINTS = 32
/** Höchster Faktor eines Kurvenpunkts. */
export const MAX_ENVELOPE_GAIN = 2

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
  /** Eigene Animation zum Ausblenden (fehlt = wie bisher über `animation`). */
  animOut?: OutAnimation
  animOutSpeed?: number
  /** Eigenes Tempo der Dauer-Animation; fehlt es, gilt `animSpeed`. */
  loopSpeed?: number
  /** Keyframes (nach Zeit sortiert): Mitte und Größe ändern sich über die Zeit. */
  keys?: DocGraphicKey[]
  /** Weiche Bewegung zwischen den Keyframes. */
  ease?: 'smooth'
}

/** Keyframe einer Grafik; `at` zählt ab Clip-Anfang (µs, auch davor/dahinter). */
export interface DocGraphicKey {
  at: number
  x: number
  y: number
  /** Größe als Faktor der gezeichneten Grafik. */
  scale: number
}

export const MAX_GRAPHIC_KEYS = 32
export const MIN_GRAPHIC_KEY_SCALE = 0.1
export const MAX_GRAPHIC_KEY_SCALE = 3

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
  /**
   * Automatisches Absenken (0 < duck ≤ 1): Anteil, um den die Spur leiser wird,
   * solange auf den übrigen Ton-Spuren etwas zu hören ist.
   */
  duck?: number
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
  /** Marker nach Zeit aufsteigend; der Export schreibt sie als Kapitel. */
  markers: DocMarker[]
  /** Drop-Effekte an Markern (nach Zeit aufsteigend); fehlt = keine. */
  effects?: DocMarkerEffect[]
}

/** Drop-Effekte am Marker (nach Muster des Beat-Drops im Visualizer). */
export const MARKER_EFFECTS = ['flash', 'burst', 'strobe', 'vignette'] as const
export type MarkerEffectKind = (typeof MARKER_EFFECTS)[number]
export const MIN_EFFECT_DURATION = 100_000
export const MAX_EFFECT_DURATION = 5_000_000
export const MIN_EFFECT_INTENSITY = 0.05
export const MIN_STROBE_RATE = 1
export const MAX_STROBE_RATE = 20

/** Effekt ab `at` für `duration`: Farbe, Stärke 0,05–1, beim Stroboskop Blitze je Sekunde. */
export interface DocMarkerEffect {
  at: Time
  kind: MarkerEffectKind
  color: string
  intensity: number
  duration: Time
  rate: number
}

/** Marker der Timeline: Zeit und Name (kann leer sein). */
export interface DocMarker {
  at: Time
  label: string
}

export const MAX_MARKERS = 200
export const MAX_MARKER_LABEL = 60

/**
 * Liest die Marker (für Kapitel) nachsichtig: Sie beeinflussen das Bild
 * nicht, darum fällt Ungültiges still weg, statt das ganze Dokument
 * abzulehnen. Takt-Marker (`beat: true`) zählen nicht als Kapitel.
 */
export function parseMarkers(raw: unknown): DocMarker[] {
  if (!Array.isArray(raw)) return []
  const byTime = new Map<Time, string>()
  for (const m of raw as unknown[]) {
    if (!isObject(m) || !isTime(m.at) || byTime.has(m.at)) continue
    // Takt-Marker (vom Takt der Musik gesetzt) sind keine Kapitel.
    if (m.beat === true) continue
    const label = typeof m.label === 'string' ? m.label : ''
    // Steuerzeichen und Zeilenumbrüche haben in einem Kapitelnamen nichts verloren.
    const clean = label
      .replace(/\p{Cc}+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    byTime.set(m.at, clean.slice(0, MAX_MARKER_LABEL))
    if (byTime.size >= MAX_MARKERS) break
  }
  return [...byTime.entries()].sort((a, b) => a[0] - b[0]).map(([at, label]) => ({ at, label }))
}

/**
 * Liest die Drop-Effekte der Marker nachsichtig (wie die Marker selbst):
 * Ungültige fallen still weg; je Zeit zählt der erste.
 */
export function parseMarkerEffects(raw: unknown): DocMarkerEffect[] {
  if (!Array.isArray(raw)) return []
  const byTime = new Map<Time, DocMarkerEffect>()
  for (const m of raw as unknown[]) {
    if (!isObject(m) || !isTime(m.at) || byTime.has(m.at) || !isObject(m.effect)) continue
    const e = m.effect
    if (!(MARKER_EFFECTS as readonly unknown[]).includes(e.kind)) continue
    if (typeof e.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(e.color)) continue
    if (!inRange(e.intensity, MIN_EFFECT_INTENSITY, 1)) continue
    if (!isTime(e.duration) || e.duration < MIN_EFFECT_DURATION || e.duration > MAX_EFFECT_DURATION)
      continue
    const rate = e.rate === undefined ? 8 : e.rate
    if (!inRange(rate, MIN_STROBE_RATE, MAX_STROBE_RATE)) continue
    byTime.set(m.at, {
      at: m.at,
      kind: e.kind as MarkerEffectKind,
      color: e.color.toLowerCase(),
      intensity: e.intensity,
      duration: e.duration,
      rate,
    })
    if (byTime.size >= MAX_MARKERS) break
  }
  return [...byTime.values()].sort((a, b) => a.at - b.at)
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

/**
 * Keyframes eines Ebenen-Clips (Grafik oder Text) prüfen: höchstens 32, nach
 * Zeit aufsteigend, Werte in Grenzen. Fehlen sie, ist die Liste leer;
 * `null` = ungültig.
 */
function parseOverlayKeys(raw: unknown): DocGraphicKey[] | null {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw) || raw.length > MAX_GRAPHIC_KEYS) return null
  const keys: DocGraphicKey[] = []
  for (const rk of raw as unknown[]) {
    const prev = keys[keys.length - 1]
    if (
      !isObject(rk) ||
      !Number.isSafeInteger(rk.at) ||
      (prev !== undefined && (rk.at as number) <= prev.at) ||
      !inRange(rk.x, 0, 1) ||
      !inRange(rk.y, 0, 1) ||
      !inRange(rk.scale, MIN_GRAPHIC_KEY_SCALE, MAX_GRAPHIC_KEY_SCALE)
    )
      return null
    keys.push({ at: rk.at as number, x: rk.x, y: rk.y, scale: rk.scale })
  }
  return keys
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
    if (s.volume !== undefined && !inRange(s.volume, 0, MAX_MASTER_VOLUME))
      fail('settings.volume', `Gesamtlautstärke muss zwischen 0 und ${MAX_MASTER_VOLUME} liegen.`)
    if (errors.length === 0)
      settings = {
        width: s.width as number,
        height: s.height as number,
        fps: s.fps as number,
        background: (s.background as string).toLowerCase(),
        sampleRate: s.sampleRate as number,
        volume: s.volume === undefined ? 1 : (s.volume as number),
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
      if (kind === 'audio' && raw.duck !== undefined && !inRange(raw.duck, 0, 1))
        return fail(`${tp}.duck`, 'Absenken muss zwischen 0 und 1 liegen.')

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
            let animOut: OutAnimation | undefined
            let animOutSpeed = 1
            try {
              animOut = parseAnimOut(data.animOut, 'Ausblenden der Grafik')
              animOutSpeed = parseAnimSpeed(data.animOutSpeed, 'Tempo des Ausblendens')
            } catch (e) {
              return fail(
                `${gp}.animOut`,
                e instanceof Error ? e.message : 'Ungültiges Ausblenden.',
              )
            }
            let loopSpeed: number | undefined
            if (data.loopSpeed !== undefined && data.loopSpeed !== null) {
              try {
                loopSpeed = parseAnimSpeed(data.loopSpeed, 'Tempo der Dauer-Animation')
              } catch (e) {
                return fail(`${gp}.loopSpeed`, e instanceof Error ? e.message : 'Ungültiges Tempo.')
              }
            }
            const keys = parseOverlayKeys(data.keys)
            if (!keys) return fail(`${gp}.keys`, 'Ungültige Keyframes.')
            if (data.ease !== undefined && data.ease !== null && data.ease !== 'smooth')
              return fail(`${gp}.ease`, 'Ungültige Bewegung.')
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
                ...(animOut !== undefined ? { animOut, animOutSpeed } : {}),
                ...(loopSpeed !== undefined ? { loopSpeed } : {}),
                ...(keys.length > 0 ? { keys } : {}),
                ...(keys.length > 0 && data.ease === 'smooth' ? { ease: 'smooth' as const } : {}),
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
          const textKeys = parseOverlayKeys(data.keys)
          if (!textKeys) return fail(`${cp}.data.keys`, 'Ungültige Keyframes.')
          if (data.ease !== undefined && data.ease !== null && data.ease !== 'smooth')
            return fail(`${cp}.data.ease`, 'Ungültige Bewegung.')
          // Sonst gleiche Regeln wie beim Einbrennen im bisherigen Editor.
          try {
            const seconds = Math.max(MIN_TEXT_DURATION, rc.duration / MICROS_PER_SECOND)
            const [parsed] = parseTextOverlays([{ ...data, start: 0, end: seconds }], Infinity)
            const text: Partial<TextOverlay> = { ...parsed }
            delete text.start
            delete text.end
            if (textKeys.length > 0) {
              text.motion = {
                keys: textKeys.map((k) => ({ ...k, at: k.at / MICROS_PER_SECOND })),
                smooth: data.ease === 'smooth',
              }
            }
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
          let envelope: DocVolumePoint[] | null = null
          if (rc.envelope !== undefined && rc.envelope !== null) {
            const list: unknown = rc.envelope
            if (!Array.isArray(list) || list.length > MAX_ENVELOPE_POINTS)
              return fail(`${cp}.envelope`, 'Ungültige Lautstärke-Kurve.')
            const points: DocVolumePoint[] = []
            for (const p of list as unknown[]) {
              if (
                !isObject(p) ||
                !isTime(p.at) ||
                !inRange(p.gain, 0, MAX_ENVELOPE_GAIN) ||
                (points.length > 0 && p.at <= points[points.length - 1].at)
              )
                return fail(`${cp}.envelope`, 'Ungültige Lautstärke-Kurve.')
              points.push({ at: p.at, gain: p.gain })
            }
            if (points.length > 0) envelope = points
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
            envelope,
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
          let keys: DocLayoutKey[] = []
          if (l.keys !== undefined && l.keys !== null) {
            const raw = l.keys
            if (!Array.isArray(raw) || raw.length > MAX_LAYOUT_KEYS)
              return fail(`${cp}.layout.keys`, 'Ungültige Keyframes.')
            for (const k of raw as unknown[]) {
              const last = keys[keys.length - 1]
              if (
                !isObject(k) ||
                !isTime(k.at) ||
                !inRange(k.x, 0, 1) ||
                !inRange(k.y, 0, 1) ||
                !inRange(k.scale, MIN_LAYOUT_SCALE, 1) ||
                (k.opacity !== undefined && !inRange(k.opacity, 0, 1)) ||
                (last !== undefined && k.at <= last.at)
              )
                return fail(`${cp}.layout.keys`, 'Ungültige Keyframes.')
              keys.push({
                at: k.at,
                x: k.x,
                y: k.y,
                scale: k.scale,
                opacity: (k.opacity ?? l.opacity) as number,
              })
            }
          }
          // Ein einzelner Keyframe bewegt nichts: Er gilt als feste Lage.
          if (l.ease !== undefined && l.ease !== null && l.ease !== 'smooth')
            return fail(`${cp}.layout.ease`, 'Ungültige Bewegung.')
          const fixed = keys.length > 0 ? keys[0] : (l as unknown as DocLayout)
          if (keys.length < 2) keys = []
          // Volle Größe und Deckkraft ist dasselbe wie keine Lage.
          if (keys.length > 0 || fixed.scale < 1 || fixed.opacity < 1)
            layout = {
              x: fixed.x,
              y: fixed.y,
              scale: fixed.scale,
              opacity: fixed.opacity,
              ...(keys.length > 0 ? { keys } : {}),
              ...(keys.length > 0 && l.ease === 'smooth' ? { ease: 'smooth' as const } : {}),
            }
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
        let fadeOut: { duration: Time } | null = null
        if (rc.fadeOut !== undefined && rc.fadeOut !== null) {
          const f = rc.fadeOut
          if (
            !isObject(f) ||
            !isTime(f.duration) ||
            !inRange(f.duration, MIN_TRANSITION, MAX_TRANSITION)
          )
            return fail(`${cp}.fadeOut`, 'Ungültiges Ausblenden.')
          fadeOut = { duration: f.duration }
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
          ...(fadeOut ? { fadeOut } : {}),
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
          ...((raw.duck as number | undefined) ? { duck: raw.duck as number } : {}),
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
  return {
    ok: true,
    doc: {
      version: TIMELINE_DOC_VERSION,
      settings,
      assets,
      tracks,
      markers: parseMarkers(input.markers),
      effects: parseMarkerEffects(input.markers),
    },
  }
}
