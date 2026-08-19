/**
 * Reine Hilfsfunktionen rund um das FFmpeg-Trim-Kommando.
 * Bewusst frei von Vue-/FFmpeg-Imports, damit sie isoliert testbar sind.
 */

export type TrimMode = 'copy' | 'reencode'

/** Begrenzt `value` auf das Intervall [min, max]. NaN -> min. */
export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min
  return Math.min(Math.max(value, min), max)
}

/** Formatiert Sekunden als FFmpeg-Zeit `HH:MM:SS.mmm`. */
export function formatFfmpegTime(seconds: number): string {
  const s = Math.max(0, seconds)
  const hrs = Math.floor(s / 3600)
  const mins = Math.floor((s % 3600) / 60)
  const secs = Math.floor(s % 60)
  const ms = Math.round((s - Math.floor(s)) * 1000)
  const pad = (n: number, len = 2) => String(n).padStart(len, '0')
  // Rundung kann ms=1000 erzeugen – auf Sekunde hochziehen.
  if (ms === 1000) return formatFfmpegTime(Math.floor(s) + 1)
  return `${pad(hrs)}:${pad(mins)}:${pad(secs)}.${pad(ms, 3)}`
}

/** Menschlich lesbare Zeit `MM:SS` für die UI. */
export function formatDisplayTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const mins = Math.floor(s / 60)
  const secs = s % 60
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
}

/** Liefert die Dateiendung in Kleinbuchstaben (ohne Punkt), Fallback `mp4`. */
export function getExtension(filename: string): string {
  const match = /\.([a-zA-Z0-9]+)$/.exec(filename)
  return match ? match[1].toLowerCase() : 'mp4'
}

export interface TrimArgsInput {
  inputName: string
  outputName: string
  start: number
  end: number
  mode: TrimMode
}

/**
 * Baut die FFmpeg-Argumentliste für einen Schnitt.
 *
 * - `-ss` vor `-i`  => schnelles Seeking.
 * - `-t <dauer>`    => eindeutige Ausgabedauer (robuster als `-to`).
 * - `copy`          => verlustfrei, aber Schnitt an Keyframes (sehr schnell).
 * - `reencode`      => frame-genau via libx264/aac (langsamer, größer).
 */
export function buildTrimArgs({
  inputName,
  outputName,
  start,
  end,
  mode,
}: TrimArgsInput): string[] {
  const duration = Math.max(0, end - start)
  const base = ['-ss', formatFfmpegTime(start), '-i', inputName, '-t', formatFfmpegTime(duration)]

  if (mode === 'copy') {
    return [...base, '-c', 'copy', '-avoid_negative_ts', 'make_zero', outputName]
  }

  return [
    ...base,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '23',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-movflags',
    '+faststart',
    outputName,
  ]
}
