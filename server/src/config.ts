import 'dotenv/config'
import path from 'node:path'
import os from 'node:os'

function num(name: string, def: number): number {
  const raw = process.env[name]
  const n = raw !== undefined ? Number(raw) : Number.NaN
  return Number.isFinite(n) ? n : def
}

function list(name: string, def: string[]): string[] {
  const raw = process.env[name]
  if (!raw) return def
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

export const config = {
  port: num('PORT', 4021),
  host: process.env.HOST ?? '127.0.0.1',

  /** Temporäres Arbeitsverzeichnis (wird beim Start angelegt). */
  tmpDir: process.env.TMP_DIR ?? path.join(os.tmpdir(), 'video-cutter'),

  /** Upload-Obergrenze. */
  maxFileSizeBytes: num('MAX_FILE_SIZE_MB', 2048) * 1024 * 1024,
  /** Maximal erlaubte Schnitt-Dauer (gegen Missbrauch). */
  maxDurationSec: num('MAX_DURATION_SEC', 4 * 60 * 60),

  /** FFmpeg-Binary (Pfad oder Name im PATH). */
  ffmpegPath: process.env.FFMPEG_PATH ?? 'ffmpeg',
  /** FFprobe-Binary (Analyse beim Zusammenfügen mehrerer Videos). */
  ffprobePath: process.env.FFPROBE_PATH ?? 'ffprobe',
  /** Harte Zeitgrenze pro Job. */
  ffmpegTimeoutMs: num('FFMPEG_TIMEOUT_SEC', 20 * 60) * 1000,

  /** Höchstzahl angehängter Videos pro Job. */
  maxAppendFiles: num('MAX_APPEND_FILES', 5),

  /** Gleichzeitige Encodes (schützt die VPS-CPU/RAM). */
  maxConcurrent: num('MAX_CONCURRENT', 2),
  /** Lebensdauer eines Jobs (danach werden Dateien gelöscht). */
  jobTtlMs: num('JOB_TTL_SEC', 30 * 60) * 1000,

  /** Gespeicherte Videos (Bibliothek) werden nach so langer Nichtbenutzung gelöscht. */
  mediaTtlMs: num('MEDIA_TTL_SEC', 2 * 60 * 60) * 1000,
  /** Obergrenze für alle gespeicherten Videos zusammen. */
  maxMediaTotalBytes: num('MAX_MEDIA_TOTAL_MB', 20 * 1024) * 1024 * 1024,

  /** Erlaubte Origins für CORS. */
  allowedOrigins: list('ALLOWED_ORIGINS', [
    'https://kodinitools.com',
    'https://www.kodinitools.com',
  ]),

  /** Requests pro IP je 15 Minuten. */
  rateLimitMax: num('RATE_LIMIT_MAX', 60),
} as const

export type AppConfig = typeof config
