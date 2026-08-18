export type TrimMode = 'copy' | 'reencode'

/** Formatiert Sekunden als FFmpeg-Zeit `HH:MM:SS.mmm`. */
export function formatFfmpegTime(seconds: number): string {
  const s = Math.max(0, seconds)
  const hrs = Math.floor(s / 3600)
  const mins = Math.floor((s % 3600) / 60)
  const secs = Math.floor(s % 60)
  const ms = Math.round((s - Math.floor(s)) * 1000)
  if (ms === 1000) return formatFfmpegTime(Math.floor(s) + 1)
  const pad = (n: number, len = 2) => String(n).padStart(len, '0')
  return `${pad(hrs)}:${pad(mins)}:${pad(secs)}.${pad(ms, 3)}`
}

export interface ServerArgsInput {
  inputPath: string
  outputPath: string
  start: number
  duration: number
  mode: TrimMode
}

/**
 * Baut die vollständige Argumentliste für den nativen FFmpeg-Aufruf.
 * `-progress pipe:1` liefert maschinenlesbaren Fortschritt auf stdout.
 * Wird ausschließlich mit `spawn`/`execFile` genutzt (keine Shell → keine Injection).
 */
export function buildServerArgs({
  inputPath,
  outputPath,
  start,
  duration,
  mode,
}: ServerArgsInput): string[] {
  const base = [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-progress', 'pipe:1',
    '-nostats',
    '-ss', formatFfmpegTime(start),
    '-i', inputPath,
    '-t', formatFfmpegTime(Math.max(0, duration)),
  ]

  if (mode === 'copy') {
    return [...base, '-c', 'copy', '-avoid_negative_ts', 'make_zero', outputPath]
  }

  return [
    ...base,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-movflags', '+faststart',
    outputPath,
  ]
}
