export type TrimMode = 'copy' | 'reencode'
/** 'keep' = ausgewählten Bereich behalten, 'remove' = Bereich entfernen (Rest zusammenfügen). */
export type CutOperation = 'keep' | 'remove'

/** Toleranz in Sekunden für Rand-/Degenerationsfälle. */
const EPS = 0.05

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
  /** Standard: 'keep'. */
  operation?: CutOperation
  /** Gesamtdauer des Videos in Sekunden – nur für 'remove' nötig. */
  total?: number
}

// Gemeinsame Präfixe/Encoder-Optionen.
const PROGRESS = ['-hide_banner', '-nostdin', '-y', '-progress', 'pipe:1', '-nostats']
const REENCODE = [
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
]

/** Behalten: schneidet [start, start+duration] heraus (copy = verlustfrei, sonst H.264/AAC). */
function keepArgs(
  input: string,
  output: string,
  start: number,
  duration: number,
  mode: TrimMode,
): string[] {
  const base = [
    ...PROGRESS,
    '-ss',
    formatFfmpegTime(start),
    '-i',
    input,
    '-t',
    formatFfmpegTime(Math.max(0, duration)),
  ]
  if (mode === 'copy') {
    return [...base, '-c', 'copy', '-avoid_negative_ts', 'make_zero', output]
  }
  return [...base, ...REENCODE, output]
}

/** Re-Encode-Trim eines einzelnen Segments [start, start+duration]. */
function reencodeTrim(input: string, output: string, start: number, duration: number): string[] {
  const base = [
    ...PROGRESS,
    '-ss',
    formatFfmpegTime(start),
    '-i',
    input,
    '-t',
    formatFfmpegTime(Math.max(0, duration)),
  ]
  return [...base, ...REENCODE, output]
}

/**
 * Baut die vollständige Argumentliste für den nativen FFmpeg-Aufruf.
 * `-progress pipe:1` liefert maschinenlesbaren Fortschritt auf stdout.
 * Wird ausschließlich mit `spawn`/`execFile` genutzt (keine Shell → keine Injection).
 *
 * - operation 'keep':   ausgewählten Bereich behalten.
 * - operation 'remove': ausgewählten Bereich entfernen und die Teile davor/danach
 *   zusammenfügen (immer Re-Encode, da concat dekodierte Frames braucht).
 */
export function buildServerArgs({
  inputPath,
  outputPath,
  start,
  duration,
  mode,
  operation = 'keep',
  total,
}: ServerArgsInput): string[] {
  if (operation === 'remove') {
    const s = Math.max(0, start)
    const end = s + Math.max(0, duration)
    const tot = Number.isFinite(total) ? (total as number) : end
    const keepFirst = s > EPS
    const keepLast = end < tot - EPS

    // Mitte entfernen: Teil davor + Teil danach zusammenfügen.
    // WICHTIG: den Input ZWEIMAL separat einlesen (Input 0 auf [0, s] via -t,
    // Input 1 ab `end` via -ss). Würde man denselben Input mit zwei trim-Zweigen
    // splitten, puffert der zweite Zweig den ganzen Rest im Speicher -> OOM/Kill.
    if (keepFirst && keepLast) {
      const filter =
        `[0:v]setpts=PTS-STARTPTS[v0];` +
        `[0:a]asetpts=PTS-STARTPTS[a0];` +
        `[1:v]setpts=PTS-STARTPTS[v1];` +
        `[1:a]asetpts=PTS-STARTPTS[a1];` +
        `[v0][a0][v1][a1]concat=n=2:v=1:a=1[outv][outa]`
      return [
        ...PROGRESS,
        // Input 0: nur der Teil vor der Auswahl.
        '-t',
        formatFfmpegTime(s),
        '-i',
        inputPath,
        // Input 1: ab dem Ende der Auswahl bis zum Video-Ende.
        '-ss',
        formatFfmpegTime(end),
        '-i',
        inputPath,
        '-filter_complex',
        filter,
        '-map',
        '[outv]',
        '-map',
        '[outa]',
        ...REENCODE,
        outputPath,
      ]
    }

    // Auswahl reicht bis ans Ende -> nur den Teil davor behalten.
    if (keepFirst) {
      return reencodeTrim(inputPath, outputPath, 0, s)
    }

    // Auswahl beginnt am Anfang -> nur den Teil danach behalten.
    return reencodeTrim(inputPath, outputPath, end, Math.max(0, tot - end))
  }

  return keepArgs(inputPath, outputPath, start, duration, mode)
}
