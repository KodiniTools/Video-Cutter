import { LOUDNORM_FILTER, PROGRESS, XFADE_TYPES, atempoFilters, buildCropFilter } from '../args'
import { graphicFilter } from '../graphicOverlay'
import { buildAss, escapeFilterPath, type TextOverlay } from '../textOverlay'
import { markerEffectFilters } from './effects'
import {
  MICROS_PER_SECOND,
  clipEnd,
  docDuration,
  type DocAudioClip,
  type DocAudioTrack,
  type DocColor,
  type DocGraphicKey,
  type DocLayoutKey,
  type DocOverlayTrack,
  type DocVideoClip,
  type DocVolumePoint,
  type DocVideoTrack,
  type RenderDoc,
  type Time,
} from './doc'

/**
 * Compiler: übersetzt ein geprüftes Timeline-Dokument (oder einen Abschnitt
 * davon) in **einen** FFmpeg-Aufruf. Vorschau und Export nutzen denselben
 * Code, nur Größe, Abschnitt und Encoder-Einstellungen unterscheiden sich.
 *
 * Aufbau des Filtergraphen:
 *  - Je Spur werden Clips und Lücken zu einem durchgehenden Strom verkettet
 *    (`concat`). Clips einer Spur überlappen sich nie.
 *  - Die unterste sichtbare Video-Spur ist deckend (Lücken = Hintergrund),
 *    höhere Spuren sind in den Lücken durchsichtig und werden per `overlay`
 *    darübergelegt: ein `overlay` je Spur, nicht je Clip.
 *  - Ton-Spuren werden mit `amix` gemischt.
 *  - `hold` an einem Video-Clip füllt die Lücke bis zum nächsten Clip der Spur
 *    mit seinem letzten Bild.
 *  - Übergänge (`transitionIn`) ändern keine Zeiten: `fade` blendet den
 *    vorigen Clip aus und diesen ein; die übrigen laufen am Clip-Anfang über
 *    dem angehaltenen letzten Bild des vorigen Clips (`xfade`).
 *  - Alle Grenzen liegen auf dem Bildraster des Projekts; Längen werden in
 *    ganzen Bildern gezählt, damit Bild und Ton nie auseinanderlaufen.
 */

/** Quelle eines Mediums auf der Platte (vom Aufrufer aus dem MediaStore aufgelöst). */
export interface RenderSource {
  path: string
  hasAudio: boolean
}

/** Hochgeladene Grafik (PNG) auf der Platte, mit ihren Pixelmaßen. */
export interface RenderGraphic {
  path: string
  width: number
  height: number
}

export interface CompileOptions {
  /** Dateien je Asset-ID. Fehlt eine benötigte Quelle, wirft der Compiler. */
  sources: Record<string, RenderSource>
  /**
   * Bilder je Grafik-ID. Grafiken, deren Bild fehlt, werden ausgelassen (der
   * Aufrufer meldet das dem Editor, der das Bild dann erneut hochlädt).
   */
  graphics?: Record<string, RenderGraphic>
  /** Abschnitt der Timeline; Standard: 0 bis zum Ende des letzten Clips. */
  range?: { start: Time; end: Time }
  /** Ausgabegröße (z. B. kleiner für die Vorschau); Standard: Projektgröße. */
  size?: { width: number; height: number }
  /**
   * Lautstärke des fertigen Tons angleichen (EBU R128, -16 LUFS). Nur für den
   * Export des Ganzen sinnvoll: Abschnittsweise angewandt würde jeder Abschnitt
   * für sich geregelt.
   */
  normalizeAudio?: boolean
}

/** Platzhalter im Filter; `buildRenderArgs` setzt die echten Pfade ein. */
export const ASS_PLACEHOLDER = '@@ASS@@'
export const FONTS_PLACEHOLDER = '@@FONTS@@'

export interface CompiledTimeline {
  /** Eingaben (`-ss … -i …`) in der Reihenfolge der Filter-Eingänge. */
  inputs: string[]
  /** Inhalt für `-filter_complex`; Ausgänge heißen `[vout]` und `[aout]`. */
  filter: string
  /**
   * Inhalt der Untertitel-Datei (ASS) für die Texte dieses Stücks, falls es
   * welche gibt. Der Filter verweist darauf über Platzhalter; wer rendert,
   * schreibt die Datei und nennt `buildRenderArgs` ihren Pfad.
   */
  ass?: string
  /** Länge des Ergebnisses in Bildern und Sekunden. */
  frames: number
  duration: number
  width: number
  height: number
  /** Bildrate als FFmpeg-Bruch, z. B. `30` oder `30000/1001`. */
  fps: string
  sampleRate: number
}

export class CompileError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CompileError'
  }
}

interface Rational {
  num: number
  den: number
}

/** Bildrate als Bruch; NTSC-Raten (29,97 usw.) werden exakt als n·1000/1001 erkannt. */
export function fpsRational(fps: number): Rational {
  if (Number.isInteger(fps)) return { num: fps, den: 1 }
  const ntsc = Math.round((fps * 1001) / 1000)
  if (Math.abs((ntsc * 1000) / 1001 - fps) < 0.005) return { num: ntsc * 1000, den: 1001 }
  return { num: Math.round(fps * 1000), den: 1000 }
}

/** Sekunden für FFmpeg: feste Nachkommastellen, keine Exponentialschreibweise. */
function sec(value: number): string {
  return value.toFixed(6)
}

function num(value: number): string {
  return Number(value.toFixed(6)).toString()
}

/**
 * Farbkorrektur als `eq`-Filter. Die Werte −1 … 1 des Editors werden auf
 * brauchbare Bereiche gelegt: Helligkeit ±0,4, Kontrast 0,4–1,6, Sättigung 0–2.
 */
export function colorFilter(c: DocColor): string {
  return (
    `eq=brightness=${num(c.brightness * 0.4)}` +
    `:contrast=${num(1 + c.contrast * 0.6)}` +
    `:saturation=${num(1 + c.saturation)}`
  )
}

/** Ein Stück einer Spur im Abschnitt: Clip oder Lücke, Länge in Bildern. */
type Piece<C> = {
  frames: number
  clip: C | null
  /** Versatz in den Clip hinein (µs). */ offset: Time
}

/**
 * Zerlegt eine Spur im Bereich [f0, f1) in Clips und Lücken auf dem Bildraster.
 * Liefert `null`, wenn kein Clip der Spur in den Bereich fällt.
 */
function pieces<C extends { start: Time; duration: Time }>(
  clips: readonly C[],
  frameOf: (t: Time) => number,
  timeOf: (frame: number) => Time,
  f0: number,
  f1: number,
): Piece<C>[] | null {
  const out: Piece<C>[] = []
  let cursor = f0
  let any = false
  for (const clip of clips) {
    const a = Math.min(f1, Math.max(cursor, frameOf(clip.start)))
    const b = Math.min(f1, Math.max(a, frameOf(clipEnd(clip))))
    if (b <= a) continue
    if (a > cursor) out.push({ frames: a - cursor, clip: null, offset: 0 })
    out.push({ frames: b - a, clip, offset: Math.max(0, timeOf(a) - clip.start) })
    cursor = b
    any = true
  }
  if (!any) return null
  if (cursor < f1) out.push({ frames: f1 - cursor, clip: null, offset: 0 })
  return out
}

/** Kürzeste Blende, die noch gerendert wird. */
const MIN_FADE: Time = 20_000

/**
 * `volume` mit der Lautstärke-Kurve eines Ton-Clips. Der Filter sitzt vor dem
 * Tempo, dort läuft `t` in Quellzeit ab `from` (Sekunden in der Quelle).
 * Zwischen den Punkten linear, davor und dahinter der erste bzw. letzte Wert.
 */
export function envelopeFilter(points: readonly DocVolumePoint[], from: number): string[] {
  if (points.length === 0) return []
  const at = (p: DocVolumePoint) => num(p.at / MICROS_PER_SECOND)
  const T = `(t+${num(from)})`
  let expr = num(points[points.length - 1].gain)
  for (let i = points.length - 2; i >= 0; i--) {
    const a = points[i]
    const b = points[i + 1]
    const slope = num((b.gain - a.gain) / ((b.at - a.at) / MICROS_PER_SECOND))
    expr = `if(lt(${T},${at(b)}),${num(a.gain)}+(${slope})*(${T}-${at(a)}),${expr})`
  }
  expr = `if(lt(${T},${at(points[0])}),${num(points[0].gain)},${expr})`
  return [`volume='${expr}':eval=frame`]
}

/**
 * Ausdruck für einen Wert, der sich zwischen Stützpunkten gleichmäßig ändert;
 * davor und dahinter gilt der erste bzw. letzte Wert. `T` ist der Ausdruck für
 * die Zeit in Sekunden, `points` sind nach Zeit aufsteigend. Mit `smooth`
 * läuft jeder Abschnitt sanft an und bremst ab (3f² − 2f³).
 */
export function piecewiseExpr(
  points: ReadonlyArray<{ at: number; value: number }>,
  T: string,
  smooth = false,
): string {
  if (points.length === 0) return '0'
  let expr = num(points[points.length - 1].value)
  for (let i = points.length - 2; i >= 0; i--) {
    const a = points[i]
    const b = points[i + 1]
    if (a.value === b.value) {
      expr = `if(lt(${T},${num(b.at)}),${num(a.value)},${expr})`
      continue
    }
    let part: string
    if (smooth) {
      const f = `((${T}-${num(a.at)})/${num(b.at - a.at)})`
      part = `${num(a.value)}+(${num(b.value - a.value)})*${f}*${f}*(3-2*${f})`
    } else {
      const slope = num((b.value - a.value) / (b.at - a.at))
      part = `${num(a.value)}+(${slope})*(${T}-${num(a.at)})`
    }
    expr = `if(lt(${T},${num(b.at)}),${part},${expr})`
  }
  return `if(lt(${T},${num(points[0].at)}),${num(points[0].value)},${expr})`
}

/**
 * Bewegung einer Grafik aus ihren Keyframes: Ausdrücke in `t` (Zeit der
 * Timeline) für Mitte und Größe. `start` ist der Clip-Anfang in Sekunden.
 * Bleibt die Größe überall 1, entfällt das Skalieren je Bild.
 */
export function graphicMotion(
  keys: readonly DocGraphicKey[],
  start: number,
  smooth: boolean,
): { x: string; y: string; scale?: string } {
  const T = `(t-${num(start)})`
  const curve = (pick: (k: DocGraphicKey) => number) =>
    keys.every((k) => pick(k) === pick(keys[0]))
      ? num(pick(keys[0]))
      : piecewiseExpr(
          keys.map((k) => ({ at: k.at / MICROS_PER_SECOND, value: pick(k) })),
          T,
          smooth,
        )
  return {
    x: curve((k) => k.x),
    y: curve((k) => k.y),
    ...(keys.some((k) => k.scale !== 1) ? { scale: curve((k) => k.scale) } : {}),
  }
}

/** Vorlauf des Steuersignals beim automatischen Absenken (Sekunden). */
const DUCK_PRIME_SEC = 0.3
/** Kompressor fürs Absenken: spricht ab etwa −34 dB an, lässt über 0,6 s los. */
const DUCK_COMPRESSOR = 'threshold=0.02:ratio=20:attack=20:release=600'

/**
 * `afade` für das Stück eines Ton-Clips, das bei `offset` (Zeit im Clip)
 * beginnt und `length` lang ist. Die Zeitstempel werden dafür auf die Zeit im
 * Clip gesetzt, damit eine Blende über Abschnittsgrenzen der Vorschau hinweg
 * genauso klingt wie im Export. Überschneiden sich beide Blenden, werden sie
 * anteilig gekürzt.
 */
export function clipFadeFilters(clip: DocAudioClip, offset: Time, length: Time): string[] {
  let fin = Math.min(clip.fadeIn?.duration ?? 0, clip.duration)
  let fout = Math.min(clip.fadeOut?.duration ?? 0, clip.duration)
  if (fin + fout > clip.duration) {
    const scale = clip.duration / (fin + fout)
    fin = Math.floor(fin * scale)
    fout = Math.floor(fout * scale)
  }
  const s = (t: Time) => (t / MICROS_PER_SECOND).toFixed(6)
  const fx: string[] = []
  if (clip.fadeIn && fin >= MIN_FADE && offset < fin) {
    fx.push(`afade=t=in:st=0:d=${s(fin)}:curve=${clip.fadeIn.curve}`)
  }
  const outStart = clip.duration - fout
  if (clip.fadeOut && fout >= MIN_FADE && offset + length > outStart) {
    fx.push(`afade=t=out:st=${s(outStart)}:d=${s(fout)}:curve=${clip.fadeOut.curve}`)
  }
  if (fx.length === 0) return []
  return [`asetpts=PTS+${s(offset)}/TB`, ...fx, 'asetpts=PTS-STARTPTS']
}

export function compileTimeline(doc: RenderDoc, opts: CompileOptions): CompiledTimeline {
  const { settings } = doc
  const rate = fpsRational(settings.fps)
  const fps = rate.den === 1 ? String(rate.num) : `${rate.num}/${rate.den}`
  const frameOf = (t: Time): number => Math.round((t * rate.num) / (rate.den * MICROS_PER_SECOND))
  const timeOf = (frame: number): Time =>
    Math.round((frame * rate.den * MICROS_PER_SECOND) / rate.num)
  const secondsOf = (frames: number): number => (frames * rate.den) / rate.num

  const range = opts.range ?? { start: 0, end: docDuration(doc) }
  const f0 = frameOf(Math.max(0, range.start))
  const f1 = frameOf(range.end)
  const frames = f1 - f0
  if (!(frames > 0)) throw new CompileError('Der Abschnitt ist leer.')
  const duration = secondsOf(frames)

  const width = opts.size?.width ?? settings.width
  const height = opts.size?.height ?? settings.height
  const size = `${width}x${height}`
  const background = `0x${settings.background.slice(1)}`
  const sr = settings.sampleRate

  const inputs: string[] = []
  const chains: string[] = []
  let inputCount = 0
  let labelCount = 0
  const label = (prefix: string): string => `${prefix}${labelCount++}`

  const source = (assetId: string): RenderSource => {
    const src = opts.sources[assetId]
    if (!src) throw new CompileError(`Quelle für Medium ${assetId} fehlt.`)
    return src
  }

  /** Eingabe für ein Stück eines Clips; liefert den Index des Eingangs. */
  const addInput = (
    clip: DocVideoClip | DocAudioClip,
    piece: Piece<unknown>,
    av: 'v' | 'a',
  ): number => {
    const src = source(clip.asset)
    const span = secondsOf(piece.frames) * clip.speed
    if (clip.kind === 'still') {
      inputs.push('-loop', '1', '-framerate', fps, '-t', sec(span), '-i', src.path)
    } else {
      const from = (clip.sourceIn + Math.round(piece.offset * clip.speed)) / MICROS_PER_SECOND
      // Etwas Reserve hinter dem Ende: Die genaue Länge schneidet der Filter.
      inputs.push(
        av === 'v' ? '-an' : '-vn',
        '-ss',
        sec(from),
        '-t',
        sec(span + 0.5),
        '-i',
        src.path,
      )
    }
    return inputCount++
  }

  // --- Bild ----------------------------------------------------------------

  const videoTracks = doc.tracks.filter((t): t is DocVideoTrack => t.kind === 'video' && !t.hidden)
  /** Von unten nach oben (im Dokument liegt Index 0 oben). */
  const layers: string[] = []
  for (const track of videoTracks.slice().reverse()) {
    /**
     * Clip, dessen letztes Bild die Lücke am Bild `frame` füllt (`hold`): der
     * letzte Clip davor, sofern danach noch ein Clip folgt.
     */
    const holderAt = (frame: number) => {
      let held: DocVideoClip | undefined
      let next: DocVideoClip | undefined
      for (const c of track.clips) {
        if (frameOf(clipEnd(c)) <= frame) held = c
        else {
          next = c
          break
        }
      }
      // Ein ausgeblendeter Clip hält kein Bild: Es käme nach dem Ausblenden zurück.
      if (!held?.hold || held.fadeOut || !next || frameOf(next.start) <= frame) return null
      return { clip: held, next, start: frameOf(clipEnd(held)), end: frameOf(next.start) }
    }
    const parts =
      pieces(track.clips, frameOf, timeOf, f0, f1) ??
      // Der ganze Abschnitt liegt in einer gehaltenen Lücke.
      (holderAt(f0) ? [{ frames, clip: null, offset: 0 }] : null)
    if (!parts) continue
    // Ein verkleinerter oder durchscheinender Clip braucht den Hintergrund
    // unter sich: Liegt er auf der untersten Spur, kommt der zuerst.
    if (layers.length === 0 && track.clips.some((c) => c.layout)) {
      const base = label('base')
      chains.push(
        `color=c=${background}:s=${size}:r=${fps},format=yuv420p,trim=end_frame=${frames}[${base}]`,
      )
      layers.push(base)
    }
    const opaque = layers.length === 0
    const format = opaque ? 'yuv420p' : 'yuva420p'
    const fill = opaque ? background : 'black@0'
    const labels: string[] = []
    /**
     * Clip ins Projektformat bringen (ohne Längenschnitt). `offset` ist die
     * Zeit im Clip, bei der das erste Bild der Eingabe liegt (für Keyframes).
     */
    const fitSteps = (clip: DocVideoClip, offset: Time): string[] => {
      const head = [
        clip.kind === 'still' || clip.speed === 1
          ? 'setpts=PTS-STARTPTS'
          : `setpts=(PTS-STARTPTS)/${num(clip.speed)}`,
        `fps=${fps}`,
        ...(clip.crop ? [buildCropFilter(clip.crop)] : []),
        ...(clip.color ? [colorFilter(clip.color)] : []),
      ]
      const l = clip.layout
      if (!l) {
        return [
          ...head,
          `scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2`,
          `format=${format}`,
          `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=${fill}`,
          'setsar=1',
        ]
      }
      if (l.keys) {
        // Keyframes: Größe und Mitte je Bild berechnen. Die Zeit beginnt beim
        // ersten Bild der Eingabe; die Keyframes stehen in Quellzeit.
        const keys = l.keys
        const speed = clip.kind === 'still' ? 1 : clip.speed
        const sourceTime = (t: string) =>
          `(${num(clip.sourceIn / MICROS_PER_SECOND)}` +
          `+(${t}+${num(offset / MICROS_PER_SECOND)})*${num(speed)})`
        const curve = (pick: (k: DocLayoutKey) => number, t = 't') =>
          piecewiseExpr(
            keys.map((k) => ({ at: k.at / MICROS_PER_SECOND, value: pick(k) })),
            sourceTime(t),
            l.ease === 'smooth',
          )
        const S = curve((k) => k.scale)
        const pip = label('pip')
        const canvas = label('cv')
        const fixedOpacity = keys.every((k) => k.opacity === keys[0].opacity)
        const steps = [
          ...head,
          `scale=w='2*round(${width}*(${S})/2)':h='2*round(${height}*(${S})/2)'` +
            ':force_original_aspect_ratio=decrease:force_divisible_by=2:eval=frame',
          'format=yuva420p',
          ...(fixedOpacity && keys[0].opacity < 1 ? [`lut=a=val*${num(keys[0].opacity)}`] : []),
          // Das wechselnd große Bild liegt auf einer durchsichtigen Fläche im
          // Projektformat; dieser Schritt schließt die Kette und öffnet die nächste.
          `setsar=1[${pip}];` +
            `color=c=black@0:s=${size}:r=${fps},format=yuva420p[${canvas}];` +
            `[${canvas}][${pip}]overlay=` +
            `x='max(0,min(W-w,(${curve((k) => k.x)})*W-w/2))':` +
            `y='max(0,min(H-h,(${curve((k) => k.y)})*H-h/2))':` +
            'format=auto:shortest=1:eval=frame',
          'setsar=1',
        ]
        if (fixedOpacity) return steps
        // Wechselnde Deckkraft: Die Transparenz der Fläche wird je Bild mit
        // einer einfarbigen Maske multipliziert. Die Maske entsteht winzig
        // (dort rechnet `geq` je Bild nur 16×16 Punkte) und wird vergrößert.
        const color = label('kc')
        const alpha = label('ka')
        const mask = label('km')
        const dimmed = label('kd')
        return [
          ...steps,
          `split[${color}][${alpha}];` +
            `color=c=black:s=16x16:r=${fps},format=gray,` +
            `geq=lum='255*(${curve((k) => k.opacity, 'T')})',` +
            `scale=${width}:${height}:flags=neighbor[${mask}];` +
            `[${alpha}]alphaextract[${alpha}x];` +
            `[${alpha}x][${mask}]blend=all_mode=multiply:shortest=1[${dimmed}];` +
            `[${color}][${dimmed}]alphamerge`,
        ]
      }
      // Bild-in-Bild: in den verkleinerten Rahmen einpassen, um die Mitte
      // (x, y) legen (ganz im Bild), der Rest bleibt durchsichtig.
      const boxW = Math.max(2, Math.round((width * l.scale) / 2) * 2)
      const boxH = Math.max(2, Math.round((height * l.scale) / 2) * 2)
      return [
        ...head,
        `scale=${boxW}:${boxH}:force_original_aspect_ratio=decrease:force_divisible_by=2`,
        'format=yuva420p',
        ...(l.opacity < 1 ? [`lut=a=val*${num(l.opacity)}`] : []),
        `pad=${width}:${height}:` +
          `'max(0,min(ow-iw,${num(l.x)}*ow-iw/2))':'max(0,min(oh-ih,${num(l.y)}*oh-ih/2))'` +
          ':color=black@0',
        'setsar=1',
      ]
    }
    /** Auf genau `count` Bilder bringen; endet die Quelle zu früh, hält das letzte Bild. */
    const lengthSteps = (count: number): string[] => [
      `tpad=stop_mode=clone:stop_duration=${sec(secondsOf(count))}`,
      `trim=end_frame=${count}`,
      'setpts=PTS-STARTPTS',
    ]
    const clipFrames = (clip: DocVideoClip): number =>
      Math.max(1, frameOf(clipEnd(clip)) - frameOf(clip.start))
    /** Bilder der halben Übergangsdauer, höchstens `limit`. */
    const halfFrames = (clip: DocVideoClip, limit: number): number =>
      clip.transitionIn ? Math.min(limit, frameOf(Math.round(clip.transitionIn.duration / 2))) : 0
    /** Blende mit Zeiten im Clip, damit sie über Abschnittsgrenzen hinweg stimmt. */
    const fadeSteps = (dir: 'in' | 'out', startFrame: number, count: number, local: number) => [
      `setpts=PTS+${sec(secondsOf(local))}/TB`,
      `fade=t=${dir}:st=${sec(secondsOf(startFrame))}:d=${sec(secondsOf(count))}` +
        (opaque ? `:color=${background}` : ':alpha=1'),
      'setpts=PTS-STARTPTS',
    ]
    /** Letztes Bild von `clip`, `count` Bilder lang angehalten. */
    const frozenSteps = (clip: DocVideoClip, count: number): string => {
      const total = clipFrames(clip)
      const tail = Math.min(total, Math.max(1, Math.ceil(rate.num / rate.den / 2)))
      const offset = Math.max(0, timeOf(frameOf(clip.start) + total - tail) - clip.start)
      const index = addInput(clip, { frames: tail, clip, offset }, 'v')
      return `[${index}:v:0]${[
        ...fitSteps(clip, offset),
        `trim=end_frame=${tail}`,
        // Letztes vorhandenes Bild, auch wenn die Quelle etwas früher endet.
        'reverse',
        'trim=end_frame=1',
        ...lengthSteps(count),
      ].join(',')}`
    }
    /** Erstes Bild des Stücks auf der Timeline. */
    let cursor = f0
    for (const piece of parts) {
      const out = label('v')
      const pieceStart = cursor
      cursor += piece.frames
      const holder = piece.clip ? null : holderAt(pieceStart)
      if (holder) {
        // Lücke mit gehaltenem Bild; beginnt der nächste Clip mit „Blende“,
        // blendet das Standbild an seinem Ende aus.
        const gap = holder.end - holder.start
        const local = pieceStart - holder.start
        const nOut = holder.next.transitionIn?.preset === 'fade' ? halfFrames(holder.next, gap) : 0
        const fade =
          nOut > 0 && local + piece.frames > gap - nOut
            ? fadeSteps('out', gap - nOut, nOut, local)
            : []
        chains.push(
          `${frozenSteps(holder.clip, piece.frames)}${fade.map((f) => `,${f}`).join('')}[${out}]`,
        )
      } else if (!piece.clip) {
        chains.push(
          `color=c=${fill}:s=${size}:r=${fps},format=${format},trim=end_frame=${piece.frames}[${out}]`,
        )
      } else {
        const clip = piece.clip
        const at = track.clips.indexOf(clip)
        const before = at > 0 ? track.clips[at - 1] : undefined
        const adjacent = before !== undefined && frameOf(clipEnd(before)) === frameOf(clip.start)
        // Voriges Bild für den Übergang: direkt davor oder über die Lücke gehalten.
        // Ein ausgeblendeter Clip liefert keins (sein Bild ist am Ende schon weg).
        const prev = before && !before.fadeOut && (adjacent || before.hold) ? before : undefined
        const after = track.clips[at + 1]
        const next = after && frameOf(after.start) === frameOf(clipEnd(clip)) ? after : undefined
        const total = clipFrames(clip)
        /** Erstes Bild dieses Stücks, gezählt im Clip. */
        const local = frameOf(clip.start + piece.offset) - frameOf(clip.start)
        const nIn = halfFrames(clip, total)
        const preset = clip.transitionIn?.preset
        const inActive = nIn > 0 && local < nIn
        // Ausblenden, wenn der nächste Clip mit „Blende“ beginnt.
        // Oder der Clip blendet selbst aus (`fadeOut`); das längere von beiden gilt.
        const ownOut = clip.fadeOut ? Math.min(total, frameOf(clip.fadeOut.duration)) : 0
        const nOut = Math.max(
          ownOut,
          next?.transitionIn?.preset === 'fade' ? halfFrames(next, total) : 0,
        )
        const outActive = nOut > 0 && local + piece.frames > total - nOut
        const fades = [
          ...(inActive && preset === 'fade' ? fadeSteps('in', 0, nIn, local) : []),
          ...(outActive ? fadeSteps('out', total - nOut, nOut, local) : []),
        ]
        if (inActive && preset && preset !== 'fade') {
          // Der Clip läuft ab seinem ersten Bild über dem angehaltenen letzten
          // Bild des vorigen Clips ein; danach wird auf das Stück gekürzt.
          const from = label('xa')
          if (prev) {
            chains.push(`${frozenSteps(prev, nIn)}[${from}]`)
          } else {
            chains.push(
              `color=c=${fill}:s=${size}:r=${fps},format=${format},trim=end_frame=${nIn}[${from}]`,
            )
          }
          const to = label('xb')
          const span = local + piece.frames
          const index = addInput(clip, { frames: span, clip, offset: 0 }, 'v')
          chains.push(
            `[${index}:v:0]${[...fitSteps(clip, 0), ...lengthSteps(span)].join(',')}[${to}]`,
          )
          chains.push(
            `[${from}][${to}]${[
              `xfade=transition=${XFADE_TYPES[preset]}:duration=${sec(secondsOf(nIn))}:offset=0`,
              `trim=start_frame=${local}:end_frame=${span}`,
              'setpts=PTS-STARTPTS',
              ...fades,
            ].join(',')}[${out}]`,
          )
        } else {
          const index = addInput(clip, piece, 'v')
          const steps = [...fitSteps(clip, piece.offset), ...lengthSteps(piece.frames), ...fades]
          chains.push(`[${index}:v:0]${steps.join(',')}[${out}]`)
        }
      }
      labels.push(out)
    }
    const layer = label('layer')
    chains.push(
      labels.length === 1
        ? `[${labels[0]}]null[${layer}]`
        : `${labels.map((l) => `[${l}]`).join('')}concat=n=${labels.length}:v=1:a=0[${layer}]`,
    )
    layers.push(layer)
  }

  if (layers.length === 0) {
    chains.push(
      `color=c=${background}:s=${size}:r=${fps},format=yuv420p,trim=end_frame=${frames}[vout]`,
    )
  } else {
    let current = layers[0]
    for (let i = 1; i < layers.length; i++) {
      const next = label('mix')
      chains.push(`[${current}][${layers[i]}]overlay=format=auto:eof_action=pass[${next}]`)
      current = next
    }
    chains.push(`[${current}]format=yuv420p[vout]`)
  }

  // --- Grafiken und Texte ----------------------------------------------------

  // Beide liegen über allen Video-Spuren: erst die Grafiken (untere Spur
  // zuerst), darüber die Texte. Ihre Zeiten sind die der ganzen Timeline; das
  // Bild wird dafür kurz auf diese Zeiten verschoben. So laufen Animationen
  // über Abschnittsgrenzen hinweg nahtlos weiter.
  const t0 = secondsOf(f0)
  const t1 = secondsOf(f1)
  const texts: TextOverlay[] = []
  const graphics: Array<{ index: number; filter: (i: string, o: string) => string }> = []
  const overlayTracks = doc.tracks.filter(
    (t): t is DocOverlayTrack => t.kind === 'overlay' && !t.hidden,
  )
  for (const track of overlayTracks.slice().reverse()) {
    for (const clip of track.clips) {
      const start = secondsOf(frameOf(clip.start))
      const end = secondsOf(frameOf(clipEnd(clip)))
      if (end <= t0 || start >= t1 || end <= start) continue
      if (clip.kind === 'text' && clip.text) texts.push({ ...clip.text, start, end })
      const g = clip.kind === 'graphic' ? clip.graphic : undefined
      const image = g ? opts.graphics?.[g.png] : undefined
      if (!g || !image) continue
      // Das PNG ist für die Projekthöhe `refHeight` gezeichnet: auf die
      // Ausgabegröße bringen (Vorschau kleiner, Export meist 1:1).
      const factor = height / g.refHeight
      const w = Math.max(1, Math.round(image.width * factor))
      const h = Math.max(1, Math.round(image.height * factor))
      const pre = [
        `setpts=PTS+${sec(t0)}/TB`,
        ...(w === image.width && h === image.height ? [] : [`scale=${w}:${h}`]),
      ]
      inputs.push('-loop', '1', '-framerate', fps, '-t', sec(duration + 1), '-i', image.path)
      const index = inputCount++
      const overlay = {
        width: w,
        height: h,
        x: g.x,
        y: g.y,
        start,
        end,
        animation: g.animation,
        loop: g.loop,
        animSpeed: g.animSpeed,
        ...(g.animOut !== undefined
          ? { animOut: g.animOut, animOutSpeed: g.animOutSpeed ?? 1 }
          : {}),
        ...(g.loopSpeed !== undefined ? { loopSpeed: g.loopSpeed } : {}),
        ...(g.keys?.length ? { motion: graphicMotion(g.keys, start, g.ease === 'smooth') } : {}),
      }
      graphics.push({
        index,
        filter: (i, o) => graphicFilter(overlay, index, `[${i}]`, `[${o}]`, width, height, pre),
      })
    }
  }
  let ass: string | undefined
  if (texts.length > 0) ass = buildAss(texts, width, height)
  if (ass !== undefined || graphics.length > 0) {
    const last = chains.length - 1
    chains[last] = chains[last].replace(/\[vout\]$/, '[vplain]')
    let head = `[vplain]setpts=PTS+${sec(t0)}/TB,`
    if (graphics.length > 0) {
      let current = label('gbase')
      chains.push(`[vplain]setpts=PTS+${sec(t0)}/TB[${current}]`)
      for (const g of graphics) {
        const next = label('gmix')
        chains.push(g.filter(current, next))
        current = next
      }
      head = `[${current}]`
    }
    chains.push(
      head +
        (ass === undefined
          ? ''
          : `ass=filename=${ASS_PLACEHOLDER}:fontsdir=${FONTS_PLACEHOLDER},`) +
        'setpts=PTS-STARTPTS,format=yuv420p[vout]',
    )
  }

  // --- Drop-Effekte an Markern ----------------------------------------------

  // Ganz oben über Bild, Grafiken und Texten; Zeiten wie bei den Grafiken.
  const fx = markerEffectFilters(doc.effects ?? [], {
    t0,
    t1,
    frameSec: secondsOf(1),
    width,
    height,
  })
  if (fx.length > 0) {
    const last = chains.length - 1
    chains[last] = chains[last].replace(/\[vout\]$/, '[vprefx]')
    chains.push(
      `[vprefx]setpts=PTS+${sec(t0)}/TB,${fx.join(',')},setpts=PTS-STARTPTS,format=yuv420p[vout]`,
    )
  }

  // --- Ton -------------------------------------------------------------------

  const audioAll = doc.tracks.filter((t): t is DocAudioTrack => t.kind === 'audio')
  const anySolo = audioAll.some((t) => t.solo)
  const audible = audioAll.filter((t) => (anySolo ? t.solo : !t.muted) && t.volume > 0)
  let mixes: string[] = []
  /** Spur-Mischungen, die bei Ton auf den übrigen Spuren leiser werden. */
  const ducked = new Map<string, number>()
  for (const track of audible) {
    // Clips ohne Tonspur in der Quelle zählen als Stille.
    const withSound = track.clips.filter((c) => source(c.asset).hasAudio && c.gain > 0)
    const parts = pieces(withSound, frameOf, timeOf, f0, f1)
    if (!parts) continue
    const labels: string[] = []
    for (const piece of parts) {
      const out = label('a')
      const length = sec(secondsOf(piece.frames))
      if (!piece.clip) {
        chains.push(`anullsrc=r=${sr}:cl=stereo,atrim=duration=${length}[${out}]`)
      } else {
        const clip = piece.clip
        const index = addInput(clip, piece, 'a')
        const volume = clip.gain * track.volume
        const steps = [
          'asetpts=PTS-STARTPTS',
          ...envelopeFilter(
            clip.envelope ?? [],
            (clip.sourceIn + Math.round(piece.offset * clip.speed)) / MICROS_PER_SECOND,
          ),
          ...atempoFilters(clip.speed),
          `aresample=${sr}`,
          'aformat=sample_fmts=fltp:channel_layouts=stereo',
          ...(Math.abs(volume - 1) > 1e-6 ? [`volume=${num(volume)}`] : []),
          ...clipFadeFilters(clip, piece.offset, timeOf(piece.frames)),
          'apad',
          `atrim=duration=${length}`,
          'asetpts=PTS-STARTPTS',
        ]
        chains.push(`[${index}:a:0]${steps.join(',')}[${out}]`)
      }
      labels.push(out)
    }
    const mix = label('track')
    chains.push(
      labels.length === 1
        ? `[${labels[0]}]anull[${mix}]`
        : `${labels.map((l) => `[${l}]`).join('')}concat=n=${labels.length}:v=0:a=1[${mix}]`,
    )
    mixes.push(mix)
    if (track.duck) ducked.set(mix, track.duck)
  }

  // Automatisches Absenken: Die übrigen Spuren steuern einen Kompressor auf der
  // abgesenkten Spur. Der Anfang des Steuersignals läuft einmal vorweg, damit
  // der Kompressor an jeder Segmentgrenze der Vorschau schon eingeschwungen ist.
  const keys = mixes.filter((m) => !ducked.has(m))
  if (ducked.size > 0 && keys.length > 0) {
    const prime = num(DUCK_PRIME_SEC)
    const forKey: string[] = []
    const forMix = new Map<string, string>()
    for (const key of keys) {
      const a = label('keymix')
      const b = label('keyside')
      chains.push(`[${key}]asplit=2[${a}][${b}]`)
      forMix.set(key, a)
      forKey.push(b)
    }
    const bus = label('keybus')
    chains.push(
      forKey.length === 1
        ? `[${forKey[0]}]anull[${bus}]`
        : `${forKey.map((l) => `[${l}]`).join('')}amix=inputs=${forKey.length}:duration=longest:normalize=0[${bus}]`,
    )
    const body = label('keybody')
    const head = label('keyhead')
    const primed = label('keyprimed')
    chains.push(`[${bus}]asplit=2[${body}][${head}]`)
    chains.push(
      `[${head}]apad,atrim=duration=${prime},asetpts=PTS-STARTPTS[${head}t]`,
      `[${head}t][${body}]concat=n=2:v=0:a=1[${primed}]`,
    )
    const sides = [...ducked.keys()].map(() => label('side'))
    chains.push(
      sides.length === 1
        ? `[${primed}]anull[${sides[0]}]`
        : `[${primed}]asplit=${sides.length}${sides.map((l) => `[${l}]`).join('')}`,
    )
    let i = 0
    for (const [mix, amount] of ducked) {
      const out = label('duck')
      chains.push(
        `[${mix}]adelay=${Math.round(DUCK_PRIME_SEC * 1000)}:all=1[${out}in]`,
        `[${out}in][${sides[i++]}]sidechaincompress=${DUCK_COMPRESSOR}:mix=${num(amount)},` +
          `atrim=start=${prime},asetpts=PTS-STARTPTS[${out}]`,
      )
      forMix.set(mix, out)
    }
    mixes = mixes.map((m) => forMix.get(m) ?? m)
  }

  if (mixes.length === 0) {
    chains.push(`anullsrc=r=${sr}:cl=stereo,atrim=duration=${sec(duration)}[aout]`)
  } else if (mixes.length === 1) {
    chains.push(`[${mixes[0]}]anull[aout]`)
  } else {
    chains.push(
      `${mixes.map((l) => `[${l}]`).join('')}amix=inputs=${mixes.length}:duration=longest:normalize=0[aout]`,
    )
  }

  if (opts.normalizeAudio && mixes.length > 0) {
    // `loudnorm` arbeitet intern mit 192 kHz: danach zurück auf die Projektrate.
    const last = chains.length - 1
    chains[last] = chains[last].replace(/\[aout\]$/, '[amixed]')
    chains.push(`[amixed]${LOUDNORM_FILTER},aresample=${sr},atrim=duration=${sec(duration)}[aout]`)
  }

  return {
    inputs,
    filter: chains.join(';'),
    ...(ass === undefined ? {} : { ass }),
    frames,
    duration,
    width,
    height,
    fps,
    sampleRate: sr,
  }
}

export interface EncodeOptions {
  output: string
  /** x264-Voreinstellung und Qualität. */
  preset: string
  crf: number
  audioBitrate?: string
  /** FFmpeg-Threads; ohne Angabe entscheidet FFmpeg. */
  threads?: number
  /** Schlüsselbild-Abstand in Bildern (für die Vorschau klein halten). */
  gop?: number
  /** MP4-Schalter; Standard `+faststart` (Download). Die Vorschau nutzt fragmentiertes MP4. */
  movflags?: string
  /**
   * Für die Vorschau: Abschnitte, die der Browser lückenlos aneinanderreiht.
   * Ohne B-Bilder und ohne Zeitverschiebung durch den Muxer liegt das erste
   * Bild exakt bei 0 und jedes weitere auf dem Bildraster.
   */
  seamless?: boolean
  /** Pfad der geschriebenen ASS-Datei und Schriftordner (nötig, wenn `compiled.ass` gesetzt ist). */
  assPath?: string
  fontsDir?: string
  /** Pfad einer FFMETADATA-Datei mit Kapiteln (siehe `chapterMetadata`). */
  chaptersPath?: string
}

/** Setzt die Pfade für die Text-Datei in den Filter ein. */
function resolveFilter(compiled: CompiledTimeline, enc: EncodeOptions): string {
  if (compiled.ass === undefined) return compiled.filter
  if (!enc.assPath || !enc.fontsDir)
    throw new CompileError('Für Texte fehlen ASS-Datei oder Schriftordner.')
  return compiled.filter
    .replace(ASS_PLACEHOLDER, () => escapeFilterPath(enc.assPath as string))
    .replace(FONTS_PLACEHOLDER, () => escapeFilterPath(enc.fontsDir as string))
}

/** Vollständige FFmpeg-Argumente für ein kompiliertes Stück (H.264 + AAC in MP4). */
export function buildRenderArgs(compiled: CompiledTimeline, enc: EncodeOptions): string[] {
  return [
    ...PROGRESS,
    ...compiled.inputs,
    // Kapitel kommen als letzte Eingabe dazu; sie hat keine Bild- oder Tonspur.
    ...(enc.chaptersPath
      ? [
          ...['-f', 'ffmetadata', '-i', enc.chaptersPath],
          ...['-map_chapters', String(compiled.inputs.filter((a) => a === '-i').length)],
        ]
      : []),
    '-filter_complex',
    resolveFilter(compiled, enc),
    '-map',
    '[vout]',
    '-map',
    '[aout]',
    '-r',
    compiled.fps,
    '-c:v',
    'libx264',
    '-preset',
    enc.preset,
    '-crf',
    String(enc.crf),
    '-pix_fmt',
    'yuv420p',
    ...(enc.seamless ? ['-bf', '0', '-avoid_negative_ts', 'disabled'] : []),
    ...(enc.gop
      ? ['-g', String(enc.gop), '-keyint_min', String(enc.gop), '-sc_threshold', '0']
      : []),
    '-c:a',
    'aac',
    '-b:a',
    enc.audioBitrate ?? '160k',
    '-ar',
    String(compiled.sampleRate),
    '-ac',
    '2',
    ...(enc.threads ? ['-threads', String(Math.max(1, Math.trunc(enc.threads)))] : []),
    // Bild und Ton enden gemeinsam (der Ton ist auf Bildlänge geschnitten).
    '-t',
    sec(compiled.duration),
    '-movflags',
    enc.movflags ?? '+faststart',
    // Dateiendung sagt nichts (temporäre Namen): Format ausdrücklich setzen.
    '-f',
    'mp4',
    enc.output,
  ]
}
