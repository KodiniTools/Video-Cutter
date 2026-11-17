import { ValidationError } from './validate'
import { fadeMs, moveMs, parseAnimSpeed, SLIDE_OFFSET } from './textOverlay'

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

export const GRAPHIC_ANIMATIONS = ['none', 'fade', 'slide', 'pop'] as const
export type GraphicAnimation = (typeof GRAPHIC_ANIMATIONS)[number]

/**
 * Dauer-Animationen, solange die Grafik sichtbar ist (Zeit ab ihrem Start).
 * Konstanten identisch mit dem Frontend (src/lib/graphicOverlay.ts).
 */
export const GRAPHIC_LOOPS = ['none', 'pulse', 'wobble', 'spin', 'float', 'blink'] as const
export type GraphicLoop = (typeof GRAPHIC_LOOPS)[number]
/** Pulsieren: Größe 1 … 1+Amplitude, Periode in s. */
export const PULSE_PERIOD = 1
export const PULSE_AMOUNT = 0.12
/** Wackeln: ±Grad, Periode in s. */
export const WOBBLE_PERIOD = 0.8
export const WOBBLE_DEG = 10
/** Drehen: eine Umdrehung (im Uhrzeigersinn) je Periode in s. */
export const SPIN_PERIOD = 3
/** Schweben: Auf und Ab um ±Anteil der Bildhöhe, Periode in s. */
export const FLOAT_PERIOD = 2
export const FLOAT_AMOUNT = 0.015
/** Blinken: sichtbar im ersten Anteil jeder Periode. */
export const BLINK_PERIOD = 1
export const BLINK_ON = 0.6
/** Aufploppen: Größe 0,4 -> 1,12 -> 1 (wie bei Texten). */
export const POP_FROM = 0.4
export const POP_PEAK = 1.12

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
  loop: GraphicLoop
  /** Tempo von Ein-/Ausblenden und Dauer-Animation (Faktor 0,25–4). */
  animSpeed: number
  /**
   * Bewegung über Keyframes (Timeline-Editor): fertige FFmpeg-Ausdrücke in `t`
   * für die Mitte (Anteil 0…1 des Bildes) und optional die Größe (Faktor).
   * Ersetzt `x`/`y`.
   */
  motion?: { x: string; y: string; scale?: string }
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
    // Fehlt bei älteren Clients -> keine Dauer-Animation.
    const loop = item.loop ?? 'none'
    if (typeof loop !== 'string' || !(GRAPHIC_LOOPS as readonly string[]).includes(loop)) {
      throw new ValidationError(`Ungültige Dauer-Animation von Grafik ${n}.`)
    }
    return {
      ...img,
      x: clamp(num(item.x, `Position von Grafik ${n}`), 0, 1),
      y: clamp(num(item.y, `Position von Grafik ${n}`), 0, 1),
      start,
      end,
      animation: animation as GraphicAnimation,
      loop: loop as GraphicLoop,
      animSpeed: parseAnimSpeed(item.animSpeed, `Tempo von Grafik ${n}`),
    }
  })
}

/** Rand (s) um den sichtbaren Bereich, in dem Drehen/Skalieren aktiv sind. */
const LIVE_MARGIN = 0.1

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

/** Seitenlänge des Quadrats, in dem sich ein w×h-Bild frei drehen kann. */
export function rotationBox(width: number, height: number): number {
  return Math.ceil(Math.hypot(width, height))
}

/**
 * Filterkette für eine Grafik: Eingang `[in]` (Video), Grafik-Eingang
 * `[k:v]`, Ausgang `[out]`. Ein-/Ausblenden über den Alphakanal des
 * wiederholten Standbilds, Hereingleiten über einen zeitabhängigen y-Wert –
 * Zeiten wie bei den Texten (fadeMs/moveMs, linear).
 * Aufploppen/Pulsieren skalieren das Standbild je Bild (`scale`, eval=frame,
 * zentriert über overlay_w/overlay_h), Wackeln/Drehen drehen es um seinen
 * Mittelpunkt (`rotate` in einem festen Quadrat), Schweben bewegt y,
 * Blinken blendet über `enable` aus. Ohne diese Animationen entsteht exakt
 * die bisherige Filterkette.
 */
export function graphicFilter(
  g: Omit<GraphicOverlay, 'png'>,
  inputIndex: number,
  inLabel: string,
  outLabel: string,
  frameW: number,
  frameH: number,
  /**
   * Zusätzliche Filter direkt hinter dem Eingang (Timeline-Editor: Zeit
   * verschieben, auf Vorschaugröße bringen). `g.width`/`g.height` nennen dann
   * die Maße **nach** diesen Filtern.
   */
  pre: readonly string[] = [],
): string {
  const dur = g.end - g.start
  const sp = g.animSpeed ?? 1
  const f = fadeMs(dur, sp) / 1000
  const m = moveMs(dur, sp) / 1000
  /** Periode einer Dauer-Animation beim gewählten Tempo (s). */
  const per = (base: number) => String(Math.round((base / sp) * 1e4) / 1e4)
  const loop = g.loop ?? 'none'
  const st = f3(g.start)
  const u = `(t-${st})`
  const src = [`[${inputIndex}:v]format=rgba`, ...pre]
  let fadeIn = 0
  /** Zusätzlicher y-Versatz in px (Ausdruck) – Hereingleiten/Schweben. */
  const yParts: string[] = []
  /** Skalierungsfaktoren (Ausdrücke) – Aufploppen/Pulsieren. */
  const scales: string[] = []
  switch (g.animation) {
    case 'none':
      break
    case 'fade':
      fadeIn = f
      break
    case 'slide': {
      fadeIn = m
      const dy = Math.round(SLIDE_OFFSET * frameH)
      if (m > 0) yParts.push(`${dy}*max(0,1-${u}/${f3(m)})`)
      break
    }
    case 'pop': {
      const mMs = Math.round(m * 1000)
      fadeIn = Math.round(mMs / 2) / 1000
      const a = Math.round(mMs * 0.6) / 1000
      if (m > 0) {
        // Linear 0,4 -> 1,12 (bis a), dann 1,12 -> 1 (bis m), wie libass \t.
        const up =
          a > 0
            ? `${POP_FROM}+${f3(POP_PEAK - POP_FROM)}*min(1,max(0,${u}/${f3(a)}))`
            : `${POP_PEAK}`
        const down =
          m > a ? `${POP_PEAK}-${f3(POP_PEAK - 1)}*min(1,max(0,(${u}-${f3(a)})/${f3(m - a)}))` : '1'
        scales.push(`if(lt(${u},${f3(a)}),${up},${down})`)
      }
      break
    }
    default: {
      const never: never = g.animation
      throw new Error(`Unbekannte Animation: ${String(never)}`)
    }
  }
  let angle = ''
  let blink = ''
  switch (loop) {
    case 'none':
      break
    case 'pulse':
      scales.push(`(1+${PULSE_AMOUNT / 2}*(1-cos(2*PI*${u}/${per(PULSE_PERIOD)})))`)
      break
    case 'wobble':
      angle = `${Math.round(((WOBBLE_DEG * Math.PI) / 180) * 1e4) / 1e4}*sin(2*PI*${u}/${per(WOBBLE_PERIOD)})`
      break
    case 'spin':
      angle = `2*PI*${u}/${per(SPIN_PERIOD)}`
      break
    case 'float':
      yParts.push(`-${f3(FLOAT_AMOUNT * frameH)}*sin(2*PI*${u}/${per(FLOAT_PERIOD)})`)
      break
    case 'blink':
      blink = `*lt(mod(${u},${per(BLINK_PERIOD)}),${per(BLINK_PERIOD * BLINK_ON)})`
      break
    default: {
      const never: never = loop
      throw new Error(`Unbekannte Dauer-Animation: ${String(never)}`)
    }
  }
  if (g.animation !== 'none') {
    if (fadeIn > 0) src.push(`fade=t=in:st=${st}:d=${f3(fadeIn)}:alpha=1`)
    if (f > 0) src.push(`fade=t=out:st=${f3(g.end - f)}:d=${f3(f)}:alpha=1`)
  }
  // Drehen/Skalieren nur rund um den sichtbaren Bereich – sonst liefe es für
  // jedes Bild des ganzen Videos (große Fotos: spürbar langsamer). Außerhalb
  // ist die Grafik ohnehin ausgeblendet (overlay enable).
  const live = `between(t,${f3(g.start - LIVE_MARGIN)},${f3(g.end + LIVE_MARGIN)})`
  // Drehen in einem festen Quadrat (Diagonale), damit nichts abgeschnitten
  // wird; transparent gefüllt (c=none ließe alte Bildreste stehen).
  let w = g.width
  let h = g.height
  if (angle) {
    const box = rotationBox(g.width, g.height)
    src.push(`rotate=a='${angle}':ow=${box}:oh=${box}:c=black@0:enable='${live}'`)
    w = box
    h = box
  }
  if (g.motion?.scale) scales.push(`(${g.motion.scale})`)
  if (scales.length) {
    const s = `if(${live},${scales.join('*')},1)`
    src.push(`scale=w='max(1,trunc(iw*${s}))':h='max(1,trunc(ih*${s}))':eval=frame`)
  }
  const extraY = yParts.map((p) => (p.startsWith('-') ? p : `+${p}`)).join('')
  let x: string
  let y: string
  if (g.motion) {
    // Mitte je Bild aus den Keyframes; bei wechselnder Größe über overlay_w/h.
    const halfW = scales.length ? 'overlay_w/2' : f3(w / 2)
    const halfH = scales.length ? 'overlay_h/2' : f3(h / 2)
    x = `'round((${g.motion.x})*${frameW}-${halfW})'`
    y = `'round((${g.motion.y})*${frameH}-${halfH}${extraY})'`
  } else if (scales.length) {
    // Größe ändert sich je Bild: Mittelpunkt über die aktuelle Grafikgröße.
    x = `'${f3(g.x * frameW)}-overlay_w/2'`
    y = `'${f3(g.y * frameH)}-overlay_h/2${extraY}'`
  } else {
    const { left, top } = graphicTopLeft({ ...g, width: w, height: h }, frameW, frameH)
    x = String(left)
    y = extraY ? `'${top}${extraY}'` : String(top)
  }
  const gLabel = `[g${inputIndex}]`
  // Bildgenau wie die Vorschau (start <= t < end): Der Client rundet Bildzeiten
  // auf ganze ms (29,97 fps: 3,2032 s -> 3,203 s, aber auch 3,2366 -> 3,237).
  // 1 ms Toleranz gleicht das aus und ist viel kleiner als ein Bildabstand.
  const from = f3(g.start - FRAME_TOLERANCE)
  const to = f3(g.end - FRAME_TOLERANCE)
  return (
    `${src.join(',')}${gLabel};` +
    `${inLabel}${gLabel}overlay=x=${x}:y=${y}` +
    `:enable='gte(t,${from})*lt(t,${to})${blink}':shortest=1${outLabel}`
  )
}

/**
 * Eingabe-Argumente für die Grafiken (je Grafik ein wiederholtes Standbild).
 * `durationSec` begrenzt die Wiederholung (0 = unbekannt, dann nur über
 * `shortest=1` im overlay-Filter).
 */
export function graphicInputArgs(paths: string[], durationSec: number, fps = 0): string[] {
  const limit = durationSec > 0 ? ['-t', f3(durationSec + 1)] : []
  const rate = graphicFps(fps)
  return paths.flatMap((p) => ['-loop', '1', '-framerate', rate, ...limit, '-i', p])
}

/**
 * Bildrate der Grafik-Standbilder: die des Videos (bekannt und sinnvoll),
 * damit jedes Videobild ein eigenes Grafikbild mit derselben Zeit bekommt –
 * Animationen treffen dann dieselben Zeitpunkte wie die Vorschau. Sonst 30.
 */
export function graphicFps(fps: number): string {
  // Volle Genauigkeit: FFmpeg macht aus 29.97002997… wieder exakt 30000/1001.
  if (Number.isFinite(fps) && fps >= 1 && fps <= 120) return String(fps)
  return String(GRAPHIC_FPS)
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
