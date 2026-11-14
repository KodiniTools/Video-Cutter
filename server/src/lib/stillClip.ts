import { ValidationError } from './validate'

/**
 * Bild-Clip (Standbild als Video): Ein Bild wird für eine einstellbare Dauer
 * als Video mit stiller Tonspur ausgegeben. Der Clip landet in der Bibliothek
 * und verhält sich danach wie jedes andere Video (Einbrennen, Zusammenfügen).
 */

/** Grenzen eines Bild-Clips. */
export const STILL_LIMITS = {
  minDuration: 0.5,
  maxDuration: 600,
  minSize: 16,
  /** Längste Seite (4K quer/hoch). */
  maxSize: 4096,
  minFps: 1,
  maxFps: 60,
} as const

export interface StillParams {
  /** Dauer in Sekunden. */
  duration: number
  /** Ausgabegröße (gerade Pixelzahlen, für yuv420p nötig). */
  width: number
  height: number
  /** Bildrate (ganzzahlig). */
  fps: number
}

function toNum(v: unknown): number {
  if (typeof v === 'number') return v
  if (typeof v === 'string' && v.trim() !== '') return Number(v)
  return NaN
}

/** Auf gerade Pixelzahl abrunden (mind. 2). */
function even(n: number): number {
  return Math.max(2, Math.floor(n / 2) * 2)
}

/**
 * Prüft die Formularfelder (`duration`, `width`, `height`, optional `fps`).
 * Wirft ValidationError mit verständlicher Meldung.
 */
export function parseStillParams(body: Record<string, unknown>): StillParams {
  const duration = toNum(body.duration)
  if (
    !Number.isFinite(duration) ||
    duration < STILL_LIMITS.minDuration ||
    duration > STILL_LIMITS.maxDuration
  ) {
    throw new ValidationError(
      `Dauer muss zwischen ${STILL_LIMITS.minDuration} und ${STILL_LIMITS.maxDuration} Sekunden liegen.`,
    )
  }
  const size = (v: unknown, name: string): number => {
    const n = toNum(v)
    if (!Number.isFinite(n) || n < STILL_LIMITS.minSize || n > STILL_LIMITS.maxSize) {
      throw new ValidationError(
        `${name} muss zwischen ${STILL_LIMITS.minSize} und ${STILL_LIMITS.maxSize} Pixeln liegen.`,
      )
    }
    return even(Math.round(n))
  }
  const width = size(body.width, 'Breite')
  const height = size(body.height, 'Höhe')
  const rawFps = body.fps === undefined || body.fps === '' ? 30 : toNum(body.fps)
  if (!Number.isFinite(rawFps) || rawFps < STILL_LIMITS.minFps || rawFps > STILL_LIMITS.maxFps) {
    throw new ValidationError(
      `Bildrate muss zwischen ${STILL_LIMITS.minFps} und ${STILL_LIMITS.maxFps} liegen.`,
    )
  }
  return {
    duration: Math.round(duration * 1000) / 1000,
    width,
    height,
    fps: Math.round(rawFps),
  }
}

/**
 * FFmpeg-Argumente: Bild als Endlosschleife + stille Stereo-Tonspur (48 kHz),
 * auf W×H skaliert (das Frontend liefert das Bild bereits in Zielgröße; die
 * Skalierung ist nur die Absicherung), H.264/AAC in MP4. Ein Keyframe je
 * Sekunde hält das Springen im Editor schnell.
 */
export function buildStillArgs(imagePath: string, outputPath: string, p: StillParams): string[] {
  const dur = p.duration.toFixed(3)
  return [
    '-hide_banner',
    '-y',
    '-loop',
    '1',
    '-framerate',
    String(p.fps),
    '-i',
    imagePath,
    '-f',
    'lavfi',
    '-i',
    'anullsrc=r=48000:cl=stereo',
    '-t',
    dur,
    '-map',
    '0:v:0',
    '-map',
    '1:a:0',
    '-vf',
    `scale=${p.width}:${p.height}:force_original_aspect_ratio=decrease,` +
      `pad=${p.width}:${p.height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p`,
    '-r',
    String(p.fps),
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-tune',
    'stillimage',
    '-crf',
    '18',
    '-g',
    String(p.fps),
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-shortest',
    '-movflags',
    '+faststart',
    '-progress',
    'pipe:1',
    '-nostats',
    outputPath,
  ]
}

/** Dateiname des Clips, z. B. „Bild-Clip_5s.mp4“. */
export function stillClipName(duration: number): string {
  const s = Math.round(duration * 10) / 10
  return `Bild-Clip_${String(s).replace('.', ',')}s.mp4`
}
