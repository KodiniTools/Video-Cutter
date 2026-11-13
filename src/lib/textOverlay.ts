/**
 * Text-Einblendungen (Frontend): Datenmodell, Schriften und die Vorschau-
 * Berechnung der Animationen. Zeiten/Konstanten entsprechen exakt dem Server
 * (server/src/lib/textOverlay.ts), damit Vorschau und eingebranntes Ergebnis
 * übereinstimmen.
 */

import { ensureFontFace, getCustomFont } from './customFonts'

export const TEXT_FONTS = ['roboto', 'montserrat', 'bebas', 'lora', 'pacifico'] as const
export type BuiltinFont = (typeof TEXT_FONTS)[number]
/** Mitgelieferte Schrift oder eigene Schrift (`f:<Dateiname>`, siehe customFonts). */
export type TextFont = BuiltinFont | `f:${string}`

export const TEXT_STYLES = ['outline', 'box', 'shadow', 'none'] as const
export type TextStyle = (typeof TEXT_STYLES)[number]

export const TEXT_ANIMATIONS = ['none', 'fade', 'slide', 'pop', 'typewriter'] as const
export type TextAnimation = (typeof TEXT_ANIMATIONS)[number]

/**
 * Schriften der Vorschau. `css` = Familienname der @font-face-Regel (siehe
 * TextOverlayLayer.vue), `lineRatio` = (usWinAscent + usWinDescent) / unitsPerEm –
 * so hoch ist eine Zeile bei libass, relativ zur CSS-Schriftgröße (gemessen).
 * `shift` = vertikaler Versatz (in em), um den libass den Textblock gegenüber
 * CSS tiefer (+) bzw. höher (−) setzt – per Vergleichsrender ermittelt.
 */
export interface FontPreview {
  label: string
  css: string
  lineRatio: number
  shift: number
}

export const FONT_OPTIONS: Record<BuiltinFont, FontPreview> = {
  roboto: { label: 'Roboto', css: 'VC Roboto', lineRatio: 1.2002, shift: 0.01 },
  montserrat: { label: 'Montserrat', css: 'VC Montserrat', lineRatio: 1.562, shift: -0.03 },
  bebas: { label: 'Bebas Neue', css: 'VC Bebas Neue', lineRatio: 1.3, shift: 0 },
  lora: { label: 'Lora', css: 'VC Lora', lineRatio: 1.5, shift: 0.09 },
  pacifico: { label: 'Pacifico', css: 'VC Pacifico', lineRatio: 1.935, shift: 0.08 },
}

export function isBuiltinFont(v: string): v is BuiltinFont {
  return (TEXT_FONTS as readonly string[]).includes(v)
}

/**
 * Vorschau-Daten einer Schrift. Eigene Schriften werden dabei für die Vorschau
 * registriert; unbekannte (noch nicht geladen) fallen auf Roboto zurück.
 */
export function fontPreview(font: TextFont): FontPreview {
  if (isBuiltinFont(font)) return FONT_OPTIONS[font]
  const c = getCustomFont(font)
  if (!c) return FONT_OPTIONS.roboto
  ensureFontFace(c)
  return { label: `${c.group} ${c.label}`, css: c.css, lineRatio: c.lineRatio, shift: c.shift }
}

/** Datenformat für den Server (POST /api/text). */
export interface TextOverlayData {
  text: string
  start: number
  end: number
  /** Mittelpunkt, Anteil der Bildbreite/-höhe [0,1]. */
  x: number
  y: number
  font: TextFont
  /** Schriftgröße (CSS-Em) als Anteil der Bildhöhe. */
  size: number
  color: string
  style: TextStyle
  accent: string
  animation: TextAnimation
}

/** Eintrag im Editor (mit lokaler ID). */
export interface TextOverlay extends TextOverlayData {
  id: number
}

/** Gleich wie im Server; hoch genug für automatisch erzeugte Untertitel. */
export const MAX_TEXT_OVERLAYS = 500
export const MAX_TEXT_LENGTH = 300
export const MIN_TEXT_SIZE = 0.02
export const MAX_TEXT_SIZE = 0.3
export const MIN_TEXT_DURATION = 0.2
/** Standard-Länge einer neuen Einblendung (Sekunden). */
export const DEFAULT_TEXT_DURATION = 3

/** Positions-Vorlagen (vertikal, Mitte der Textbox). */
export const POSITION_PRESETS = { top: 0.12, center: 0.5, bottom: 0.88 } as const
export type PositionPreset = keyof typeof POSITION_PRESETS

export const DEFAULT_TEXT_STYLE: Omit<TextOverlayData, 'text' | 'start' | 'end'> = {
  x: 0.5,
  y: POSITION_PRESETS.bottom,
  font: 'roboto',
  size: 0.06,
  color: '#ffffff',
  style: 'outline',
  accent: '#000000',
  animation: 'fade',
}

// --- Animations-Zeiten (identisch mit dem Server) ---------------------------

export function fadeMs(durationSec: number): number {
  return Math.round(Math.min(400, (durationSec * 1000) / 3))
}

export function moveMs(durationSec: number): number {
  return Math.round(Math.min(500, (durationSec * 1000) / 3))
}

export function typeStepMs(durationSec: number, chars: number): number {
  if (chars <= 1) return 0
  return Math.min(60, (durationSec * 1000 * 0.6) / (chars - 1))
}

export const SLIDE_OFFSET = 0.06

/** Darstellungszustand eines Textes zu einem Zeitpunkt (für die Vorschau). */
export interface OverlayFrame {
  visible: boolean
  opacity: number
  /** Vertikaler Versatz als Anteil der Bildhöhe. */
  dy: number
  scale: number
  /** Anzahl sichtbarer Zeichen (ohne Zeilenumbrüche); Infinity = alle. */
  chars: number
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

/** Lineare Interpolation wie libass `\t`/`\move` (ohne Beschleunigung). */
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * clamp01(t)
}

/**
 * Berechnet die Vorschau eines Textes zur Zeit `t` (Sekunden im Video) –
 * analog zu den ASS-Tags des Servers (`\fad`, `\move`, `\t`).
 */
export function overlayFrame(o: TextOverlayData, t: number): OverlayFrame {
  if (!(t >= o.start && t < o.end)) {
    return { visible: false, opacity: 0, dy: 0, scale: 1, chars: 0 }
  }
  const dur = o.end - o.start
  const ms = (t - o.start) * 1000
  const left = (o.end - t) * 1000
  const f = fadeMs(dur)
  const m = moveMs(dur)
  const fadeOut = (outMs: number) => (outMs > 0 ? clamp01(left / outMs) : 1)
  const fadeIn = (inMs: number) => (inMs > 0 ? clamp01(ms / inMs) : 1)
  const frame: OverlayFrame = { visible: true, opacity: 1, dy: 0, scale: 1, chars: Infinity }

  switch (o.animation) {
    case 'none':
      break
    case 'fade':
      frame.opacity = Math.min(fadeIn(f), fadeOut(f))
      break
    case 'slide':
      frame.opacity = Math.min(fadeIn(m), fadeOut(f))
      frame.dy = lerp(SLIDE_OFFSET, 0, m > 0 ? ms / m : 1)
      break
    case 'pop': {
      const a = Math.round(m * 0.6)
      frame.opacity = Math.min(fadeIn(Math.round(m / 2)), fadeOut(f))
      frame.scale =
        ms < a ? lerp(0.4, 1.12, a > 0 ? ms / a : 1) : lerp(1.12, 1, m > a ? (ms - a) / (m - a) : 1)
      break
    }
    case 'typewriter': {
      frame.opacity = fadeOut(f)
      const visible = Array.from(o.text).filter((c) => c !== '\n').length
      const step = typeStepMs(dur, visible)
      // Zeichen k erscheint bei round(k*step) ms (wie die \t-Zeiten des Servers).
      let n = 0
      for (let k = 0; k < visible; k++) {
        if (Math.round(k * step) <= ms) n = k + 1
        else break
      }
      frame.chars = n
      break
    }
    default: {
      const never: never = o.animation
      throw new Error(`Unbekannte Animation: ${String(never)}`)
    }
  }
  return frame
}

/** Für den Server: lokale ID entfernen, Zahlen runden. */
export function toServerOverlay(o: TextOverlay): TextOverlayData {
  const r = (v: number, d = 4) => Math.round(v * 10 ** d) / 10 ** d
  return {
    text: o.text,
    start: r(o.start, 3),
    end: r(o.end, 3),
    x: r(o.x),
    y: r(o.y),
    font: o.font,
    size: r(o.size),
    color: o.color,
    style: o.style,
    accent: o.accent,
    animation: o.animation,
  }
}

/** Ist der Eintrag gültig (Text vorhanden, Zeitbereich im Video)? */
export function isValidOverlay(o: TextOverlayData, duration: number): boolean {
  const end = duration > 0 ? Math.min(o.end, duration) : o.end
  return (
    o.text.trim().length > 0 &&
    o.text.length <= MAX_TEXT_LENGTH &&
    end - Math.max(0, o.start) >= MIN_TEXT_DURATION
  )
}
