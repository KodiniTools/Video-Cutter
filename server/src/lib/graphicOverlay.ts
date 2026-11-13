import { ValidationError } from './validate'
import { fadeMs, moveMs, SLIDE_OFFSET } from './textOverlay'

/**
 * Grafik-Einblendungen (Formen, Linien, Pfeile, Symbole, Emojis, Bilder).
 *
 * Der Browser zeichnet jede Grafik selbst als PNG (Canvas) – dasselbe Bild,
 * das er auch als Vorschau zeigt. Der Server prüft die PNGs und legt sie mit
 * dem FFmpeg-Filter `overlay` an die gewünschte Stelle (Mittelpunkt x/y),
 * sichtbar im Zeitbereich, optional mit Ein-/Ausblenden bzw. Hereingleiten.
 * Dadurch stimmen Vorschau und Ergebnis pixelgenau überein, und farbige Emojis
 * brauchen auf dem Server keine eigene Emoji-Schrift.
 */

export const GRAPHIC_ANIMATIONS = ['none', 'fade', 'slide'] as const
export type GraphicAnimation = (typeof GRAPHIC_ANIMATIONS)[number]

export const MAX_GRAPHICS = 50
/** Größte einzelne PNG-Datei (Bytes, dekodiert) – Fotos in voller Bildgröße. */
export const MAX_GRAPHIC_BYTES = 16 * 1024 * 1024
/** Alle PNGs eines Auftrags zusammen (Bytes, dekodiert). */
export const MAX_GRAPHICS_TOTAL_BYTES = 48 * 1024 * 1024
/** Größte Kantenlänge eines PNGs in Pixeln. */
export const MAX_GRAPHIC_DIM = 8192
export const MIN_GRAPHIC_DURATION = 0.2
/** Bildrate, mit der ein Standbild für Überblendungen wiederholt wird. */
export const GRAPHIC_FPS = 30

/** Eine geprüfte Grafik (Zeiten in Sekunden, Mittelpunkt als Anteil). */
export interface GraphicOverlay {
  png: Buffer
  /** Pixelmaße aus dem PNG-Kopf. */
  width: number
  height: number
  x: number
  y: number
  start: number
  end: number
  animation: GraphicAnimation
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** Breite/Höhe aus dem IHDR-Block; `null` = kein gültiger PNG-Kopf. */
export function pngSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 33 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null
  if (buf.toString('latin1', 12, 16) !== 'IHDR') return null
  const width = buf.readUInt32BE(16)
  const height = buf.readUInt32BE(20)
  if (!(width > 0 && height > 0)) return null
  return { width, height }
}

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

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

const DATA_URL_PREFIX = 'data:image/png;base64,'
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/

/** PNG aus Base64 (mit oder ohne `data:`-Präfix) dekodieren und prüfen. */
function decodePng(v: unknown, n: number): { png: Buffer; width: number; height: number } {
  if (typeof v !== 'string') throw new ValidationError(`Grafik ${n} ist ungültig.`)
  const b64 = v.startsWith(DATA_URL_PREFIX) ? v.slice(DATA_URL_PREFIX.length) : v
  // Vorab-Grenze (Base64 = 4/3 der Bytes), damit nichts Riesiges dekodiert wird.
  if (b64.length > Math.ceil((MAX_GRAPHIC_BYTES * 4) / 3) + 4) {
    throw new ValidationError(`Grafik ${n} ist zu groß.`)
  }
  if (!BASE64_RE.test(b64)) throw new ValidationError(`Grafik ${n} ist ungültig.`)
  const png = Buffer.from(b64, 'base64')
  const size = pngSize(png)
  if (!size) throw new ValidationError(`Grafik ${n} ist kein PNG-Bild.`)
  if (size.width > MAX_GRAPHIC_DIM || size.height > MAX_GRAPHIC_DIM) {
    throw new ValidationError(`Grafik ${n} ist zu groß.`)
  }
  return { png, ...size }
}

/**
 * Validiert die Grafik-Liste. Fehlt sie (undefined/null), ist das Ergebnis
 * leer. Zeiten werden auf die Videodauer begrenzt.
 */
export function parseGraphicOverlays(raw: unknown, videoDuration: number): GraphicOverlay[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw new ValidationError('Ungültige Grafikliste.')
  if (raw.length > MAX_GRAPHICS) {
    throw new ValidationError(`Maximal ${MAX_GRAPHICS} Grafiken pro Video.`)
  }
  const total = Number.isFinite(videoDuration) && videoDuration > 0 ? videoDuration : Infinity
  let bytes = 0
  return raw.map((item, i) => {
    const n = i + 1
    if (!isRecord(item)) throw new ValidationError(`Grafik ${n} ist ungültig.`)
    const img = decodePng(item.png, n)
    bytes += img.png.length
    if (bytes > MAX_GRAPHICS_TOTAL_BYTES) {
      throw new ValidationError('Die Grafiken sind zusammen zu groß.')
    }
    const start = Math.max(0, num(item.start, `Start von Grafik ${n}`))
    const end = Math.min(total, num(item.end, `Ende von Grafik ${n}`))
    if (!(end - start >= MIN_GRAPHIC_DURATION)) {
      throw new ValidationError(`Grafik ${n}: Ende muss nach dem Start liegen (im Video).`)
    }
    const animation = item.animation
    if (
      typeof animation !== 'string' ||
      !(GRAPHIC_ANIMATIONS as readonly string[]).includes(animation)
    ) {
      throw new ValidationError(`Ungültige Animation von Grafik ${n}.`)
    }
    return {
      ...img,
      x: clamp(num(item.x, `Position von Grafik ${n}`), 0, 1),
      y: clamp(num(item.y, `Position von Grafik ${n}`), 0, 1),
      start,
      end,
      animation: animation as GraphicAnimation,
    }
  })
}

/** Ausgleich der ms-Rundung von Bildzeiten im Client (Sekunden). */
const FRAME_TOLERANCE = 0.001

/** Zahl für Filter-Ausdrücke: höchstens 3 Nachkommastellen, ohne Exponent. */
function f3(v: number): string {
  return String(Math.round(v * 1000) / 1000)
}

/** Linke obere Ecke in Pixeln (identisch mit der Vorschau-Berechnung). */
export function graphicTopLeft(
  g: Pick<GraphicOverlay, 'x' | 'y' | 'width' | 'height'>,
  frameW: number,
  frameH: number,
): { left: number; top: number } {
  return {
    left: Math.round(g.x * frameW - g.width / 2),
    top: Math.round(g.y * frameH - g.height / 2),
  }
}

/**
 * Filterkette für eine Grafik: Eingang `[in]` (Video), Grafik-Eingang
 * `[k:v]`, Ausgang `[out]`. Ein-/Ausblenden über den Alphakanal des
 * wiederholten Standbilds, Hereingleiten über einen zeitabhängigen y-Wert –
 * Zeiten wie bei den Texten (fadeMs/moveMs, linear).
 */
export function graphicFilter(
  g: GraphicOverlay,
  inputIndex: number,
  inLabel: string,
  outLabel: string,
  frameW: number,
  frameH: number,
): string {
  const dur = g.end - g.start
  const f = fadeMs(dur) / 1000
  const m = moveMs(dur) / 1000
  const { left, top } = graphicTopLeft(g, frameW, frameH)
  const src = [`[${inputIndex}:v]format=rgba`]
  let fadeIn = 0
  let y = String(top)
  switch (g.animation) {
    case 'none':
      break
    case 'fade':
      fadeIn = f
      break
    case 'slide': {
      fadeIn = m
      const dy = Math.round(SLIDE_OFFSET * frameH)
      if (m > 0) y = `'${top}+${dy}*max(0,1-(t-${f3(g.start)})/${f3(m)})'`
      break
    }
    default: {
      const never: never = g.animation
      throw new Error(`Unbekannte Animation: ${String(never)}`)
    }
  }
  if (g.animation !== 'none') {
    if (fadeIn > 0) src.push(`fade=t=in:st=${f3(g.start)}:d=${f3(fadeIn)}:alpha=1`)
    if (f > 0) src.push(`fade=t=out:st=${f3(g.end - f)}:d=${f3(f)}:alpha=1`)
  }
  const gLabel = `[g${inputIndex}]`
  // Bildgenau wie die Vorschau (start <= t < end): Der Client rundet Bildzeiten
  // auf ganze ms (29,97 fps: 3,2032 s -> 3,203 s, aber auch 3,2366 -> 3,237).
  // 1 ms Toleranz gleicht das aus und ist viel kleiner als ein Bildabstand.
  const from = f3(g.start - FRAME_TOLERANCE)
  const to = f3(g.end - FRAME_TOLERANCE)
  return (
    `${src.join(',')}${gLabel};` +
    `${inLabel}${gLabel}overlay=x=${left}:y=${y}` +
    `:enable='gte(t,${from})*lt(t,${to})':shortest=1${outLabel}`
  )
}

/**
 * Eingabe-Argumente für die Grafiken (je Grafik ein wiederholtes Standbild).
 * `durationSec` begrenzt die Wiederholung (0 = unbekannt, dann nur über
 * `shortest=1` im overlay-Filter).
 */
export function graphicInputArgs(paths: string[], durationSec: number): string[] {
  const limit = durationSec > 0 ? ['-t', f3(durationSec + 1)] : []
  return paths.flatMap((p) => ['-loop', '1', '-framerate', String(GRAPHIC_FPS), ...limit, '-i', p])
}

/**
 * Komplette `-filter_complex`-Kette: erst alle Grafiken (Eingänge 1..n) über
 * das Video (Eingang 0), danach optional die Texte (`textFilter`, z. B. der
 * ass-Filter) – so liegen Texte über Formen (Text in Sprechblasen). Ausgang
 * `[vout]` immer als yuv420p.
 */
export function buildGraphicsFilterComplex(
  graphics: GraphicOverlay[],
  frameW: number,
  frameH: number,
  textFilter?: string,
): string {
  if (!(frameW > 0 && frameH > 0)) throw new ValidationError('Auflösung des Videos unbekannt.')
  const parts: string[] = []
  let label = '[0:v]'
  graphics.forEach((g, i) => {
    const out = `[v${i + 1}]`
    parts.push(graphicFilter(g, i + 1, label, out, frameW, frameH))
    label = out
  })
  // textFilter endet bereits mit format=yuv420p (siehe buildTextFilter).
  parts.push(`${label}${textFilter ?? 'format=yuv420p'}[vout]`)
  return parts.join(';')
}
