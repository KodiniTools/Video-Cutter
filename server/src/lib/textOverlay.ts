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

export const TEXT_ANIMATIONS = ['none', 'fade', 'slide', 'pop', 'typewriter'] as const
export type TextAnimation = (typeof TEXT_ANIMATIONS)[number]

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
}

/** Hoch genug für automatisch erzeugte Untertitel (ca. 30–40 Minuten Sprache). */
export const MAX_TEXT_OVERLAYS = 500
export const MAX_TEXT_LENGTH = 300
export const MAX_TEXT_LINES = 6
export const MIN_TEXT_SIZE = 0.02
export const MAX_TEXT_SIZE = 0.3
/** Mindestdauer einer Einblendung in Sekunden. */
export const MIN_TEXT_DURATION = 0.2

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
    }
  })
}

// --- Animations-Zeiten (identisch im Frontend, src/lib/textOverlay.ts) ------

/** Ein-/Ausblendzeit in ms – höchstens ein Drittel der Einblenddauer. */
export function fadeMs(durationSec: number): number {
  return Math.round(Math.min(400, (durationSec * 1000) / 3))
}

/** Dauer der Bewegung bei 'slide'/'pop' in ms. */
export function moveMs(durationSec: number): number {
  return Math.round(Math.min(500, (durationSec * 1000) / 3))
}

/** Zeit pro Zeichen bei 'typewriter' in ms (alles nach spätestens 60 % sichtbar). */
export function typeStepMs(durationSec: number, chars: number): number {
  if (chars <= 1) return 0
  return Math.min(60, (durationSec * 1000 * 0.6) / (chars - 1))
}

/** Versatz nach unten beim Hereingleiten (Anteil der Bildhöhe). */
export const SLIDE_OFFSET = 0.06

// --- ASS-Erzeugung ----------------------------------------------------------

/** `#rrggbb` -> ASS-Farbe `&HBBGGRR&`. */
export function assColor(hex: string): string {
  const h = hex.replace('#', '')
  return `&H${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}&`.toUpperCase()
}

/** Sekunden -> ASS-Zeit `H:MM:SS.cc`. */
export function assTime(sec: number): string {
  const cs = Math.max(0, Math.round(sec * 100))
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

/** Alpha-Werte (ASS: 00 = deckend, FF = unsichtbar) je Stil. */
function styleTags(o: TextOverlay, px: number): { tags: string; alpha: string } {
  const accent = assColor(o.accent)
  switch (o.style) {
    case 'outline':
      return {
        tags: `\\bord${r1(Math.max(1, px * 0.08))}\\shad0\\3c${accent}`,
        alpha: '\\1a&H00&\\3a&H00&',
      }
    case 'box':
      return {
        tags: `\\bord${r1(Math.max(2, px * 0.2))}\\shad0\\3c${accent}`,
        alpha: '\\1a&H00&\\3a&H00&',
      }
    case 'shadow':
      return {
        tags: `\\bord0\\shad${r1(Math.max(1, px * 0.06))}\\4c${accent}`,
        alpha: '\\1a&H00&\\4a&H40&',
      }
    case 'none':
      return { tags: '\\bord0\\shad0', alpha: '\\1a&H00&' }
    default: {
      const never: never = o.style
      throw new Error(`Unbekannter Stil: ${String(never)}`)
    }
  }
}

/** Eine Dialogue-Zeile für eine Einblendung. */
export function buildAssEvent(o: TextOverlay, width: number, height: number): string {
  const dur = o.end - o.start
  const px = o.size * height
  const meta = fontMeta(o.font)
  const x = Math.round(o.x * width)
  const y = Math.round(o.y * height)
  const { tags: look, alpha } = styleTags(o, px)
  const base =
    `\\an5\\fn${meta.family}\\b${meta.bold ? 1 : 0}\\fs${r1(px * meta.winRatio)}` +
    `\\c${assColor(o.color)}${look}${alpha}`

  const f = fadeMs(dur)
  const m = moveMs(dur)
  let anim: string
  let body = escapeAssText(o.text)
  switch (o.animation) {
    case 'none':
      anim = `\\pos(${x},${y})`
      break
    case 'fade':
      anim = `\\pos(${x},${y})\\fad(${f},${f})`
      break
    case 'slide': {
      const dy = Math.round(SLIDE_OFFSET * height)
      anim = `\\move(${x},${y + dy},${x},${y},0,${m})\\fad(${m},${f})`
      break
    }
    case 'pop': {
      const a = Math.round(m * 0.6)
      anim =
        `\\pos(${x},${y})\\fad(${Math.round(m / 2)},${f})\\fscx40\\fscy40` +
        `\\t(0,${a},\\fscx112\\fscy112)\\t(${a},${m},\\fscx100\\fscy100)`
      break
    }
    case 'typewriter': {
      anim = `\\pos(${x},${y})\\fad(0,${f})`
      const chars = Array.from(o.text)
      const visible = chars.filter((c) => c !== '\n').length
      const step = typeStepMs(dur, visible)
      // Box bleibt von Anfang an stehen (sonst stückelt libass sie je Zeichen).
      const hidden = o.style === 'box' ? '\\1a&HFF&' : '\\1a&HFF&\\3a&HFF&\\4a&HFF&'
      const shown = o.style === 'box' ? '\\1a&H00&' : alpha
      let k = 0
      body = chars
        .map((ch) => {
          if (ch === '\n') return '\\N'
          const t = Math.round(k++ * step)
          // Zeichen 0 sofort sichtbar; danach jeweils nach `step` ms.
          if (t === 0) return escapeChar(ch)
          return `{${hidden}\\t(${t},${t + 1},${shown})}${escapeChar(ch)}`
        })
        .join('')
      break
    }
    default: {
      const never: never = o.animation
      throw new Error(`Unbekannte Animation: ${String(never)}`)
    }
  }

  const style = o.style === 'box' ? 'Box' : 'Text'
  return `Dialogue: 0,${assTime(o.start)},${assTime(o.end)},${style},,0,0,0,,{${base}${anim}}${body}`
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
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...overlays.map((o) => buildAssEvent(o, width, height)),
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
