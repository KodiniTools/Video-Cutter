/**
 * Text-Einblendungen (Frontend): Datenmodell, Schriften und die Vorschau-
 * Berechnung der Animationen. Zeiten/Konstanten entsprechen exakt dem Server
 * (server/src/lib/textOverlay.ts), damit Vorschau und eingebranntes Ergebnis
 * übereinstimmen.
 */

import { ensureFontFace, getCustomFont } from './customFonts'
// Mitgelieferte Schriften (@font-face) für Vorschau und Schriftauswahl, in beiden Editoren.
import './textFonts.css'

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
 * Eigene Animation zum Ausblenden (Texte und Grafiken, identisch auf dem
 * Server). Ist `animOut` gesetzt, bestimmt `animation` nur noch das
 * Einblenden; fehlt es, gilt das bisherige Verhalten (die meisten Animationen
 * blenden am Ende mit aus).
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

/** Animationen zum Einblenden (Auswahl im Editor); Grafiken ohne Schreibmaschine. */
export const IN_ANIMATIONS = [
  'none',
  'fadeIn',
  'slide',
  'slideTop',
  'slideLeft',
  'slideRight',
  'zoom',
  'pop',
  'typewriter',
] as const
export type InAnimation = (typeof IN_ANIMATIONS)[number]

/** Ein- und Ausblenden getrennt, jeweils mit eigenem Tempo. */
export interface AnimParts {
  in: InAnimation
  inSpeed: number
  out: OutAnimation
  outSpeed: number
}

const speedOr1 = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 1

/**
 * Liest Ein- und Ausblenden aus den Daten eines Textes oder einer Grafik.
 * Ältere Einträge ohne `animOut` werden so gedeutet, wie sie bisher aussahen:
 * „Ein- und Ausblenden“ = einblenden + ausblenden, „Nur ausblenden“ = nur
 * ausblenden, Hereingleiten/Zoomen/Ploppen/Schreibmaschine blenden am Ende aus.
 */
export function animParts(data: {
  animation?: unknown
  animSpeed?: unknown
  animOut?: unknown
  animOutSpeed?: unknown
}): AnimParts {
  const a = data.animation
  const inSpeed = speedOr1(data.animSpeed)
  const into: InAnimation =
    a === 'fade'
      ? 'fadeIn'
      : (IN_ANIMATIONS as readonly unknown[]).includes(a)
        ? (a as InAnimation)
        : 'none'
  if ((OUT_ANIMATIONS as readonly unknown[]).includes(data.animOut))
    return {
      in: into,
      inSpeed,
      out: data.animOut as OutAnimation,
      outSpeed: speedOr1(data.animOutSpeed),
    }
  const fades =
    (TEXT_ANIMATIONS as readonly unknown[]).includes(a) && a !== 'none' && a !== 'fadeIn'
  return { in: into, inSpeed, out: fades ? 'fade' : 'none', outSpeed: inSpeed }
}

/** Felder für die Daten eines Textes oder einer Grafik (getrennte Schreibweise). */
export function animPatch(parts: AnimParts): {
  animation: InAnimation
  animSpeed: number
  animOut: OutAnimation
  animOutSpeed: number
} {
  return {
    animation: parts.in,
    animSpeed: parts.inSpeed,
    animOut: parts.out,
    animOutSpeed: parts.outSpeed,
  }
}

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
  /**
   * Tempo der Animation (Faktor, 1 = normal, 0,5 = halb so schnell). Fehlt bei
   * älteren Einträgen = 1. Siehe ANIM_SPEEDS.
   */
  animSpeed?: number
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

/**
 * Pfeiltasten-Feinschritt für die Position: 0,1 % pro Druck, mit
 * Umschalttaste 1 %. `null` = keine Pfeiltaste. Ergebnis in [0,1], gerundet.
 */
export function nudgePosition(
  pos: { x: number; y: number },
  key: string,
  coarse: boolean,
): { x: number; y: number } | null {
  const step = coarse ? 0.01 : 0.001
  const d: Record<string, [number, number]> = {
    ArrowLeft: [-step, 0],
    ArrowRight: [step, 0],
    ArrowUp: [0, -step],
    ArrowDown: [0, step],
  }
  const move = d[key]
  if (!move) return null
  const r = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 10000) / 10000
  return { x: r(pos.x + move[0]), y: r(pos.y + move[1]) }
}

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

// Tempo: Grundzeiten (400/500/60 ms) werden durch den Faktor geteilt, die
// Obergrenze (ein Drittel bzw. 60 % der Einblenddauer) bleibt. Faktor 1 =
// exakt das bisherige Verhalten.

/**
 * Obergrenze der Animationszeit: ein Drittel der Einblenddauer. Bei den
 * langsamen Stufen (unter 0,25×) die Hälfte, damit sie auch bei kurzen
 * Einblendungen noch langsamer wirken als 0,25×.
 */
function animCap(durationSec: number, speed: number): number {
  return (durationSec * 1000) / (speed < 0.25 ? 2 : 3)
}

export function fadeMs(durationSec: number, speed = 1): number {
  return Math.round(Math.min(400 / speed, animCap(durationSec, speed)))
}

export function moveMs(durationSec: number, speed = 1): number {
  return Math.round(Math.min(500 / speed, animCap(durationSec, speed)))
}

export function typeStepMs(durationSec: number, chars: number, speed = 1): number {
  if (chars <= 1) return 0
  return Math.min(60 / speed, (durationSec * 1000 * 0.6) / (chars - 1))
}

/** Wählbare Tempo-Stufen der Animationen (Faktor). */
export const ANIM_SPEEDS = [0.05, 0.1, 0.15, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4] as const
export const MIN_ANIM_SPEED = 0.05
export const MAX_ANIM_SPEED = 4

/** Tempo eines Eintrags: fehlend/ungültig = 1, sonst auf [0,05; 4] begrenzt. */
export function animSpeedOf(o: { animSpeed?: unknown }): number {
  const v = o.animSpeed
  if (typeof v !== 'number' || !Number.isFinite(v)) return 1
  return Math.min(MAX_ANIM_SPEED, Math.max(MIN_ANIM_SPEED, v))
}

/** Animationen, die es schon vor der Erweiterung gab (jedes Backend mit Texten kennt sie). */
const CLASSIC_ANIMATIONS: readonly string[] = ['none', 'fade', 'slide', 'pop', 'typewriter']

/**
 * Braucht der Eintrag das Backend mit den erweiterten Animationen (Feature
 * `animations2`)? Das sind die neuen Animationen und Tempo unter 0,25×.
 */
export function needsAnimations2(o: { animation?: unknown; animSpeed?: unknown }): boolean {
  return (
    (typeof o.animation === 'string' && !CLASSIC_ANIMATIONS.includes(o.animation)) ||
    animSpeedOf(o) < 0.25
  )
}

/** Nächstgelegene Stufe aus ANIM_SPEEDS (Index für den Regler). */
export function animSpeedIndex(speed: number): number {
  let best = 0
  ANIM_SPEEDS.forEach((s, i) => {
    if (Math.abs(s - speed) < Math.abs(ANIM_SPEEDS[best]! - speed)) best = i
  })
  return best
}

/** Anzeige „0,5ד / „2ד je Sprache. */
export function formatAnimSpeed(speed: number, locale: string): string {
  return `${speed.toLocaleString(locale, { maximumFractionDigits: 2 })}×`
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

/** Darstellungszustand eines Textes zu einem Zeitpunkt (für die Vorschau). */
export interface OverlayFrame {
  visible: boolean
  opacity: number
  /** Waagerechter Versatz als Anteil der Bild**höhe** (gleicher Weg wie `dy`). */
  dx: number
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
    return { visible: false, opacity: 0, dx: 0, dy: 0, scale: 1, chars: 0 }
  }
  const dur = o.end - o.start
  const ms = (t - o.start) * 1000
  const left = (o.end - t) * 1000
  const sp = animSpeedOf(o)
  const f = fadeMs(dur, sp)
  const m = moveMs(dur, sp)
  const fadeOut = (outMs: number) => (outMs > 0 ? clamp01(left / outMs) : 1)
  const fadeIn = (inMs: number) => (inMs > 0 ? clamp01(ms / inMs) : 1)
  const frame: OverlayFrame = {
    visible: true,
    opacity: 1,
    dx: 0,
    dy: 0,
    scale: 1,
    chars: Infinity,
  }

  switch (o.animation) {
    case 'none':
      break
    case 'fade':
      frame.opacity = Math.min(fadeIn(f), fadeOut(f))
      break
    case 'fadeIn':
      frame.opacity = fadeIn(f)
      break
    case 'fadeOut':
      frame.opacity = fadeOut(f)
      break
    case 'slide':
    case 'slideTop':
    case 'slideLeft':
    case 'slideRight': {
      const [vx, vy] = slideVector(o.animation)
      const rest = lerp(SLIDE_OFFSET, 0, m > 0 ? ms / m : 1)
      frame.opacity = Math.min(fadeIn(m), fadeOut(f))
      frame.dx = vx * rest
      frame.dy = vy * rest
      break
    }
    case 'zoom':
      frame.opacity = Math.min(fadeIn(Math.round(m / 2)), fadeOut(f))
      frame.scale = lerp(ZOOM_FROM, 1, m > 0 ? ms / m : 1)
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
      const step = typeStepMs(dur, visible, sp)
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
    // Nur abweichendes Tempo senden: Anfrage sonst unverändert wie bisher.
    ...(animSpeedOf(o) !== 1 ? { animSpeed: animSpeedOf(o) } : {}),
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
