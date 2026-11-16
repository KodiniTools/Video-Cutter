import { PROGRESS, atempoFilters, buildCropFilter } from '../args'
import {
  MICROS_PER_SECOND,
  clipEnd,
  docDuration,
  type DocAudioClip,
  type DocAudioTrack,
  type DocVideoClip,
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
 *  - Alle Grenzen liegen auf dem Bildraster des Projekts; Längen werden in
 *    ganzen Bildern gezählt, damit Bild und Ton nie auseinanderlaufen.
 */

/** Quelle eines Mediums auf der Platte (vom Aufrufer aus dem MediaStore aufgelöst). */
export interface RenderSource {
  path: string
  hasAudio: boolean
}

export interface CompileOptions {
  /** Dateien je Asset-ID. Fehlt eine benötigte Quelle, wirft der Compiler. */
  sources: Record<string, RenderSource>
  /** Abschnitt der Timeline; Standard: 0 bis zum Ende des letzten Clips. */
  range?: { start: Time; end: Time }
  /** Ausgabegröße (z. B. kleiner für die Vorschau); Standard: Projektgröße. */
  size?: { width: number; height: number }
}

export interface CompiledTimeline {
  /** Eingaben (`-ss … -i …`) in der Reihenfolge der Filter-Eingänge. */
  inputs: string[]
  /** Inhalt für `-filter_complex`; Ausgänge heißen `[vout]` und `[aout]`. */
  filter: string
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
    const parts = pieces(track.clips, frameOf, timeOf, f0, f1)
    if (!parts) continue
    const opaque = layers.length === 0
    const format = opaque ? 'yuv420p' : 'yuva420p'
    const fill = opaque ? background : 'black@0'
    const labels: string[] = []
    for (const piece of parts) {
      const out = label('v')
      if (!piece.clip) {
        chains.push(
          `color=c=${fill}:s=${size}:r=${fps},format=${format},trim=end_frame=${piece.frames}[${out}]`,
        )
      } else {
        const clip = piece.clip
        const index = addInput(clip, piece, 'v')
        const steps = [
          clip.kind === 'still' || clip.speed === 1
            ? 'setpts=PTS-STARTPTS'
            : `setpts=(PTS-STARTPTS)/${num(clip.speed)}`,
          `fps=${fps}`,
          ...(clip.crop ? [buildCropFilter(clip.crop)] : []),
          `scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2`,
          `format=${format}`,
          `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=${fill}`,
          'setsar=1',
          // Endet die Quelle ein paar Bilder zu früh, wird das letzte Bild gehalten.
          `tpad=stop_mode=clone:stop_duration=${sec(secondsOf(piece.frames))}`,
          `trim=end_frame=${piece.frames}`,
          'setpts=PTS-STARTPTS',
        ]
        chains.push(`[${index}:v:0]${steps.join(',')}[${out}]`)
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

  // --- Ton -------------------------------------------------------------------

  const audioAll = doc.tracks.filter((t): t is DocAudioTrack => t.kind === 'audio')
  const anySolo = audioAll.some((t) => t.solo)
  const audible = audioAll.filter((t) => (anySolo ? t.solo : !t.muted) && t.volume > 0)
  const mixes: string[] = []
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
          ...atempoFilters(clip.speed),
          `aresample=${sr}`,
          'aformat=sample_fmts=fltp:channel_layouts=stereo',
          ...(Math.abs(volume - 1) > 1e-6 ? [`volume=${num(volume)}`] : []),
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

  return { inputs, filter: chains.join(';'), frames, duration, width, height, fps, sampleRate: sr }
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
}

/** Vollständige FFmpeg-Argumente für ein kompiliertes Stück (H.264 + AAC in MP4). */
export function buildRenderArgs(compiled: CompiledTimeline, enc: EncodeOptions): string[] {
  return [
    ...PROGRESS,
    ...compiled.inputs,
    '-filter_complex',
    compiled.filter,
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
