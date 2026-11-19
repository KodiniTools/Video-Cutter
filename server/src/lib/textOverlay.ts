import { ValidationError } from './validate'
import { getCustomFont } from './customFonts'

/**
 * Text-Einblendungen: Der Client schickt eine Liste von Texten (Zeitbereich,
 * Position, Design, Animation). Der Server erzeugt daraus eine ASS-Untertitel-
 * datei, die FFmpeg mit dem `ass`-Filter (libass) ins Video einbrennt.
 *
 * Nutzertext landet NUR in der .ass-Datei, nie in der Filterkette – dadurch
 * gibt es kein Escaping-Problem in den FFmpeg-Argumenten.
 */

export const TEXT_FONTS = ['roboto', 'montserrat', 'bebas', 'lora', 'pacifico'] as const
export type BuiltinFont = (typeof TEXT_FONTS)[number]
/** Mitgelieferte Schrift oder eigene Schrift (`f:<Dateiname>`, siehe customFonts). */
export type TextFont = BuiltinFont | `f:${string}`

export const TEXT_STYLES = ['outline', 'box', 'shadow', 'none'] as const
export type TextStyle = (typeof TEXT_STYLES)[number]

export const TEXT_ANIMATIONS = [
  'none',
  'fade',
  'fadeIn',
  'fadeOut',
  'slide',
  'slideTop',
  'slideLeft',
  'slideRight',
  'zoom',
  'pop',
  'typewriter',
] as const
export type TextAnimation = (typeof TEXT_ANIMATIONS)[number]

/**
 * Eigene Animation zum Ausblenden (für Texte und Grafiken gleich). Ist sie
 * gesetzt, bestimmt `animation` nur noch das Einblenden; fehlt sie, gilt das
 * bisherige Verhalten (die meisten Animationen blenden am Ende mit aus).
 * `slide…` gleitet nach unten, oben, links bzw. rechts hinaus, `zoom` wächst
 * weg, `pop` schrumpft weg.
 */
export const OUT_ANIMATIONS = [
  'none',
  'fade',
  'slide',
  'slideTop',
  'slideLeft',
  'slideRight',
  'zoom',
  'pop',
] as const
export type OutAnimation = (typeof OUT_ANIMATIONS)[number]

/** Ausblend-Animation aus der Anfrage: fehlt = `undefined` (bisheriges Verhalten). */
export function parseAnimOut(v: unknown, label: string): OutAnimation | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v === 'string' && (OUT_ANIMATIONS as readonly string[]).includes(v))
    return v as OutAnimation
  throw new ValidationError(`Ungültige Auswahl für ${label}.`)
}

/** Aus `animation` und `animOut`: Was am Anfang und was am Ende passiert. */
export function splitAnimation(o: {
  animation: TextAnimation
  animOut?: OutAnimation
  animSpeed?: number
  animOutSpeed?: number
}): { out: OutAnimation; outSpeed: number; legacy: boolean } {
  if (o.animOut !== undefined)
    return { out: o.animOut, outSpeed: o.animOutSpeed ?? 1, legacy: false }
  // Bisher: alles außer „Ohne“ und „Nur einblenden“ blendet am Ende aus.
  const out = o.animation === 'none' || o.animation === 'fadeIn' ? 'none' : 'fade'
  return { out, outSpeed: o.animSpeed ?? 1, legacy: true }
}

/**
 * Schrift-Metadaten. `winRatio` = (usWinAscent + usWinDescent) / unitsPerEm:
 * libass interpretiert `\fs` als Gesamthöhe der Schrift, CSS `font-size` als
 * Em-Größe. Damit Vorschau (CSS) und Ergebnis (libass) gleich groß sind, gilt
 * `\fs = cssPx * winRatio`. `bold` = Datei ist bereits fett (\b1 verhindert,
 * dass eine evtl. installierte Regular-Variante gewählt wird; kein Kunst-Fett).
 */
export const FONT_META: Record<BuiltinFont, { family: string; winRatio: number; bold: boolean }> = {
  roboto: { family: 'Roboto', winRatio: 1.2002, bold: true },
  montserrat: { family: 'Montserrat ExtraBold', winRatio: 1.562, bold: true },
  bebas: { family: 'Bebas Neue', winRatio: 1.3, bold: false },
  lora: { family: 'Lora', winRatio: 1.5, bold: true },
  pacifico: { family: 'Pacifico', winRatio: 1.935, bold: false },
}

/** Eine Text-Einblendung (Zeiten in Sekunden, Position/Größe als Anteile). */
export interface TextOverlay {
  text: string
  start: number
  end: number
  /** Mittelpunkt des Textes, Anteil der Bildbreite/-höhe [0,1]. */
  x: number
  y: number
  font: TextFont
  /** Schriftgröße (CSS-Em) als Anteil der Bildhöhe. */
  size: number
  /** Textfarbe `#rrggbb`. */
  color: string
  style: TextStyle
  /** Farbe von Kontur / Box / Schatten `#rrggbb`. */
  accent: string
  animation: TextAnimation
  /** Tempo der Animation (Faktor 0,25–4, 1 = normal). */
  animSpeed: number
  /** Eigene Animation zum Ausblenden; fehlt sie, blendet `animation` wie bisher mit aus. */
  animOut?: OutAnimation
  /** Tempo des Ausblendens (nur mit `animOut`). */
  animOutSpeed?: number
  /** Deckkraft des ganzen Textes samt Kontur/Box/Schatten (0–1); fehlt = 1. */
  opacity?: number
  /** Buchstabenabstand als Anteil der Schriftgröße (−0,2–1); fehlt = 0. */
  letterSpacing?: number
  /**
   * Bewegung über Keyframes (Timeline-Editor): Mitte und Größe ändern sich
   * über die Zeit. Ersetzt `x`/`y`.
   */
  motion?: TextMotion
}

/** Keyframe eines Textes; `at` in Sekunden ab Beginn der Einblendung. */
export interface TextKey {
  at: number
  x: number
  y: number
  /** Größe als Faktor der Schriftgröße. */
  scale: number
}

export interface TextMotion {
  /** Nach Zeit sortiert, mindestens einer. */
  keys: TextKey[]
  /** Sanft anlaufen und abbremsen statt gleichmäßig. */
  smooth: boolean
}

/** Hoch genug für automatisch erzeugte Untertitel (ca. 30–40 Minuten Sprache). */
export const MAX_TEXT_OVERLAYS = 500
export const MAX_TEXT_LENGTH = 300
export const MAX_TEXT_LINES = 6
export const MIN_TEXT_SIZE = 0.02
export const MAX_TEXT_SIZE = 0.3
/** Mindestdauer einer Einblendung in Sekunden. */
export const MIN_TEXT_DURATION = 0.2
/** Buchstabenabstand (Anteil der Schriftgröße), wie im Frontend. */
export const MIN_LETTER_SPACING = -0.2
export const MAX_LETTER_SPACING = 1

const COLOR_RE = /^#[0-9a-f]{6}$/i

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function num(v: unknown, label: string): number {
  const n = typeof v === 'string' ? Number(v) : v
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    throw new ValidationError(`Ungültiger Wert für ${label}.`)
  }
  return n
}

function oneOf<T extends string>(v: unknown, list: readonly T[], label: string): T {
  if (typeof v === 'string' && (list as readonly string[]).includes(v)) return v as T
  throw new ValidationError(`Ungültige Auswahl für ${label}.`)
}

function color(v: unknown, label: string): string {
  if (typeof v === 'string' && COLOR_RE.test(v)) return v.toLowerCase()
  throw new ValidationError(`Ungültige Farbe für ${label}.`)
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

function isBuiltinFont(v: string): v is BuiltinFont {
  return (TEXT_FONTS as readonly string[]).includes(v)
}

/** Mitgelieferte oder auf dem Server vorhandene eigene Schrift. */
function parseFont(v: unknown, n: number): TextFont {
  if (typeof v === 'string' && (isBuiltinFont(v) || (v.startsWith('f:') && getCustomFont(v)))) {
    return v as TextFont
  }
  throw new ValidationError(`Schrift von Text ${n} ist auf dem Server nicht vorhanden.`)
}

/**
 * Name/Größenfaktor für libass. Eigene Schriften: Datei ist genau ein Schnitt
 * -> \b0 (kein Kunst-Fett; libass wählt die Datei über den eindeutigen Namen).
 */
export function fontMeta(font: TextFont): { family: string; winRatio: number; bold: boolean } {
  if (isBuiltinFont(font)) return FONT_META[font]
  const c = getCustomFont(font)
  if (!c) throw new ValidationError('Schrift ist auf dem Server nicht vorhanden.')
  return { family: c.family, winRatio: c.winRatio, bold: false }
}

/** Bereinigt den Text: Zeilenumbrüche vereinheitlichen, Steuerzeichen entfernen. */
export function cleanText(raw: string): string {
  return (
    raw
      .replace(/\r\n?/g, '\n')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '')
      .split('\n')
      .map((l) => l.replace(/\s+$/, ''))
      .join('\n')
      .replace(/^\n+|\n+$/g, '')
  )
}

/**
 * Validiert die Text-Liste (JSON-Array oder bereits geparst). Zeiten werden
 * auf die Videodauer begrenzt; Einträge, die danach leer sind, sind ein Fehler.
 */
export function parseTextOverlays(raw: unknown, videoDuration: number): TextOverlay[] {
  let v: unknown = raw
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v)
    } catch {
      throw new ValidationError('Ungültige Textliste.')
    }
  }
  if (!Array.isArray(v) || v.length === 0) throw new ValidationError('Keine Texte angegeben.')
  if (v.length > MAX_TEXT_OVERLAYS) {
    throw new ValidationError(`Maximal ${MAX_TEXT_OVERLAYS} Texte pro Video.`)
  }
  const total = Number.isFinite(videoDuration) && videoDuration > 0 ? videoDuration : Infinity

  return v.map((item, i) => {
    const n = i + 1
    if (!isRecord(item)) throw new ValidationError(`Text ${n} ist ungültig.`)
    if (typeof item.text !== 'string') throw new ValidationError(`Text ${n} ist ungültig.`)
    const text = cleanText(item.text)
    if (!text.trim()) throw new ValidationError(`Text ${n} ist leer.`)
    if (text.length > MAX_TEXT_LENGTH) {
      throw new ValidationError(`Text ${n} ist zu lang (max. ${MAX_TEXT_LENGTH} Zeichen).`)
    }
    if (text.split('\n').length > MAX_TEXT_LINES) {
      throw new ValidationError(`Text ${n} hat zu viele Zeilen (max. ${MAX_TEXT_LINES}).`)
    }
    const start = Math.max(0, num(item.start, `Start von Text ${n}`))
    const end = Math.min(total, num(item.end, `Ende von Text ${n}`))
    if (!(end - start >= MIN_TEXT_DURATION)) {
      throw new ValidationError(`Text ${n}: Ende muss nach dem Start liegen (im Video).`)
    }
    const animOut = parseAnimOut(item.animOut, `Ausblenden von Text ${n}`)
    // Optional (fehlen bei älteren Projekten und im bisherigen Editor): nur
    // abweichende Werte übernehmen, damit die ASS-Datei sonst gleich bleibt.
    const opacity =
      item.opacity === undefined || item.opacity === null
        ? 1
        : clamp(num(item.opacity, `Deckkraft von Text ${n}`), 0, 1)
    const letterSpacing =
      item.letterSpacing === undefined || item.letterSpacing === null
        ? 0
        : clamp(
            num(item.letterSpacing, `Buchstabenabstand von Text ${n}`),
            MIN_LETTER_SPACING,
            MAX_LETTER_SPACING,
          )
    return {
      text,
      start,
      end,
      x: clamp(num(item.x, `Position von Text ${n}`), 0, 1),
      y: clamp(num(item.y, `Position von Text ${n}`), 0, 1),
      font: parseFont(item.font, n),
      size: clamp(num(item.size, `Größe von Text ${n}`), MIN_TEXT_SIZE, MAX_TEXT_SIZE),
      color: color(item.color, `Text ${n}`),
      style: oneOf(item.style, TEXT_STYLES, `Stil von Text ${n}`),
      accent: color(item.accent, `Akzent von Text ${n}`),
      animation: oneOf(item.animation, TEXT_ANIMATIONS, `Animation von Text ${n}`),
      animSpeed: parseAnimSpeed(item.animSpeed, `Tempo von Text ${n}`),
      ...(animOut !== undefined
        ? {
            animOut,
            animOutSpeed: parseAnimSpeed(item.animOutSpeed, `Tempo des Ausblendens von Text ${n}`),
          }
        : {}),
      ...(opacity < 1 ? { opacity } : {}),
      ...(letterSpacing !== 0 ? { letterSpacing } : {}),
    }
  })
}

// --- Animations-Zeiten (identisch im Frontend, src/lib/textOverlay.ts) ------

// Tempo (Faktor): Grundzeiten werden geteilt, Obergrenzen bleiben; 1 = wie bisher.

/**
 * Obergrenze der Animationszeit: ein Drittel der Einblenddauer. Bei den
 * langsamen Stufen (unter 0,25×) die Hälfte, damit sie auch bei kurzen
 * Einblendungen noch langsamer wirken als 0,25×.
 */
function animCap(durationSec: number, speed: number): number {
  return (durationSec * 1000) / (speed < 0.25 ? 2 : 3)
}

/** Ein-/Ausblendzeit in ms – höchstens ein Drittel der Einblenddauer. */
export function fadeMs(durationSec: number, speed = 1): number {
  return Math.round(Math.min(400 / speed, animCap(durationSec, speed)))
}

/** Dauer der Bewegung bei 'slide'/'pop' in ms. */
export function moveMs(durationSec: number, speed = 1): number {
  return Math.round(Math.min(500 / speed, animCap(durationSec, speed)))
}

/** Zeit pro Zeichen bei 'typewriter' in ms (alles nach spätestens 60 % sichtbar). */
export function typeStepMs(durationSec: number, chars: number, speed = 1): number {
  if (chars <= 1) return 0
  return Math.min(60 / speed, (durationSec * 1000 * 0.6) / (chars - 1))
}

export const MIN_ANIM_SPEED = 0.05
export const MAX_ANIM_SPEED = 4

/** Tempo aus der Anfrage: fehlt = 1 (ältere Clients), sonst Zahl in [0,05; 4]. */
export function parseAnimSpeed(v: unknown, label: string): number {
  if (v === undefined || v === null) return 1
  const n = typeof v === 'string' ? Number(v) : v
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    throw new ValidationError(`Ungültiger Wert für ${label}.`)
  }
  return Math.min(MAX_ANIM_SPEED, Math.max(MIN_ANIM_SPEED, n))
}

/**
 * Startversatz beim Hereingleiten als Richtung (x, y): `slide` kommt von
 * unten, die anderen von oben, links und rechts.
 */
export function slideVector(
  animation: 'slide' | 'slideTop' | 'slideLeft' | 'slideRight',
): [number, number] {
  switch (animation) {
    case 'slide':
      return [0, 1]
    case 'slideTop':
      return [0, -1]
    case 'slideLeft':
      return [-1, 0]
    case 'slideRight':
      return [1, 0]
  }
}

/** Versatz beim Hereingleiten (Anteil der Bildhöhe, in alle Richtungen gleich). */
export const SLIDE_OFFSET = 0.06
/** Startgröße beim Heranzoomen (Faktor), läuft linear auf 1. */
export const ZOOM_FROM = 1.6

// --- ASS-Erzeugung ----------------------------------------------------------

/** `#rrggbb` -> ASS-Farbe `&HBBGGRR&`. */
export function assColor(hex: string): string {
  const h = hex.replace('#', '')
  return `&H${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}&`.toUpperCase()
}

/**
 * Sekunden -> ASS-Zeit `H:MM:SS.cc`, frame-genau wie die Vorschau.
 *
 * libass zeigt eine Zeile für ein Bild mit Zeitstempel t, wenn start <= t < end.
 * ASS kennt nur Hundertstel; Runden zur Mitte konnte die Zeit hinter das
 * gemeinte Bild schieben (Text erschien ein Bild zu spät / verschwand zu
 * spät). Deshalb abrunden – nach Abzug von 1 ms, weil der Client Bildzeiten
 * auf ganze ms rundet (z. B. 29,97 fps: 3,2032 s -> 3,203 s). Der Versatz
 * (1–11 ms) ist kleiner als ein Bildabstand (bis ~87 fps), trifft also exakt
 * dasselbe erste/letzte Bild wie in der Vorschau.
 */
export function assTime(sec: number): string {
  const cs = Math.max(0, Math.floor(sec * 100 - 0.1))
  const h = Math.floor(cs / 360000)
  const m = Math.floor((cs % 360000) / 6000)
  const s = Math.floor((cs % 6000) / 100)
  const c = cs % 100
  const p = (n: number) => String(n).padStart(2, '0')
  return `${h}:${p(m)}:${p(s)}.${p(c)}`
}

/**
 * Maskiert ein einzelnes Zeichen für ASS: `{`/`}` würden Override-Blöcke
 * öffnen, `\` vor N/n/h wäre ein Steuerzeichen. Ein Wortverbinder (U+2060)
 * hinter dem Backslash verhindert das, ohne sichtbar zu sein.
 */
function escapeChar(ch: string): string {
  if (ch === '\n') return '\\N'
  if (ch === '{') return '\\{'
  if (ch === '}') return '\\}'
  if (ch === '\\') return '\\⁠'
  return ch
}

export function escapeAssText(text: string): string {
  return Array.from(text).map(escapeChar).join('')
}

const r1 = (v: number) => Math.round(v * 10) / 10

/** Kontur und Schatten zur Schriftgröße `px` (wachsen mit dem Text). */
function edgeTags(o: Pick<TextOverlay, 'style'>, px: number): string {
  switch (o.style) {
    case 'outline':
      return `\\bord${r1(Math.max(1, px * 0.08))}\\shad0`
    case 'box':
      return `\\bord${r1(Math.max(2, px * 0.2))}\\shad0`
    case 'shadow':
      return `\\bord0\\shad${r1(Math.max(1, px * 0.06))}`
    case 'none':
      return '\\bord0\\shad0'
    default: {
      const never: never = o.style
      throw new Error(`Unbekannter Stil: ${String(never)}`)
    }
  }
}

/** Deckkraft des Textes (fehlt = 1). */
const opacityOf = (o: Pick<TextOverlay, 'opacity'>) => o.opacity ?? 1

/**
 * ASS-Alpha (`&H00&` deckend … `&HFF&` unsichtbar) für einen Grundwert `base`
 * (0–255), abgeschwächt um die Deckkraft des Textes.
 */
function alphaHex(base: number, opacity: number): string {
  const a = Math.round(255 - (255 - base) * opacity)
  return `&H${a.toString(16).toUpperCase().padStart(2, '0')}&`
}

/**
 * Halbtransparente Box: Je Zeile eine eigene Box (BorderStyle 3) würde sich
 * zwischen den Zeilen überlappen und dort dunkler werden. Dann eine Box um
 * den ganzen Text (BorderStyle 4, Farbe aus `\\4c`). Deckende Boxen bleiben
 * wie bisher.
 */
const translucentBox = (o: TextOverlay) => o.style === 'box' && opacityOf(o) < 1

/** Name des ASS-Stils einer Einblendung (siehe `buildAss`). */
function styleName(o: TextOverlay): string {
  if (o.style !== 'box') return 'Text'
  return translucentBox(o) ? 'BoxA' : 'Box'
}

/** Alpha-Werte (ASS: 00 = deckend, FF = unsichtbar) je Stil. */
function styleTags(o: TextOverlay, px: number): { tags: string; alpha: string; edge: string } {
  const accent = assColor(o.accent)
  const edge = edgeTags(o, px)
  const op = opacityOf(o)
  const solid = alphaHex(0, op)
  switch (o.style) {
    case 'outline':
      return { tags: `${edge}\\3c${accent}`, alpha: `\\1a${solid}\\3a${solid}`, edge }
    case 'box':
      // Halbtransparent: Kontur unsichtbar, `\\bord` bleibt der Rand der Box.
      if (op < 1)
        return { tags: `${edge}\\4c${accent}`, alpha: `\\1a${solid}\\3a&HFF&\\4a${solid}`, edge }
      return { tags: `${edge}\\3c${accent}`, alpha: '\\1a&H00&\\3a&H00&', edge }
    case 'shadow':
      return { tags: `${edge}\\4c${accent}`, alpha: `\\1a${solid}\\4a${alphaHex(0x40, op)}`, edge }
    case 'none':
      return { tags: edge, alpha: `\\1a${solid}`, edge }
    default: {
      const never: never = o.style
      throw new Error(`Unbekannter Stil: ${String(never)}`)
    }
  }
}

/**
 * Text der Schreibmaschine: Jedes Zeichen erscheint zu seiner Zeit. `offsetMs`
 * ist die Zeit, die beim Beginn dieser Zeile schon vergangen ist (Texte mit
 * Keyframes bestehen aus mehreren Zeilen hintereinander).
 */
function typewriterBody(
  o: TextOverlay,
  dur: number,
  alpha: string,
  offsetMs: number,
  fsp = '',
): string {
  const chars = Array.from(o.text)
  const visible = chars.filter((c) => c !== '\n').length
  const step = typeStepMs(dur, visible, o.animSpeed)
  // Box bleibt von Anfang an stehen (sonst stückelt libass sie je Zeichen).
  const hidden = o.style === 'box' ? '\\1a&HFF&' : '\\1a&HFF&\\3a&HFF&\\4a&HFF&'
  const shown = o.style === 'box' ? `\\1a${alphaHex(0, opacityOf(o))}` : alpha
  let k = 0
  return spacedBody(chars, fsp, (ch) => {
    const at = Math.round(k++ * step)
    const t = at - offsetMs
    // Zeichen 0 sofort sichtbar; danach jeweils nach `step` ms.
    if (at === 0 || t <= 0) return escapeChar(ch)
    return `{${hidden}\\t(${t},${t + 1},${shown})}${escapeChar(ch)}`
  })
}

/** Buchstabenabstand in px für die Schriftgröße `px` (`\\fsp`, leer ohne Abstand). */
function spacingTag(o: Pick<TextOverlay, 'letterSpacing'>, px: number): string {
  const s = o.letterSpacing ?? 0
  return s === 0 ? '' : `\\fsp${r1(s * px)}`
}

/**
 * Setzt den Text Zeichen für Zeichen (`piece` je sichtbarem Zeichen, in
 * Reihenfolge). Mit Buchstabenabstand: libass setzt ihn auch hinter das letzte
 * Zeichen einer Zeile, die Zeile stünde dann um den halben Abstand neben der
 * Mitte (und eine Box wäre rechts breiter). Deshalb vor dem letzten Zeichen
 * jeder Zeile `\\fsp0` und nach dem Umbruch wieder der Abstand. Ein Abstand
 * skaliert in libass mit `\\fscx` (Keyframes, Zoom) mit.
 */
function spacedBody(chars: string[], fsp: string, piece: (ch: string) => string): string {
  let out = ''
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]
    if (ch === '\n') {
      out += fsp ? `\\N{${fsp}}` : '\\N'
      continue
    }
    const last = i + 1 === chars.length || chars[i + 1] === '\n'
    out += (fsp && last ? '{\\fsp0}' : '') + piece(ch)
  }
  return out
}

/** Text ohne Schreibmaschine (maskiert, mit Buchstabenabstand `fsp`). */
function plainBody(o: TextOverlay, fsp: string): string {
  if (!fsp) return escapeAssText(o.text)
  return spacedBody(Array.from(o.text), fsp, escapeChar)
}

/** Stand der Bewegung zur Zeit `at` (s ab Beginn): zwischen Keyframes gemischt, außen gehalten. */
export function textMotionAt(motion: TextMotion, at: number): Omit<TextKey, 'at'> {
  const keys = motion.keys
  const pick = ({ x, y, scale }: TextKey) => ({ x, y, scale })
  if (at <= keys[0].at) return pick(keys[0])
  for (let i = 1; i < keys.length; i++) {
    if (at >= keys[i].at) continue
    const a = keys[i - 1]
    const b = keys[i]
    const linear = (at - a.at) / (b.at - a.at)
    const f = motion.smooth ? linear * linear * (3 - 2 * linear) : linear
    const mix = (from: number, to: number) => from + (to - from) * f
    return { x: mix(a.x, b.x), y: mix(a.y, b.y), scale: mix(a.scale, b.scale) }
  }
  return pick(keys[keys.length - 1])
}

/** Kürzestes Teilstück einer bewegten Einblendung (s): ASS zählt in Hundertstel. */
const MIN_MOTION_STEP = 0.02
/** Weiche Bewegung: Teilstücke dieser Länge nähern die Kurve an (s). */
const SMOOTH_STEP = 0.1
/** Höchstens so viele Teilstücke zwischen zwei Keyframes. */
const MAX_SMOOTH_STEPS = 40

/** Zeiten (s ab Beginn), an denen eine bewegte Einblendung in Teilstücke zerfällt. */
function motionBreaks(motion: TextMotion, dur: number): number[] {
  const inner = motion.keys.map((k) => k.at).filter((at) => at > 0 && at < dur)
  const marks = [0, ...inner, dur]
  const out: number[] = [0]
  for (let i = 1; i < marks.length; i++) {
    const from = marks[i - 1]
    const to = marks[i]
    if (motion.smooth) {
      const a = textMotionAt(motion, from)
      const b = textMotionAt(motion, to)
      if (a.x !== b.x || a.y !== b.y || a.scale !== b.scale) {
        const n = Math.min(MAX_SMOOTH_STEPS, Math.ceil((to - from) / SMOOTH_STEP))
        for (let k = 1; k < n; k++) out.push(from + ((to - from) * k) / n)
      }
    }
    out.push(to)
  }
  // Zu kurze Teilstücke fallen weg; das Ende bleibt immer.
  const kept: number[] = [0]
  for (const at of out.slice(1, -1)) {
    if (at - kept[kept.length - 1] >= MIN_MOTION_STEP && dur - at >= MIN_MOTION_STEP) kept.push(at)
  }
  kept.push(dur)
  return kept
}

/**
 * Dialogue-Zeilen für eine Einblendung. Ohne Keyframes ist es genau eine
 * (`buildAssEvent`). Mit Keyframes entsteht je Teilstück eine Zeile, die Mitte
 * (`\\move`) und Größe (`\\fscx`/`\\fscy` mit `\\t`) gleichmäßig ändert; die Zeilen
 * schließen lückenlos aneinander an. Ein- und Ausblenden bleiben am ersten
 * und letzten Teilstück, die Schreibmaschine läuft über alle hinweg.
 * Hereingleiten und Aufploppen werden mit Keyframes zum Einblenden.
 */
export function buildAssEvents(o: TextOverlay, width: number, height: number): string[] {
  const motion = o.motion
  if (!motion || motion.keys.length === 0) return buildAssLines(o, width, height)
  const dur = o.end - o.start
  const px = o.size * height
  const meta = fontMeta(o.font)
  const { tags: look, alpha } = styleTags(o, px)
  const colors = look.slice(edgeTags(o, px).length)
  const f = fadeMs(dur, o.animSpeed)
  const m = moveMs(dur, o.animSpeed)
  let fadeIn = 0
  switch (o.animation) {
    case 'none':
    case 'typewriter':
      break
    case 'fadeOut':
      break
    case 'fade':
    case 'fadeIn':
      fadeIn = f
      break
    case 'slide':
    case 'slideTop':
    case 'slideLeft':
    case 'slideRight':
      fadeIn = m
      break
    case 'zoom':
    case 'pop':
      fadeIn = Math.round(m / 2)
      break
    default: {
      const never: never = o.animation
      throw new Error(`Unbekannte Animation: ${String(never)}`)
    }
  }
  // Mit Keyframes wird jede Ausblend-Animation zum Ausblenden (wie beim Einblenden).
  const end = splitAnimation(o)
  const fadeOut = end.out === 'none' ? 0 : end.legacy ? f : fadeMs(dur, end.outSpeed)
  const style = styleName(o)
  const fsp = spacingTag(o, px)
  const breaks = motionBreaks(motion, dur)
  const scaled = motion.keys.some((k) => k.scale !== 1)
  const pct = (scale: number) => r1(scale * 100)
  const lines: string[] = []
  for (let i = 1; i < breaks.length; i++) {
    const from = breaks[i - 1]
    const to = breaks[i]
    const a = textMotionAt(motion, from)
    const b = textMotionAt(motion, to)
    const [x1, y1] = [Math.round(a.x * width), Math.round(a.y * height)]
    const [x2, y2] = [Math.round(b.x * width), Math.round(b.y * height)]
    const place = x1 === x2 && y1 === y2 ? `\\pos(${x1},${y1})` : `\\move(${x1},${y1},${x2},${y2})`
    let size = ''
    if (scaled) {
      size = `\\fscx${pct(a.scale)}\\fscy${pct(a.scale)}`
      if (a.scale !== b.scale)
        size += `\\t(\\fscx${pct(b.scale)}\\fscy${pct(b.scale)}${edgeTags(o, px * b.scale)})`
    }
    const segMs = Math.round((to - from) * 1000)
    const fin = i === 1 ? Math.min(fadeIn, segMs) : 0
    const fout = i === breaks.length - 1 ? Math.min(fadeOut, segMs) : 0
    const fad = fin > 0 || fout > 0 ? `\\fad(${fin},${fout})` : ''
    const base =
      `\\an5\\fn${meta.family}\\b${meta.bold ? 1 : 0}\\fs${r1(px * meta.winRatio)}` +
      `\\c${assColor(o.color)}${edgeTags(o, px * a.scale)}${colors}${alpha}${fsp}`
    const body =
      o.animation === 'typewriter'
        ? typewriterBody(o, dur, alpha, Math.round(from * 1000), fsp)
        : plainBody(o, fsp)
    lines.push(
      `Dialogue: 0,${assTime(o.start + from)},${assTime(o.start + to)},${style},,0,0,0,,` +
        `{${base}${place}${size}${fad}}${body}`,
    )
  }
  return lines
}

/**
 * Dialogue-Zeilen für eine Einblendung ohne Keyframes: eine, mit bewegtem
 * Ausblenden (`animOut` gleiten/zoomen/ploppen) zwei.
 */
export function buildAssLines(o: TextOverlay, width: number, height: number): string[] {
  const dur = o.end - o.start
  const px = o.size * height
  const meta = fontMeta(o.font)
  const x = Math.round(o.x * width)
  const y = Math.round(o.y * height)
  const { tags: look, alpha } = styleTags(o, px)
  const fsp = spacingTag(o, px)
  const base =
    `\\an5\\fn${meta.family}\\b${meta.bold ? 1 : 0}\\fs${r1(px * meta.winRatio)}` +
    `\\c${assColor(o.color)}${look}${alpha}${fsp}`

  const end = splitAnimation(o)
  // Bewegtes Ausblenden braucht eine eigene Zeile (ASS kennt je Zeile nur ein \\move).
  const tail = !end.legacy && end.out !== 'none' && end.out !== 'fade'
  /** Ausblendzeit der (ersten) Zeile in ms. */
  const f = tail ? 0 : end.out === 'none' ? 0 : fadeMs(dur, end.outSpeed)
  const fi = fadeMs(dur, o.animSpeed)
  const m = moveMs(dur, o.animSpeed)
  let anim: string
  let body = plainBody(o, fsp)
  switch (o.animation) {
    case 'none':
    case 'fadeOut':
      anim = `\\pos(${x},${y})` + (f > 0 ? `\\fad(0,${f})` : '')
      break
    case 'fade':
    case 'fadeIn':
      anim = `\\pos(${x},${y})\\fad(${fi},${f})`
      break
    case 'slide':
    case 'slideTop':
    case 'slideLeft':
    case 'slideRight': {
      // Gleicher Weg in px für alle Richtungen (Anteil der Bildhöhe).
      const d = Math.round(SLIDE_OFFSET * height)
      const [dx, dy] = slideVector(o.animation)
      anim = `\\move(${x + dx * d},${y + dy * d},${x},${y},0,${m})\\fad(${m},${f})`
      break
    }
    case 'zoom': {
      const from = Math.round(ZOOM_FROM * 100)
      anim =
        `\\pos(${x},${y})\\fad(${Math.round(m / 2)},${f})\\fscx${from}\\fscy${from}` +
        `\\t(0,${m},\\fscx100\\fscy100)`
      break
    }
    case 'pop': {
      const a = Math.round(m * 0.6)
      anim =
        `\\pos(${x},${y})\\fad(${Math.round(m / 2)},${f})\\fscx40\\fscy40` +
        `\\t(0,${a},\\fscx112\\fscy112)\\t(${a},${m},\\fscx100\\fscy100)`
      break
    }
    case 'typewriter':
      anim = `\\pos(${x},${y})` + (f > 0 ? `\\fad(0,${f})` : '')
      body = typewriterBody(o, dur, alpha, 0, fsp)
      break
    default: {
      const never: never = o.animation
      throw new Error(`Unbekannte Animation: ${String(never)}`)
    }
  }

  const style = styleName(o)
  const line = (from: number, to: number, tags: string, text: string) =>
    `Dialogue: 0,${assTime(from)},${assTime(to)},${style},,0,0,0,,{${base}${tags}}${text}`
  if (!tail) return [line(o.start, o.end, anim, body)]

  // Zweite Zeile für das bewegte Ausblenden: schließt lückenlos an die erste an.
  // Die Grenze liegt auf dem Hundertstel-Raster von ASS (wie assTime rundet).
  const mo = moveMs(dur, end.outSpeed)
  // In Hundertstel, so wie assTime Beginn und Ende der Zeilen schreibt.
  const cs = (sec: number) => Math.max(0, Math.floor(sec * 100 - 0.1))
  const startCs = cs(o.start)
  const endCs = cs(o.end)
  const splitCs = Math.min(endCs - 1, Math.max(startCs, cs(o.end - mo / 1000)))
  /** Zeit, die assTime genau auf `splitCs` abbildet. */
  const split = (splitCs + 0.5) / 100
  const rest = Math.max(1, (endCs - splitCs) * 10)
  const t0 = Math.max(0, rest - mo)
  let out: string
  switch (end.out) {
    case 'slide':
    case 'slideTop':
    case 'slideLeft':
    case 'slideRight': {
      const d = Math.round(SLIDE_OFFSET * height)
      const [dx, dy] = slideVector(end.out)
      out = `\\move(${x},${y},${x + dx * d},${y + dy * d},${t0},${rest})\\fad(0,${mo})`
      break
    }
    case 'zoom': {
      const to = Math.round(ZOOM_FROM * 100)
      out =
        `\\pos(${x},${y})\\fad(0,${Math.round(mo / 2)})` +
        `\\t(${t0},${rest},\\fscx${to}\\fscy${to})`
      break
    }
    case 'pop': {
      const a = t0 + Math.round(mo * 0.4)
      out =
        `\\pos(${x},${y})\\fad(0,${Math.round(mo / 2)})` +
        `\\t(${t0},${a},\\fscx112\\fscy112)\\t(${a},${rest},\\fscx40\\fscy40)`
      break
    }
    default:
      throw new Error(`Unbekannte Ausblend-Animation: ${String(end.out)}`)
  }
  const tailBody =
    o.animation === 'typewriter'
      ? typewriterBody(o, dur, alpha, (splitCs - startCs) * 10, fsp)
      : plainBody(o, fsp)
  // Reicht das Einblenden bis hinter die Grenze (sehr kurze Texte), entfällt die erste Zeile.
  if (splitCs - startCs < MIN_MOTION_STEP * 100) return [line(o.start, o.end, out, tailBody)]
  return [line(o.start, split, anim, body), line(split, o.end, out, tailBody)]
}

/** Eine Dialogue-Zeile für eine Einblendung (ohne bewegtes Ausblenden). */
export function buildAssEvent(o: TextOverlay, width: number, height: number): string {
  return buildAssLines(o, width, height)[0]
}

/**
 * Komplette ASS-Datei. PlayRes = Videoauflösung, damit Positionen, Größen
 * und Konturbreiten in echten Pixeln angegeben werden können.
 */
export function buildAss(overlays: TextOverlay[], width: number, height: number): string {
  if (!(width > 0 && height > 0)) throw new ValidationError('Auflösung des Videos unbekannt.')
  const style = (name: string, borderStyle: number) =>
    `Style: ${name},Roboto,48,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,` +
    `0,0,0,0,100,100,0,0,${borderStyle},0,0,5,0,0,0,1`
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    'YCbCr Matrix: None',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, ' +
      'Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, ' +
      'Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    style('Text', 1),
    style('Box', 3),
    // Nur wenn gebraucht: ältere Projekte behalten genau dieselbe Datei.
    ...(overlays.some(translucentBox) ? [style('BoxA', 4)] : []),
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...overlays.flatMap((o) => buildAssEvents(o, width, height)),
    '',
  ].join('\n')
}

/**
 * Maskiert einen Pfad als Optionswert in einer FFmpeg-Filterkette (zwei
 * Ebenen: Option `:`/`'`/`\`, danach Filtergraph `[],;'\`).
 */
export function escapeFilterPath(p: string): string {
  const opt = p.replace(/[\\':]/g, (c) => `\\${c}`)
  return opt.replace(/[\\'[\],;]/g, (c) => `\\${c}`)
}

/** Filter für das Einbrennen (danach yuv420p für maximale Abspielbarkeit). */
export function buildTextFilter(assPath: string, fontsDir: string): string {
  return `ass=filename=${escapeFilterPath(assPath)}:fontsdir=${escapeFilterPath(fontsDir)},format=yuv420p`
}
