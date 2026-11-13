/**
 * Ton am Anfang ein- und am Ende ausblenden. Kurvennamen = FFmpeg `afade curve=`
 * (identisch mit server/src/lib/args.ts AUDIO_FADE_CURVES).
 */
export const AUDIO_FADE_CURVES = [
  'tri',
  'exp',
  'log',
  'qsin',
  'hsin',
  'esin',
  'qua',
  'cub',
  'squ',
] as const
export type AudioFadeCurve = (typeof AUDIO_FADE_CURVES)[number]

/** Grenzen der Blenddauer in der Oberfläche (Server erlaubt bis 30 s). */
export const MIN_FADE_SEC = 0.5
export const MAX_FADE_SEC = 10
export const FADE_STEP_SEC = 0.5

/** Einstellungen einer Seite (Ein- bzw. Ausblenden). */
export interface FadeSide {
  enabled: boolean
  duration: number
  curve: AudioFadeCurve
}

export interface AudioFadeSettings {
  fadeIn: FadeSide
  fadeOut: FadeSide
}

/** Was an den Server geht (Dauer 0 = diese Seite aus). */
export interface AudioFadeInput {
  inDuration: number
  inCurve: AudioFadeCurve
  outDuration: number
  outCurve: AudioFadeCurve
}

export const DEFAULT_AUDIO_FADE: AudioFadeSettings = {
  fadeIn: { enabled: false, duration: 2, curve: 'tri' },
  fadeOut: { enabled: false, duration: 2, curve: 'tri' },
}

export function isCurve(v: unknown): v is AudioFadeCurve {
  return typeof v === 'string' && (AUDIO_FADE_CURVES as readonly string[]).includes(v)
}

/** Dauer auf die Oberflächen-Grenzen und das Raster bringen. */
export function clampFadeDuration(v: unknown, fallback: number): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  const stepped = Math.round(n / FADE_STEP_SEC) * FADE_STEP_SEC
  return Math.min(MAX_FADE_SEC, Math.max(MIN_FADE_SEC, stepped))
}

function parseSide(raw: unknown, fallback: FadeSide): FadeSide {
  if (!raw || typeof raw !== 'object') return { ...fallback }
  const r = raw as Record<string, unknown>
  return {
    enabled: r.enabled === true,
    duration: clampFadeDuration(r.duration, fallback.duration),
    curve: isCurve(r.curve) ? r.curve : fallback.curve,
  }
}

/** Liest gespeicherte Einstellungen robust (kaputtes JSON -> Standard). */
export function parseAudioFadeSettings(json: string | null): AudioFadeSettings {
  if (!json) return structuredClone(DEFAULT_AUDIO_FADE)
  try {
    const raw = JSON.parse(json) as Record<string, unknown>
    return {
      fadeIn: parseSide(raw?.fadeIn, DEFAULT_AUDIO_FADE.fadeIn),
      fadeOut: parseSide(raw?.fadeOut, DEFAULT_AUDIO_FADE.fadeOut),
    }
  } catch {
    return structuredClone(DEFAULT_AUDIO_FADE)
  }
}

/** Server-Parameter; `undefined`, wenn keine Seite aktiv ist. */
export function toAudioFadeInput(s: AudioFadeSettings): AudioFadeInput | undefined {
  if (!s.fadeIn.enabled && !s.fadeOut.enabled) return undefined
  return {
    inDuration: s.fadeIn.enabled ? s.fadeIn.duration : 0,
    inCurve: s.fadeIn.curve,
    outDuration: s.fadeOut.enabled ? s.fadeOut.duration : 0,
    outCurve: s.fadeOut.curve,
  }
}

/**
 * Verstärkung 0..1 an Position x (0..1) beim Einblenden – nachgebildet nach
 * FFmpeg af_afade.c (nur für die Kurvenvorschau).
 */
export function fadeGain(curve: AudioFadeCurve, x: number): number {
  const g = Math.min(1, Math.max(0, x))
  switch (curve) {
    case 'tri':
      return g
    case 'exp':
      return Math.exp(-11.512925464970227 * (1 - g))
    case 'log':
      return g <= 0 ? 0 : Math.min(1, Math.max(0, 1 + 0.2 * Math.log10(g)))
    case 'qsin':
      return Math.sin((g * Math.PI) / 2)
    case 'hsin':
      return (1 - Math.cos(g * Math.PI)) / 2
    case 'esin':
      return 1 - Math.cos((Math.PI / 4) * (Math.pow(2 * g - 1, 3) + 1))
    case 'qua':
      return g * g
    case 'cub':
      return g * g * g
    case 'squ':
      return Math.sqrt(g)
    default: {
      const never: never = curve
      throw new Error(`Unbekannte Kurve: ${String(never)}`)
    }
  }
}

/**
 * SVG-Pfad (viewBox 0 0 w h) der Kurve. Ausblenden = gespiegelt, wie FFmpeg.
 */
export function fadePath(curve: AudioFadeCurve, out: boolean, w = 60, h = 24, steps = 30): string {
  const pts: string[] = []
  for (let i = 0; i <= steps; i++) {
    const x = i / steps
    const gain = fadeGain(curve, out ? 1 - x : x)
    pts.push(`${(x * w).toFixed(1)},${(h - gain * h).toFixed(1)}`)
  }
  return `M${pts.join(' L')}`
}
