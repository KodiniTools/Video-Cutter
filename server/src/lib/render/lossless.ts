import { PROGRESS, formatFfmpegTime } from '../args'
import { MICROS_PER_SECOND, type RenderDoc, type Time } from './doc'

/** Warum der Export nicht verlustfrei geht. */
export type LosslessBlocker = 'clips' | 'overlays' | 'speed' | 'crop' | 'audio' | 'format'

export type LosslessCheck =
  | {
      ok: true
      /** Medium, aus dem kopiert wird. */
      asset: string
      /** Beginn in der Quelle und Länge (Mikrosekunden). */
      sourceIn: Time
      duration: Time
      /** Tonspur der Quelle mitkopieren? */
      audio: boolean
    }
  | { ok: false; reason: LosslessBlocker }

export interface LosslessSourceInfo {
  width: number
  height: number
  hasAudio: boolean
}

/**
 * Verlustfrei (Kopieren ohne Neu-Kodieren) geht nur im einfachsten Fall: genau
 * ein Video-Clip ab Zeit 0 in Originalgröße, ohne Tempo, Zuschnitt, Texte oder
 * Grafiken – und der Ton ist entweder der unveränderte Ton dieses Clips oder
 * fehlt ganz. Alles andere braucht Neu-Kodieren.
 * Dieselben Regeln stehen in `src/timeline/lossless.ts` (Editor).
 */
export function checkLossless(
  doc: RenderDoc,
  info: (assetId: string) => LosslessSourceInfo | undefined,
): LosslessCheck {
  const no = (reason: LosslessBlocker): LosslessCheck => ({ ok: false, reason })
  const video = doc.tracks.flatMap((t) => (t.kind === 'video' && !t.hidden ? t.clips : []))
  if (video.length !== 1) return no('clips')
  const clip = video[0]
  if (clip.kind !== 'video' || clip.start !== 0) return no('clips')
  if (doc.tracks.some((t) => t.kind === 'overlay' && !t.hidden && t.clips.length > 0))
    return no('overlays')
  if (clip.speed !== 1) return no('speed')
  if (clip.crop) return no('crop')
  const source = info(clip.asset)
  if (
    !source ||
    !(source.width > 0) ||
    source.width !== doc.settings.width ||
    source.height !== doc.settings.height
  )
    return no('format')

  const audioTracks = doc.tracks.flatMap((t) => (t.kind === 'audio' ? [t] : []))
  const anySolo = audioTracks.some((t) => t.solo)
  const sound = audioTracks
    .filter((t) => (anySolo ? t.solo : !t.muted) && t.volume > 0)
    .flatMap((t) =>
      t.clips
        .filter((c) => c.gain > 0 && info(c.asset)?.hasAudio === true)
        .map((c) => ({ clip: c, volume: c.gain * t.volume })),
    )
  if (sound.length > 1) return no('audio')
  const base = {
    ok: true as const,
    asset: clip.asset,
    sourceIn: clip.sourceIn,
    duration: clip.duration,
  }
  if (sound.length === 0) return { ...base, audio: false }
  const a = sound[0].clip
  const same =
    a.asset === clip.asset &&
    a.start === 0 &&
    a.duration === clip.duration &&
    a.sourceIn === clip.sourceIn &&
    a.speed === 1 &&
    Math.abs(sound[0].volume - 1) < 1e-6 &&
    !a.fadeIn &&
    !a.fadeOut
  return same ? { ...base, audio: true } : no('audio')
}

/**
 * FFmpeg-Argumente: Bereich der Quelle ohne Neu-Kodieren kopieren. Der Schnitt
 * beginnt am Schlüsselbild vor dem gewünschten Beginn (wie beim verlustfreien
 * Schneiden des bisherigen Editors).
 */
export function buildLosslessArgs(
  input: string,
  output: string,
  plan: Extract<LosslessCheck, { ok: true }>,
): string[] {
  return [
    ...PROGRESS,
    '-ss',
    formatFfmpegTime(plan.sourceIn / MICROS_PER_SECOND),
    '-i',
    input,
    '-t',
    formatFfmpegTime(plan.duration / MICROS_PER_SECOND),
    ...(plan.audio ? [] : ['-an']),
    '-c',
    'copy',
    '-avoid_negative_ts',
    'make_zero',
    output,
  ]
}

/** Texte der Ablehnung (für die Antwort des Servers). */
export const LOSSLESS_BLOCKER_TEXT: Record<LosslessBlocker, string> = {
  clips: 'Verlustfrei geht nur mit genau einem Video-Clip am Anfang der Timeline.',
  overlays: 'Verlustfrei geht nicht mit Texten, Grafiken oder Bildern.',
  speed: 'Verlustfrei geht nicht mit geändertem Tempo.',
  crop: 'Verlustfrei geht nicht mit Zuschnitt.',
  audio: 'Verlustfrei geht nur mit dem unveränderten Ton des Clips oder ganz ohne Ton.',
  format: 'Verlustfrei geht nur, wenn das Projektformat der Größe des Videos entspricht.',
}
