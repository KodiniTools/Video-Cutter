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

const tmpDir = process.env.TMP_DIR ?? path.join(os.tmpdir(), 'video-cutter')

export const config = {
  port: num('PORT', 4021),
  host: process.env.HOST ?? '127.0.0.1',

  /** Temporäres Arbeitsverzeichnis (wird beim Start angelegt). */
  tmpDir,

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
  /**
   * Verzeichnis der Bibliothek auf der Platte: Damit überstehen hochgeladene
   * Videos einen Neustart (Deploy). Leer (`MEDIA_INDEX_FILE=`) = nur im
   * Arbeitsspeicher, Videos werden beim Beenden gelöscht.
   */
  mediaIndexFile: process.env.MEDIA_INDEX_FILE ?? path.join(tmpDir, 'media-index.json'),
  /**
   * Abgeleitete Dateien je Video für den Timeline-Editor (Vorschau-Kopie,
   * Wellenform, Filmstreifen). Entstehen nur auf Abruf und werden mit dem
   * Video gelöscht.
   */
  derivedDir: process.env.DERIVED_DIR ?? path.join(tmpDir, 'derived'),
  /** FFmpeg-Threads für die Vorschau-Kopie (schont die übrigen Dienste). */
  derivedThreads: num('DERIVED_THREADS', 2),
  /** Zeitgrenze je abgeleiteter Datei. */
  derivedTimeoutMs: num('DERIVED_TIMEOUT_SEC', 60 * 60) * 1000,
  /**
   * Vorschau des Timeline-Editors: gerenderte Abschnitte (Zwischenspeicher).
   * Darf jederzeit gelöscht werden, die Abschnitte entstehen bei Bedarf neu.
   */
  previewDir: process.env.PREVIEW_DIR ?? path.join(tmpDir, 'preview'),
  /** Obergrenze des Zwischenspeichers; die am längsten ungenutzten Abschnitte fliegen zuerst. */
  previewCacheBytes: num('PREVIEW_CACHE_MB', 2048) * 1024 * 1024,
  /** Gleichzeitig gerenderte Vorschau-Abschnitte und FFmpeg-Threads je Abschnitt. */
  previewConcurrent: num('PREVIEW_CONCURRENT', 2),
  previewThreads: num('PREVIEW_THREADS', 3),
  /** Zeitgrenze je Abschnitt. */
  previewTimeoutMs: num('PREVIEW_TIMEOUT_SEC', 120) * 1000,
  /**
   * Grafiken des Timeline-Editors (vom Browser gezeichnete PNGs). Zwischenspeicher:
   * Fehlt ein Bild, lädt der Editor es erneut hoch.
   */
  graphicsDir: process.env.GRAPHICS_DIR ?? path.join(tmpDir, 'graphics'),
  graphicsCacheBytes: num('GRAPHICS_CACHE_MB', 512) * 1024 * 1024,
  /** Obergrenze für alle gespeicherten Videos zusammen. */
  maxMediaTotalBytes: num('MAX_MEDIA_TOTAL_MB', 20 * 1024) * 1024 * 1024,

  /**
   * Gespeicherte Projekte (Bearbeitungsstand + eigene Videokopien). Bewusst
   * außerhalb des Backend-Ordners, den deploy.sh per rsync --delete spiegelt.
   */
  projectsDir: process.env.PROJECTS_DIR ?? path.join(os.homedir(), '.video-cutter', 'projects'),
  /** Obergrenze für alle Projekte zusammen. */
  maxProjectsTotalBytes: num('MAX_PROJECTS_TOTAL_MB', 100 * 1024) * 1024 * 1024,

  /**
   * Galerie der KI-Bilder (dauerhaft, wie die Projekte außerhalb des
   * Backend-Ordners, damit Deploys sie nicht löschen).
   */
  galleryDir: process.env.GALLERY_DIR ?? path.join(os.homedir(), '.video-cutter', 'gallery'),
  /** Obergrenze für alle Galerie-Bilder zusammen. */
  maxGalleryTotalBytes: num('MAX_GALLERY_TOTAL_MB', 10 * 1024) * 1024 * 1024,

  /** Erlaubte Origins für CORS. */
  allowedOrigins: list('ALLOWED_ORIGINS', [
    'https://kodinitools.com',
    'https://www.kodinitools.com',
  ]),

  /** POST-Anfragen (Uploads, Schneiden, Speichern, KI) pro IP je 15 Minuten. */
  rateLimitWriteMax: num('RATE_LIMIT_WRITE_MAX', 300),
  /** Übrige Anfragen (Status, Fortschritt, Downloads, Löschen) pro IP je 15 Minuten. */
  rateLimitReadMax: num('RATE_LIMIT_READ_MAX', 3000),

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

  // --- KI-Bilder für Bild-Clips (Google Gemini) ---
  /** Gemini-Bildmodell; der API-Key kommt aus GEMINI_API_KEY. */
  geminiImageModel: process.env.GEMINI_IMAGE_MODEL ?? 'gemini-nano-banana-2.1',
  /** API-Basis (für Tests/Proxy überschreibbar). */
  geminiBaseUrl: process.env.GEMINI_BASE_URL ?? 'https://generativelanguage.googleapis.com/v1beta',
  /** Auflösung: leer = passend zum Clip (1K/2K/4K), sonst fest; „off“ = nicht senden. */
  geminiImageSize: process.env.GEMINI_IMAGE_SIZE ?? '',
  /** Zeitgrenze pro Bild. */
  geminiTimeoutMs: num('GEMINI_TIMEOUT_SEC', 120) * 1000,

  // --- KI-Videos (Gemini Omni, gleicher GEMINI_API_KEY) ---
  /** Gemini-Videomodell (Veo ist in der Gemini-API abgeschaltet). */
  geminiVideoModel: process.env.GEMINI_VIDEO_MODEL ?? 'gemini-omni-1.2-flash',
  /** Auflösung: leer = Standard des Modells (720p), sonst 360p | 720p | 1080p | 4k. */
  geminiVideoResolution: process.env.GEMINI_VIDEO_RESOLUTION ?? '',
  /** „off“ = Dauer nicht mitschicken (für Modelle ohne Dauer-Angabe). */
  geminiVideoDuration: process.env.GEMINI_VIDEO_DURATION ?? '',
  /** Zeitgrenze pro Video. */
  geminiVideoTimeoutMs: num('GEMINI_VIDEO_TIMEOUT_SEC', 15 * 60) * 1000,
} as const

export type AppConfig = typeof config
