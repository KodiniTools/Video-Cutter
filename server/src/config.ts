import 'dotenv/config'
import path from 'node:path'
import os from 'node:os'
import { existsSync } from 'node:fs'

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

/** Erster vorhandener Ordner: <server>/fonts/custom (VPS) oder <repo>/src/assets/fonts (lokal). */
function defaultCustomFontsDir(): string {
  const deployed = path.resolve(__dirname, '../fonts/custom')
  const repo = path.resolve(__dirname, '../../src/assets/fonts')
  return existsSync(deployed) ? deployed : repo
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

  /** Schriften für Text-Einblendungen (libass `fontsdir`). */
  fontsDir: process.env.FONTS_DIR ?? path.resolve(__dirname, '../fonts'),
  /**
   * Eigene Schriften (WOFF2/WOFF/TTF/OTF). Auf dem VPS kopiert deploy.sh
   * src/assets/fonts nach <API_DIR>/fonts/custom; lokal wird direkt
   * src/assets/fonts des Repos genutzt.
   */
  customFontsDir: process.env.FONTS_CUSTOM_DIR ?? defaultCustomFontsDir(),

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

  // --- KI (Untertitel, Schnittvorschläge) ---
  /** whisper.cpp-CLI (Pfad oder Name im PATH). */
  whisperPath: process.env.WHISPER_CLI ?? 'whisper-cli',
  /** GGML-Modell für whisper.cpp; leer = Transkription aus. */
  whisperModel: process.env.WHISPER_MODEL ?? '',
  /** CPU-Threads für whisper.cpp. */
  whisperThreads: num('WHISPER_THREADS', 6),
  /** Harte Zeitgrenze pro Transkription. */
  whisperTimeoutMs: num('WHISPER_TIMEOUT_SEC', 60 * 60) * 1000,
  /** Claude-Modell; der API-Key kommt aus ANTHROPIC_API_KEY. */
  claudeModel: process.env.CLAUDE_MODEL ?? 'claude-opus-5-5',
  /** Denktiefe (low | medium | high | xhigh | max). */
  claudeEffort: process.env.CLAUDE_EFFORT ?? 'medium',
} as const

export type AppConfig = typeof config
