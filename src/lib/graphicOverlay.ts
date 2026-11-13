/**
 * Grafik-Einblendungen (Formen, Linien/Pfeile, Symbole, Emojis).
 *
 * Jede Grafik wird hier im Browser per Canvas als Bild gezeichnet. Dasselbe
 * Bild dient als Vorschau und wird beim Einbrennen als PNG an den Server
 * geschickt (POST /api/text, Feld `graphics`), der es per FFmpeg-`overlay`
 * an dieselbe Stelle legt – Vorschau und Ergebnis sind daher identisch.
 * Maße sind Anteile der Bildhöhe (ein Kreis bleibt rund), die Position ist
 * der Mittelpunkt als Anteil von Breite/Höhe. Animations-Zeiten wie bei Texten.
 */

import { fadeMs, moveMs, SLIDE_OFFSET } from './textOverlay'

export const GRAPHIC_KINDS = [
  'rect',
  'ellipse',
  'bubble',
  'line',
  'arrow',
  'symbol',
  'emoji',
] as const
export type GraphicKind = (typeof GRAPHIC_KINDS)[number]

export const GRAPHIC_ANIMATIONS = ['none', 'fade', 'slide'] as const
export type GraphicAnimation = (typeof GRAPHIC_ANIMATIONS)[number]

/**
 * Vektor-Symbole im 24er-Raster. `stroke` = als dicke Linie gezeichnet
 * (Häkchen, Kreuz, Plus), sonst gefüllt.
 */
export const GRAPHIC_SYMBOLS = {
  check: { path: 'M4.5 12.5l5 5L19.5 7', stroke: true },
  cross: { path: 'M6 6l12 12M18 6L6 18', stroke: true },
  plus: { path: 'M12 4.5v15M4.5 12h15', stroke: true },
  star: {
    path: 'M12 2.5l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.3l-5.9 3.3 1.3-6.6-4.9-4.6 6.6-.8z',
    stroke: false,
  },
  heart: {
    path: 'M12 21s-9-6.3-9-12.2C3 5.6 5.4 3.5 8.2 3.5c1.8 0 3.1 1 3.8 2.3.7-1.3 2-2.3 3.8-2.3 2.8 0 5.2 2.1 5.2 5.3C21 14.7 12 21 12 21z',
    stroke: false,
  },
  cursor: { path: 'M5 2.5v17l4.3-4.1 2.9 6.3 2.9-1.3-2.9-6.2H18z', stroke: false },
  exclamation: {
    path: 'M9.8 2.5h4.4l-.8 12.5h-2.8zM12 16.8a2.3 2.3 0 110 4.6 2.3 2.3 0 010-4.6z',
    stroke: false,
  },
  bigArrow: { path: 'M2.5 9h10.5V4l8.5 8-8.5 8v-5H2.5z', stroke: false },
} as const
export type GraphicSymbol = keyof typeof GRAPHIC_SYMBOLS
export const SYMBOL_NAMES = Object.keys(GRAPHIC_SYMBOLS) as GraphicSymbol[]

/** Strichstärke der Linien-Symbole im 24er-Raster. */
const SYMBOL_LINE = 3.2

/** Schnellauswahl für Tutorials; beliebige weitere per Eingabefeld. */
export const EMOJI_PRESETS = [
  '👉',
  '👈',
  '👆',
  '👇',
  '✅',
  '❌',
  '⚠️',
  '💡',
  '⭐',
  '🔥',
  '🎉',
  '👍',
  '👎',
  '❤️',
  '😀',
  '😂',
  '😮',
  '🤔',
  '🚀',
  '📌',
  '🔔',
  '⏱️',
  '🖱️',
  '💬',
] as const

/** Systemschriften für farbige Emojis (Vorschau und PNG nutzen dieselbe). */
export const EMOJI_FONT_STACK =
  '"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji","Twemoji Mozilla",sans-serif'

/** Datenmodell einer Grafik (ohne lokale ID). */
export interface GraphicData {
  kind: GraphicKind
  symbol: GraphicSymbol
  emoji: string
  start: number
  end: number
  /** Mittelpunkt, Anteil der Bildbreite/-höhe [0,1]. */
  x: number
  y: number
  /** Breite (bzw. Länge/Größe) als Anteil der Bildhöhe. */
  w: number
  /** Höhe als Anteil der Bildhöhe (nur Rechteck, Kreis/Ellipse, Sprechblase). */
  h: number
  /** Drehung im Uhrzeigersinn in Grad. */
  rotation: number
  /** Kontur-/Linienfarbe `#rrggbb`. */
  stroke: string
  /** Kontur-/Linienstärke als Anteil der Bildhöhe (0 = keine Kontur). */
  strokeWidth: number
  /** Füllfarbe `#rrggbb` (bei Symbolen die Symbolfarbe). */
  fill: string
  /** Deckkraft der Füllung 0..1 (0 = keine Füllung). */
  fillOpacity: number
  /** Eckenrundung des Rechtecks, Anteil der kürzeren Seite [0, 0.5]. */
  radius: number
  animation: GraphicAnimation
}

export interface GraphicOverlay extends GraphicData {
  id: number
}

export const MAX_GRAPHICS = 50
export const MIN_GRAPHIC_SIZE = 0.02
export const MAX_GRAPHIC_W = 2
export const MAX_GRAPHIC_H = 1
export const MAX_STROKE = 0.05
/** Linien brauchen eine sichtbare Stärke. */
export const MIN_LINE_STROKE = 0.002
export const MIN_GRAPHIC_DURATION = 0.2
export const MAX_EMOJI_LENGTH = 16

/** Hat diese Art eine eigene Höhe (sonst quadratisch bzw. Linie)? */
export function hasHeight(kind: GraphicKind): boolean {
  return kind === 'rect' || kind === 'ellipse' || kind === 'bubble'
}
/** Kann diese Art gefüllt werden? */
export function hasFill(kind: GraphicKind): boolean {
  return hasHeight(kind) || kind === 'symbol'
}
/** Hat diese Art einstellbare Farben/Kontur? */
export function hasColors(kind: GraphicKind): boolean {
  return kind !== 'emoji'
}

/** Standardwerte je Art (Position/Zeit setzt der Store). */
export function defaultGraphic(kind: GraphicKind): Omit<GraphicData, 'start' | 'end' | 'x' | 'y'> {
  const base = {
    kind,
    symbol: 'check' as GraphicSymbol,
    emoji: '👉',
    w: 0.3,
    h: 0.3,
    rotation: 0,
    stroke: '#ff3b30',
    strokeWidth: 0.008,
    fill: '#ffcc00',
    fillOpacity: 0,
    radius: 0.12,
    animation: 'fade' as GraphicAnimation,
  }
  switch (kind) {
    case 'rect':
      return { ...base, w: 0.45, h: 0.25 }
    case 'ellipse':
      return base
    case 'bubble':
      return {
        ...base,
        w: 0.5,
        h: 0.24,
        stroke: '#1f2937',
        strokeWidth: 0.005,
        fill: '#ffffff',
        fillOpacity: 1,
      }
    case 'line':
    case 'arrow':
      return { ...base, w: 0.35, strokeWidth: 0.012 }
    case 'symbol':
      return {
        ...base,
        w: 0.16,
        fill: '#34c759',
        fillOpacity: 1,
        stroke: '#ffffff',
        strokeWidth: 0.006,
      }
    case 'emoji':
      return { ...base, w: 0.16 }
    default: {
      const never: never = kind
      throw new Error(`Unbekannte Grafik: ${String(never)}`)
    }
  }
}

/** Werte in gültige Bereiche bringen (Store + vor dem Senden). */
export function clampGraphic<T extends GraphicData>(g: T): T {
  const c = (v: number, lo: number, hi: number) =>
    Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo
  const isLine = g.kind === 'line' || g.kind === 'arrow'
  let rot = Number.isFinite(g.rotation) ? g.rotation % 360 : 0
  if (rot > 180) rot -= 360
  if (rot <= -180) rot += 360
  return {
    ...g,
    x: c(g.x, 0, 1),
    y: c(g.y, 0, 1),
    w: c(g.w, MIN_GRAPHIC_SIZE, MAX_GRAPHIC_W),
    h: c(g.h, MIN_GRAPHIC_SIZE, MAX_GRAPHIC_H),
    rotation: rot,
    strokeWidth: c(g.strokeWidth, isLine ? MIN_LINE_STROKE : 0, MAX_STROKE),
    fillOpacity: c(g.fillOpacity, 0, 1),
    radius: c(g.radius, 0, 0.5),
    start: Math.max(0, Number.isFinite(g.start) ? g.start : 0),
    emoji: Array.from(g.emoji).slice(0, MAX_EMOJI_LENGTH).join(''),
  }
}

/** Ist die Grafik gültig (Zeitbereich im Video, Emoji vorhanden)? */
export function isValidGraphic(g: GraphicData, duration: number): boolean {
  const end = duration > 0 ? Math.min(g.end, duration) : g.end
  if (g.kind === 'emoji' && !g.emoji.trim()) return false
  return end - Math.max(0, g.start) >= MIN_GRAPHIC_DURATION
}

// --- Geometrie ----------------------------------------------------------------

/** Lokale Ausdehnung um den Mittelpunkt (px, vor der Drehung). */
export interface Extent {
  left: number
  right: number
  top: number
  bottom: number
}

/** Pfeilspitze: Länge/halbe Breite relativ zur Linienstärke. */
export function arrowHead(sw: number): { len: number; half: number } {
  return { len: sw * 3.2, half: sw * 2.2 }
}

/** Sprechblasen-Zipfel relativ zur Körperhöhe. */
export const BUBBLE_TAIL = 0.35

/**
 * Ausdehnung einer Grafik (ohne Emoji – dessen Maße kommen aus der Schrift).
 * `H` = Bildhöhe in px.
 */
export function shapeExtent(g: GraphicData, H: number): Extent {
  const sw = g.strokeWidth * H
  const w = g.w * H
  const h = g.h * H
  const box = (hx: number, hy: number): Extent => ({ left: -hx, right: hx, top: -hy, bottom: hy })
  switch (g.kind) {
    case 'rect':
    case 'ellipse':
      return box(w / 2 + sw / 2, h / 2 + sw / 2)
    case 'bubble':
      return { ...box(w / 2 + sw, h / 2 + sw), bottom: h / 2 + h * BUBBLE_TAIL + sw * 2 }
    case 'line':
      return box(w / 2 + sw / 2, sw / 2)
    case 'arrow':
      return box(w / 2 + sw / 2, Math.max(sw / 2, arrowHead(sw).half))
    case 'symbol':
      // Kontur ragt bis zu `sw` über das 24er-Raster hinaus (+ Linien-Symbole).
      return box(w / 2 + sw + (SYMBOL_LINE / 48) * w, w / 2 + sw + (SYMBOL_LINE / 48) * w)
    case 'emoji':
      return box(w / 2, w / 2)
    default: {
      const never: never = g.kind
      throw new Error(`Unbekannte Grafik: ${String(never)}`)
    }
  }
}

/**
 * Bildgröße (px) für eine um `deg` gedrehte Ausdehnung, symmetrisch um den
 * Mittelpunkt (damit der Bildmittelpunkt = Position bleibt). +2 px Rand für
 * Kantenglättung.
 */
export function canvasSize(e: Extent, deg: number): { width: number; height: number } {
  const hx = Math.max(-e.left, e.right)
  const hy = Math.max(-e.top, e.bottom)
  const r = (deg * Math.PI) / 180
  const c = Math.abs(Math.cos(r))
  const s = Math.abs(Math.sin(r))
  const rx = c * hx + s * hy
  const ry = s * hx + c * hy
  // -1e-6: Rundungsrest von cos(90°) soll kein Extra-Pixel ergeben.
  return { width: 2 * Math.ceil(rx - 1e-6) + 4, height: 2 * Math.ceil(ry - 1e-6) + 4 }
}

// --- Zeichnen (Canvas) --------------------------------------------------------

function roundedRectPath(
  ctx: CanvasRenderingContext2D | Path2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2))
  ctx.moveTo(x + rr, y)
  ctx.arcTo(x + w, y, x + w, y + h, rr)
  ctx.arcTo(x + w, y + h, x, y + h, rr)
  ctx.arcTo(x, y + h, x, y, rr)
  ctx.arcTo(x, y, x + w, y, rr)
  ctx.closePath()
}

/** Sprechblase: abgerundeter Körper mit Zipfel unten links, ein Umriss. */
function bubblePath(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const x = -w / 2
  const y = -h / 2
  const r = Math.min(w, h) * 0.3
  const tailX1 = x + w * 0.22
  const tailX2 = x + w * 0.4
  const tipX = x + w * 0.16
  const tipY = h / 2 + h * BUBBLE_TAIL
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.lineTo(tailX2, y + h)
  ctx.lineTo(tipX, tipY)
  ctx.lineTo(tailX1, y + h)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

function fillAndStroke(ctx: CanvasRenderingContext2D, g: GraphicData, sw: number): void {
  if (g.fillOpacity > 0) {
    ctx.globalAlpha = g.fillOpacity
    ctx.fillStyle = g.fill
    ctx.fill()
    ctx.globalAlpha = 1
  }
  if (sw > 0) {
    ctx.lineWidth = sw
    ctx.strokeStyle = g.stroke
    ctx.lineJoin = 'round'
    ctx.stroke()
  }
}

function drawSymbol(ctx: CanvasRenderingContext2D, g: GraphicData, H: number): void {
  const def = GRAPHIC_SYMBOLS[g.symbol] ?? GRAPHIC_SYMBOLS.check
  const size = g.w * H
  const k = size / 24
  const outline = (g.strokeWidth * H) / k // in Raster-Einheiten
  const path = new Path2D(def.path)
  ctx.save()
  ctx.scale(k, k)
  ctx.translate(-12, -12)
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  if (def.stroke) {
    if (outline > 0) {
      ctx.strokeStyle = g.stroke
      ctx.lineWidth = SYMBOL_LINE + outline * 2
      ctx.stroke(path)
    }
    ctx.globalAlpha = Math.max(g.fillOpacity, 0)
    ctx.strokeStyle = g.fill
    ctx.lineWidth = SYMBOL_LINE
    ctx.stroke(path)
  } else {
    if (outline > 0) {
      ctx.strokeStyle = g.stroke
      ctx.lineWidth = outline * 2
      ctx.stroke(path)
    }
    ctx.globalAlpha = Math.max(g.fillOpacity, 0)
    ctx.fillStyle = g.fill
    ctx.fill(path)
  }
  ctx.restore()
}

function drawLine(ctx: CanvasRenderingContext2D, g: GraphicData, H: number): void {
  const sw = g.strokeWidth * H
  const half = (g.w * H) / 2
  ctx.strokeStyle = g.stroke
  ctx.fillStyle = g.stroke
  ctx.lineWidth = sw
  ctx.lineCap = 'round'
  ctx.beginPath()
  if (g.kind === 'arrow') {
    const head = arrowHead(sw)
    const len = Math.min(head.len, half * 2 * 0.6)
    const hw = (head.half * len) / head.len
    ctx.moveTo(-half + sw / 2, 0)
    ctx.lineTo(half - len * 0.8, 0)
    ctx.stroke()
    ctx.beginPath()
    ctx.lineJoin = 'round'
    ctx.moveTo(half, 0)
    ctx.lineTo(half - len, -hw)
    ctx.lineTo(half - len, hw)
    ctx.closePath()
    ctx.fill()
  } else {
    ctx.moveTo(-half + sw / 2, 0)
    ctx.lineTo(half - sw / 2, 0)
    ctx.stroke()
  }
}

/** Emoji-Maße aus der Schrift: Ausdehnung um die optische Mitte. */
function emojiMetrics(
  ctx: CanvasRenderingContext2D,
  g: GraphicData,
  H: number,
): { extent: Extent; dx: number; dy: number; font: string } {
  const px = g.w * H
  const font = `${px}px ${EMOJI_FONT_STACK}`
  ctx.font = font
  const m = ctx.measureText(g.emoji)
  const l = m.actualBoundingBoxLeft || 0
  const r = m.actualBoundingBoxRight || px
  const a = m.actualBoundingBoxAscent || px * 0.8
  const d = m.actualBoundingBoxDescent || px * 0.2
  const hx = (l + r) / 2
  const hy = (a + d) / 2
  // Zeichenstartpunkt so, dass die Glyphen-Mitte im Ursprung liegt.
  return {
    extent: { left: -hx, right: hx, top: -hy, bottom: hy },
    dx: -(r - l) / 2,
    dy: (a - d) / 2,
    font,
  }
}

/**
 * Zeichnet eine Grafik für eine Bildhöhe `H` (px) auf ein neues Canvas.
 * Das Canvas ist um die Position zentriert: linke obere Ecke im Video =
 * (x·W − width/2, y·H − height/2), genau wie auf dem Server.
 */
export function renderGraphic(g: GraphicData, H: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  const ctx0 = canvas.getContext('2d')
  if (!ctx0) throw new Error('Canvas nicht verfügbar.')
  const emoji = g.kind === 'emoji' ? emojiMetrics(ctx0, g, H) : null
  const extent = emoji ? emoji.extent : shapeExtent(g, H)
  const size = canvasSize(extent, g.rotation)
  canvas.width = size.width
  canvas.height = size.height
  const ctx = canvas.getContext('2d')!
  ctx.translate(size.width / 2, size.height / 2)
  ctx.rotate((g.rotation * Math.PI) / 180)
  const sw = g.strokeWidth * H
  switch (g.kind) {
    case 'rect': {
      const w = g.w * H
      const h = g.h * H
      ctx.beginPath()
      roundedRectPath(ctx, -w / 2, -h / 2, w, h, g.radius * Math.min(w, h))
      fillAndStroke(ctx, g, sw)
      break
    }
    case 'ellipse':
      ctx.beginPath()
      ctx.ellipse(0, 0, (g.w * H) / 2, (g.h * H) / 2, 0, 0, Math.PI * 2)
      fillAndStroke(ctx, g, sw)
      break
    case 'bubble':
      bubblePath(ctx, g.w * H, g.h * H)
      fillAndStroke(ctx, g, sw)
      break
    case 'line':
    case 'arrow':
      drawLine(ctx, g, H)
      break
    case 'symbol':
      drawSymbol(ctx, g, H)
      break
    case 'emoji':
      ctx.font = emoji!.font
      ctx.textAlign = 'left'
      ctx.textBaseline = 'alphabetic'
      ctx.fillText(g.emoji, emoji!.dx, emoji!.dy)
      break
    default: {
      const never: never = g.kind
      throw new Error(`Unbekannte Grafik: ${String(never)}`)
    }
  }
  return canvas
}

/** Alles, was das Aussehen (das Bild) bestimmt – Schlüssel für den Bild-Cache. */
export function lookKey(g: GraphicData, H: number): string {
  return [
    H,
    g.kind,
    g.symbol,
    g.emoji,
    g.w,
    g.h,
    g.rotation,
    g.stroke,
    g.strokeWidth,
    g.fill,
    g.fillOpacity,
    g.radius,
  ].join('|')
}

// --- Animation (Vorschau, identisch mit den FFmpeg-Filtern des Servers) ------

export interface GraphicFrame {
  visible: boolean
  opacity: number
  /** Vertikaler Versatz als Anteil der Bildhöhe (in px gerundet wie der Server). */
  dy: number
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

export function graphicFrame(g: GraphicData, t: number): GraphicFrame {
  if (!(t >= g.start && t < g.end)) return { visible: false, opacity: 0, dy: 0 }
  const dur = g.end - g.start
  const ms = (t - g.start) * 1000
  const left = (g.end - t) * 1000
  const f = fadeMs(dur)
  const m = moveMs(dur)
  const fadeOut = f > 0 ? clamp01(left / f) : 1
  switch (g.animation) {
    case 'none':
      return { visible: true, opacity: 1, dy: 0 }
    case 'fade':
      return { visible: true, opacity: Math.min(f > 0 ? clamp01(ms / f) : 1, fadeOut), dy: 0 }
    case 'slide':
      return {
        visible: true,
        opacity: Math.min(m > 0 ? clamp01(ms / m) : 1, fadeOut),
        dy: SLIDE_OFFSET * (m > 0 ? Math.max(0, 1 - ms / m) : 0),
      }
    default: {
      const never: never = g.animation
      throw new Error(`Unbekannte Animation: ${String(never)}`)
    }
  }
}

// --- Server ---------------------------------------------------------------------

/** Datenformat für den Server (POST /api/text, Feld `graphics`). */
export interface ServerGraphic {
  png: string
  x: number
  y: number
  start: number
  end: number
  animation: GraphicAnimation
}

/** Zeichnet die Grafik für die Videohöhe `H` und verpackt sie für den Server. */
export function toServerGraphic(g: GraphicOverlay, H: number): ServerGraphic {
  const r = (v: number, d = 4) => Math.round(v * 10 ** d) / 10 ** d
  const c = clampGraphic(g)
  return {
    png: renderGraphic(c, H).toDataURL('image/png'),
    x: r(c.x),
    y: r(c.y),
    start: r(c.start, 3),
    end: r(c.end, 3),
    animation: c.animation,
  }
}
