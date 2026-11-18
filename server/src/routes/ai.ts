import express, { Router, type NextFunction, type Request, type Response } from 'express'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { copyFile, readFile, rm, writeFile } from 'node:fs/promises'
import { config } from '../config'
import { runFfmpeg } from '../lib/ffmpeg'
import { isMediaId, mediaStore, mediaView, StorageFullError, type MediaItem } from '../lib/media'
import { probeMedia } from '../lib/probe'
import { listModels, resolveModel, type ModelKind } from '../lib/geminiModels'
import { clampVideoDuration, generateVideo, videoAspectFor } from '../lib/geminiVideo'
import { ValidationError } from '../lib/validate'
import { aiJobs, type AiJobKind, type AiJobSnapshot } from '../lib/aiJobs'
import {
  TRANSCRIBE_LANGUAGES,
  transcribeFile,
  whisperReady,
  type TranscribeLanguage,
  type Transcript,
  type Word,
} from '../lib/whisper'
import {
  SUBTITLE_TARGETS,
  TRANSLATE_TARGETS,
  claudeReady,
  IMAGE_STYLES,
  createCutSuggestions,
  createHighlights,
  createPublishTexts,
  createBrollSuggestions,
  BROLL_MODES,
  DEFAULT_BROLLS,
  MAX_BROLLS,
  type BrollMode,
  type BrollRequest,
  PUBLISH_TARGETS,
  type PublishTarget,
  DEFAULT_HIGHLIGHT_TARGET,
  MAX_HIGHLIGHT_TARGET,
  MIN_HIGHLIGHT_TARGET,
  createImagePrompt,
  createVideoPrompt,
  createSubtitles,
  translateTexts,
  MAX_SCRIPT_IDEA,
  MAX_SCRIPT_SECONDS,
  MIN_SCRIPT_SECONDS,
  SCRIPT_LANGUAGES,
  translateScript,
  writeScript,
  type ImageContextScene,
  type ImageStyle,
  type SubtitleTarget,
  type TranslateTarget,
} from '../lib/claude'
import {
  MAX_IMAGE_COUNT,
  MAX_PROMPT_LENGTH,
  MIN_IMAGE_COUNT,
  geminiReady,
  generateImages,
  getImage,
  imageSizeFor,
  nearestAspect,
} from '../lib/gemini'
import { MAX_TEXT_LENGTH, MAX_TEXT_OVERLAYS } from '../lib/textOverlay'
import {
  MAX_SCRIPT_LENGTH,
  elevenlabsReady,
  isVoiceId,
  listVoices,
  parseVoiceSettings,
  synthesizeSpeech,
} from '../lib/elevenlabs'
import { Gallery, GalleryFullError, gallery, isGalleryId, type GalleryImage } from '../lib/gallery'

/**
 * KI-Funktionen:
 * - POST /api/ai/transcribe { mediaId, language }  -> Whisper-Transkript (pro Video gemerkt)
 * - POST /api/ai/subtitles  { mediaId, target }    -> Untertitel (Claude)
 * - POST /api/ai/cuts       { mediaId, minPause }  -> Schnittvorschläge (Claude + Pausen)
 * - POST /api/ai/translate  { texts, target }      -> vorhandene Texte übersetzen (Claude)
 * - POST /api/ai/highlights { mediaId, target, from?, to? } -> beste Stellen für einen Short (Claude)
 * - POST /api/ai/publish    { segments, target, duration } -> Titel, Beschreibung, Hashtags,
 *                                                  Kapitel für die ganze Timeline (Claude)
 * - POST /api/ai/broll    { segments, duration, mode, style, language, count, width, height }
 *                                                  -> Zwischenbilder (B-Roll) mit Prompts (Claude)
 * - POST /api/ai/image-prompt { idea, style, width, height, language, before?, after? }
 *                                                  -> Bild-Prompt für einen Bild-Clip (Claude)
 * - POST /api/ai/images     { prompt, width, height, count } -> Bildvarianten (Gemini)
 * - GET  /api/ai/images/:id                         -> erzeugtes Bild (30 min abrufbar)
 * - POST /api/ai/video-prompt (wie image-prompt, + duration) -> Video-Prompt (Claude)
 * - POST /api/ai/video      { prompt, width, height, duration } -> KI-Video (Gemini Omni)
 * - POST /api/ai/gallery/:id/media                  -> Galerie-Video in die Bibliothek
 * - GET  /api/ai/models                             -> wählbare Gemini-Modelle (Bild/Video)
 * - GET  /api/ai/gallery                            -> dauerhaft gespeicherte KI-Bilder
 * - GET  /api/ai/gallery/:id/file | /thumb          -> Original bzw. Vorschau
 * - DELETE /api/ai/gallery/:id                      -> Bild vom Server löschen
 * - POST /api/ai/script { mode: write, idea, language, seconds }
 *                     | { mode: translate, text, language } -> Sprechertext (Claude)
 * - GET  /api/ai/voices                             -> Stimmen des ElevenLabs-Kontos
 * - POST /api/ai/voice-over { text, voiceId, speed, stability, voiceName? }
 *                                                  -> vertonter Text als Tondatei (ElevenLabs)
 * Alle Aufrufe starten einen Job: 202 { jobId }. Status/Ergebnis per SSE unter
 * GET /api/ai/jobs/:id/events, Abbruch per DELETE /api/ai/jobs/:id.
 */

/** Gemerkte Transkripte je Bibliotheks-Video. */
const transcripts = new Map<string, Transcript>()

/** Transkripte gelöschter/abgelaufener Videos vergessen. */
const sweeper = setInterval(() => {
  for (const id of transcripts.keys()) if (!mediaStore.has(id)) transcripts.delete(id)
}, 60_000)
sweeper.unref?.()

/** Stand der Einrichtung (für /api/health). */
export function aiStatus(): {
  transcribe: boolean
  claude: boolean
  image: boolean
  voice: boolean
} {
  return {
    transcribe: whisperReady(),
    claude: claudeReady(),
    image: geminiReady(),
    voice: elevenlabsReady(),
  }
}

function requireMedia(body: Record<string, unknown>): MediaItem {
  if (!isMediaId(body.mediaId)) throw new ValidationError('Kein Video angegeben.')
  const item = mediaStore.get(body.mediaId)
  if (!item) throw new ValidationError('Video nicht (mehr) auf dem Server vorhanden.')
  return item
}

function requireTranscript(item: MediaItem): Transcript {
  const t = transcripts.get(item.id)
  if (!t) throw new ValidationError('Bitte das Video zuerst transkribieren.', 409)
  return t
}

function requireClaude(): void {
  if (!claudeReady()) {
    throw new ValidationError('Claude ist nicht eingerichtet (ANTHROPIC_API_KEY fehlt).', 503)
  }
}

function busy(res: Response): void {
  res.setHeader('Retry-After', '30')
  res.status(429).json({ error: 'Die KI ist gerade beschäftigt. Bitte gleich erneut versuchen.' })
}

function started(res: Response, job: AiJobSnapshot): void {
  res.status(202).json({ jobId: job.id })
}

function capacity(kind: AiJobKind, res: Response): boolean {
  if (aiJobs.hasCapacity(kind)) return true
  busy(res)
  return false
}

export const aiRouter = Router()
const json = express.json({ limit: '16kb' })

aiRouter.post('/ai/transcribe', json, (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>
  const item = requireMedia(body)
  const language = (TRANSCRIBE_LANGUAGES as readonly unknown[]).includes(body.language)
    ? (body.language as TranscribeLanguage)
    : 'auto'
  if (!whisperReady()) {
    throw new ValidationError(
      'Die Transkription ist nicht eingerichtet (whisper.cpp oder WHISPER_MODEL fehlt).',
      503,
    )
  }
  if (!item.info.hasAudio) throw new ValidationError('Das Video hat keine Tonspur.')
  if (!capacity('transcribe', res)) return

  // Während der Transkription darf das Video nicht gelöscht werden.
  mediaStore.acquire([item.id])
  const job = aiJobs.start('transcribe', async (signal, progress) => {
    try {
      const workBase = path.join(config.tmpDir, `${item.id}-ai-${Date.now()}`)
      const t = await transcribeFile(item.path, workBase, language, signal, progress)
      transcripts.set(item.id, t)
      return {
        language: t.language,
        words: t.words.length,
        text: t.words.map((w) => w.text).join(' '),
      }
    } finally {
      await mediaStore.release([item.id])
    }
  })
  started(res, job)
})

aiRouter.post('/ai/subtitles', json, (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>
  const item = requireMedia(body)
  const t = requireTranscript(item)
  requireClaude()
  const target = (SUBTITLE_TARGETS as readonly unknown[]).includes(body.target)
    ? (body.target as SubtitleTarget)
    : 'original'
  if (!capacity('claude', res)) return
  const job = aiJobs.start('claude', (signal) =>
    createSubtitles(t.words, t.language, target, item.info.duration, MAX_TEXT_OVERLAYS, signal),
  )
  started(res, job)
})

aiRouter.post('/ai/cuts', json, (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>
  const item = requireMedia(body)
  const t = requireTranscript(item)
  requireClaude()
  const raw = Number(body.minPause)
  const minPause = Number.isFinite(raw) ? Math.min(10, Math.max(0.5, raw)) : 1.2
  if (!capacity('claude', res)) return
  const job = aiJobs.start('claude', async (signal) => ({
    suggestions: await createCutSuggestions(t.words, item.info.duration, minPause, signal),
  }))
  started(res, job)
})

/**
 * Ziel-Länge und Bereich (Sekunden der Quelle) für die Highlights. Ohne
 * Bereich gilt das ganze Video; ein Bereich außerhalb wird abgelehnt.
 */
export function parseHighlightRequest(
  body: Record<string, unknown>,
  duration: number,
): { target: number; from: number; to: number } {
  const rawTarget = Number(body.target)
  const target = Number.isFinite(rawTarget)
    ? Math.round(Math.min(MAX_HIGHLIGHT_TARGET, Math.max(MIN_HIGHLIGHT_TARGET, rawTarget)))
    : DEFAULT_HIGHLIGHT_TARGET
  const total = duration > 0 ? duration : Infinity
  const num = (v: unknown, def: number) => {
    const n = v === undefined || v === null ? NaN : Number(v)
    return Number.isFinite(n) ? n : def
  }
  const from = Math.max(0, num(body.from, 0))
  const to = Math.min(total, num(body.to, total))
  if (!(to - from >= 1)) throw new ValidationError('Der Bereich ist zu kurz für Highlights.')
  return { target, from, to }
}

aiRouter.post('/ai/highlights', json, (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>
  const item = requireMedia(body)
  const t = requireTranscript(item)
  requireClaude()
  const { target, from, to } = parseHighlightRequest(body, item.info.duration)
  if (!capacity('claude', res)) return
  const job = aiJobs.start('claude', async (signal) => ({
    highlights: await createHighlights(t.words, target, from, to, signal),
  }))
  started(res, job)
})

/** Höchstens so viele Ton-Abschnitte der Timeline gehen an Claude. */
export const MAX_PUBLISH_SEGMENTS = 300

/**
 * Ein Ton-Abschnitt der Timeline: Quelle `mediaId` von `from` bis `to`
 * (Sekunden der Quelle) liegt ab `at` (Sekunden der Timeline) mit Tempo `speed`.
 */
export interface PublishSegment {
  mediaId: string
  from: number
  to: number
  at: number
  speed: number
}

/** Prüft die Abschnitte und die Länge des Videos für POST /api/ai/publish. */
export function parsePublishRequest(body: Record<string, unknown>): {
  segments: PublishSegment[]
  target: PublishTarget
  duration: number
} {
  const list = body.segments
  if (!Array.isArray(list) || list.length === 0) {
    throw new ValidationError('Keine Abschnitte mit Ton angegeben.')
  }
  if (list.length > MAX_PUBLISH_SEGMENTS) {
    throw new ValidationError(`Maximal ${MAX_PUBLISH_SEGMENTS} Abschnitte.`)
  }
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN)
  const segments = list.map((raw, i): PublishSegment => {
    const s = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    const from = num(s.from)
    const to = num(s.to)
    const at = num(s.at)
    const speed = num(s.speed)
    if (!isMediaId(s.mediaId) || !(from >= 0) || !(to > from) || !(at >= 0)) {
      throw new ValidationError(`Abschnitt ${i + 1} ist ungültig.`)
    }
    if (!(speed >= 0.1 && speed <= 16))
      throw new ValidationError(`Abschnitt ${i + 1}: Tempo ungültig.`)
    return { mediaId: s.mediaId, from, to, at, speed }
  })
  const end = Math.max(...segments.map((s) => s.at + (s.to - s.from) / s.speed))
  const rawDuration = num(body.duration)
  const duration = rawDuration > 0 ? Math.max(rawDuration, end) : end
  const target = (PUBLISH_TARGETS as readonly unknown[]).includes(body.target)
    ? (body.target as PublishTarget)
    : 'original'
  return { segments, target, duration }
}

/**
 * Wörter der Abschnitte in Timeline-Zeit, nach Anfang sortiert. Ein Wort zählt,
 * wenn es im verwendeten Teil der Quelle liegt (50 ms Spielraum wie bei den
 * Highlights). Liegen Abschnitte übereinander, kommen beide Wörter vor.
 */
export function timelineWords(
  segments: readonly PublishSegment[],
  transcriptOf: (mediaId: string) => Transcript,
): Word[] {
  const out: Word[] = []
  for (const s of segments) {
    for (const w of transcriptOf(s.mediaId).words) {
      if (w.start < s.from - 0.05 || w.end > s.to + 0.05) continue
      const map = (t: number) =>
        Math.round((s.at + (Math.min(s.to, Math.max(s.from, t)) - s.from) / s.speed) * 1000) / 1000
      out.push({ start: map(w.start), end: map(w.end), text: w.text })
    }
  }
  return out.sort((a, b) => a.start - b.start || a.end - b.end)
}

aiRouter.post('/ai/publish', express.json({ limit: '128kb' }), (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>
  const { segments, target, duration } = parsePublishRequest(body)
  const items = new Map<string, MediaItem>()
  for (const s of segments) {
    if (items.has(s.mediaId)) continue
    items.set(s.mediaId, requireMedia({ mediaId: s.mediaId }))
  }
  const transcriptOf = new Map<string, Transcript>()
  for (const item of items.values()) transcriptOf.set(item.id, requireTranscript(item))
  requireClaude()
  const words = timelineWords(segments, (id) => transcriptOf.get(id) as Transcript)
  const language = transcriptOf.get(segments[0].mediaId)?.language ?? 'auto'
  if (!capacity('claude', res)) return
  const job = aiJobs.start('claude', (signal) =>
    createPublishTexts(words, language, target, duration, signal),
  )
  started(res, job)
})

/** Prüft die Wünsche für POST /api/ai/broll (Abschnitte wie bei /api/ai/publish). */
export function parseBrollRequest(body: Record<string, unknown>): {
  segments: PublishSegment[]
  duration: number
  request: BrollRequest
} {
  const { segments, duration } = parsePublishRequest(body)
  const size = parseTargetSize(body)
  const mode = (BROLL_MODES as readonly unknown[]).includes(body.mode)
    ? (body.mode as BrollMode)
    : 'auto'
  const style = (IMAGE_STYLES as readonly unknown[]).includes(body.style)
    ? (body.style as ImageStyle)
    : 'auto'
  const rawCount = Math.round(Number(body.count))
  const count = Number.isFinite(rawCount)
    ? Math.min(MAX_BROLLS, Math.max(1, rawCount))
    : DEFAULT_BROLLS
  return {
    segments,
    duration,
    request: {
      mode,
      style,
      aspect: nearestAspect(size.width, size.height),
      language: body.language === 'en' ? 'en' : 'de',
      count,
    },
  }
}

aiRouter.post('/ai/broll', express.json({ limit: '128kb' }), (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>
  const { segments, duration, request } = parseBrollRequest(body)
  const transcriptOf = new Map<string, Transcript>()
  for (const s of segments) {
    if (transcriptOf.has(s.mediaId)) continue
    transcriptOf.set(s.mediaId, requireTranscript(requireMedia({ mediaId: s.mediaId })))
  }
  requireClaude()
  const words = timelineWords(segments, (id) => transcriptOf.get(id) as Transcript)
  if (!capacity('claude', res)) return
  const job = aiJobs.start('claude', async (signal) => ({
    suggestions: await createBrollSuggestions(words, request, duration, signal),
  }))
  started(res, job)
})

/** Prüft die zu übersetzenden Texte (wie die Text-Einblendungen begrenzt). */
export function parseTranslateTexts(v: unknown): string[] {
  if (!Array.isArray(v) || v.length === 0) throw new ValidationError('Keine Texte angegeben.')
  if (v.length > MAX_TEXT_OVERLAYS) {
    throw new ValidationError(`Maximal ${MAX_TEXT_OVERLAYS} Texte.`)
  }
  return v.map((t, i) => {
    if (typeof t !== 'string' || !t.trim()) throw new ValidationError(`Text ${i + 1} ist leer.`)
    if (t.length > MAX_TEXT_LENGTH) throw new ValidationError(`Text ${i + 1} ist zu lang.`)
    return t
  })
}

aiRouter.post(
  '/ai/translate',
  // 500 Texte × 300 Zeichen (UTF-8, JSON-maskiert) passen sicher hinein.
  express.json({ limit: '1mb' }),
  (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const texts = parseTranslateTexts(body.texts)
    requireClaude()
    const target = (TRANSLATE_TARGETS as readonly unknown[]).includes(body.target)
      ? (body.target as TranslateTarget)
      : 'en'
    if (!capacity('claude', res)) return
    const job = aiJobs.start('claude', (signal) => translateTexts(texts, target, signal))
    started(res, job)
  },
)

// --- KI-Bilder für Bild-Clips ---------------------------------------------------------

function requireGemini(): void {
  if (!geminiReady()) {
    throw new ValidationError(
      'Die Bilderzeugung ist nicht eingerichtet (GEMINI_API_KEY fehlt in der Server-.env).',
      503,
    )
  }
}

/** Gewähltes Modell prüfen (leer = Voreinstellung der Server-.env). */
function requireModel(kind: ModelKind, wanted: unknown): string {
  const model = resolveModel(kind, wanted)
  if (!model) throw new ValidationError('Unbekanntes oder unpassendes Gemini-Modell.')
  return model
}

/** GET /api/ai/models -> wählbare Bild- und Videomodelle (live von Google, 1 h gemerkt). */
aiRouter.get('/ai/models', (_req: Request, res: Response, next: NextFunction) => {
  listModels()
    .then((m) => res.json(m))
    .catch(next)
})

export const MAX_IDEA_LENGTH = 500

/** Zielgröße des Bild-Clips (für Seitenverhältnis und Auflösung). */
export function parseTargetSize(body: Record<string, unknown>): { width: number; height: number } {
  const w = Number(body.width)
  const h = Number(body.height)
  if (!(Number.isFinite(w) && Number.isFinite(h) && w >= 16 && h >= 16 && w <= 8192 && h <= 8192)) {
    throw new ValidationError('Ungültige Bildgröße.')
  }
  return { width: Math.round(w), height: Math.round(h) }
}

/** Nachbarclip für den Kontext: { mediaId, time } – unbekannte Videos werden übergangen. */
export function parseSceneRef(v: unknown): { item: MediaItem; time: number } | null {
  if (typeof v !== 'object' || v === null) return null
  const r = v as Record<string, unknown>
  if (!isMediaId(r.mediaId)) return null
  const item = mediaStore.get(r.mediaId)
  if (!item) return null
  const dur = item.info.duration > 0 ? item.info.duration : 0
  const raw = Number(r.time)
  const time = Number.isFinite(raw) ? Math.max(0, dur > 0 ? Math.min(raw, dur - 0.05) : raw) : 0
  return { item, time: Math.max(0, time) }
}

/** Transkript-Ausschnitt (max. 30 s / 120 Wörter) vor bzw. nach `time`. */
export function transcriptExcerpt(mediaId: string, time: number, role: 'before' | 'after'): string {
  const t = transcripts.get(mediaId)
  if (!t) return ''
  const words =
    role === 'before'
      ? t.words.filter((w) => w.end <= time + 0.05 && w.start >= time - 30).slice(-120)
      : t.words.filter((w) => w.start >= time - 0.05 && w.end <= time + 30).slice(0, 120)
  return words.map((w) => w.text).join(' ')
}

/** Ein verkleinertes Standbild (JPEG, max. 768 px) aus einem Video. */
async function grabFrame(item: MediaItem, time: number): Promise<Buffer | null> {
  if (!(item.info.width > 0)) return null
  const out = path.join(config.tmpDir, `${randomUUID()}-frame.jpg`)
  try {
    await runFfmpeg(
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-ss',
        time.toFixed(3),
        '-i',
        item.path,
        '-frames:v',
        '1',
        '-vf',
        'scale=768:768:force_original_aspect_ratio=decrease',
        '-q:v',
        '5',
        '-y',
        out,
      ],
      0,
      () => {},
    ).promise
    return await readFile(out)
  } catch {
    // Ohne Standbild geht es auch (z. B. Zeit hinter dem letzten Bild).
    return null
  } finally {
    await rm(out, { force: true }).catch(() => {})
  }
}

/** Gemeinsamer Ablauf für Bild- und Video-Prompt (Stichworte, Stil, Nachbarclips). */
function startPromptJob(kind: 'image' | 'video', req: Request, res: Response): void {
  const body = (req.body ?? {}) as Record<string, unknown>
  const idea = typeof body.idea === 'string' ? body.idea.trim() : ''
  if (idea.length > MAX_IDEA_LENGTH) {
    throw new ValidationError(`Die Stichworte sind zu lang (max. ${MAX_IDEA_LENGTH} Zeichen).`)
  }
  const size = parseTargetSize(body)
  const style = (IMAGE_STYLES as readonly unknown[]).includes(body.style)
    ? (body.style as ImageStyle)
    : 'auto'
  const language = body.language === 'en' ? 'en' : 'de'
  const refs = [
    { role: 'before' as const, ref: parseSceneRef(body.before) },
    { role: 'after' as const, ref: parseSceneRef(body.after) },
  ].filter((r) => r.ref !== null) as {
    role: 'before' | 'after'
    ref: { item: MediaItem; time: number }
  }[]
  if (!idea && refs.length === 0) {
    throw new ValidationError('Bitte Stichworte eingeben oder Nachbarclips einbeziehen.')
  }
  requireClaude()
  if (!capacity('claude', res)) return

  const ids = refs.map((r) => r.ref.item.id)
  mediaStore.acquire(ids)
  const job = aiJobs.start('claude', async (signal, progress) => {
    let scenes: ImageContextScene[]
    try {
      scenes = await Promise.all(
        refs.map(async ({ role, ref }) => ({
          role,
          name: ref.item.name,
          jpeg: await grabFrame(ref.item, ref.time),
          transcript: transcriptExcerpt(ref.item.id, ref.time, role),
        })),
      )
    } finally {
      await mediaStore.release(ids)
    }
    progress(20)
    if (kind === 'video') {
      return createVideoPrompt(
        {
          idea,
          style,
          aspect: videoAspectFor(size.width, size.height),
          language,
          scenes,
          duration: clampVideoDuration(body.duration),
        },
        signal,
      )
    }
    return createImagePrompt(
      { idea, style, aspect: nearestAspect(size.width, size.height), language, scenes },
      signal,
    )
  })
  started(res, job)
}

aiRouter.post('/ai/image-prompt', json, (req: Request, res: Response) =>
  startPromptJob('image', req, res),
)
aiRouter.post('/ai/video-prompt', json, (req: Request, res: Response) =>
  startPromptJob('video', req, res),
)

/** Name des KI-Video-Clips in der Liste. */
export function aiVideoName(duration: number): string {
  return `KI-Video_${Math.round(duration)}s.mp4`
}

/**
 * POST /api/ai/video { prompt, width, height, duration } -> Job. Ergebnis:
 * { media, saved, galleryError }. Das Video landet als normales Video in der
 * Bibliothek (wie ein Bild-Clip) und zusätzlich dauerhaft in der Galerie.
 */
aiRouter.post('/ai/video', json, (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
  if (!prompt) throw new ValidationError('Bitte einen Prompt eingeben.')
  if (prompt.length > MAX_PROMPT_LENGTH) {
    throw new ValidationError(`Der Prompt ist zu lang (max. ${MAX_PROMPT_LENGTH} Zeichen).`)
  }
  const size = parseTargetSize(body)
  const duration = clampVideoDuration(body.duration)
  const model = requireModel('video', body.model)
  requireGemini()
  if (!capacity('video', res)) return
  const job = aiJobs.start('video', async (signal, progress) => {
    const data = await generateVideo(
      prompt,
      videoAspectFor(size.width, size.height),
      duration,
      signal,
      progress,
      undefined,
      model,
    )
    // Zuerst in die Galerie: Das bezahlte Video soll nie verloren gehen.
    let saved = 0
    let galleryError = ''
    try {
      await gallery.add(data, 'video/mp4', prompt, model)
      saved = 1
    } catch (err) {
      galleryError =
        err instanceof GalleryFullError
          ? err.message
          : 'Das Video konnte nicht in der Galerie gespeichert werden.'
      if (!(err instanceof GalleryFullError)) console.error('Galerie:', err)
    }
    const file = path.join(config.tmpDir, `${randomUUID()}-ai-video.mp4`)
    let stored = false
    try {
      await writeFile(file, data)
      const info = await probeMedia(file).catch(() => {
        throw new Error('Gemini lieferte keine gültige Videodatei.')
      })
      const item = await mediaStore.add(file, aiVideoName(info.duration || duration), info)
      stored = true
      return { media: mediaView(item), saved, galleryError, model }
    } catch (err) {
      if (err instanceof StorageFullError && saved) {
        throw new Error(`${err.message} Das Video liegt in der Galerie.`)
      }
      throw err
    } finally {
      if (!stored) await rm(file, { force: true }).catch(() => {})
    }
  })
  started(res, job)
})

aiRouter.post('/ai/images', json, (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
  if (!prompt) throw new ValidationError('Bitte einen Prompt eingeben.')
  if (prompt.length > MAX_PROMPT_LENGTH) {
    throw new ValidationError(`Der Prompt ist zu lang (max. ${MAX_PROMPT_LENGTH} Zeichen).`)
  }
  const size = parseTargetSize(body)
  const rawCount = Math.round(Number(body.count))
  const count = Number.isFinite(rawCount)
    ? Math.min(MAX_IMAGE_COUNT, Math.max(MIN_IMAGE_COUNT, rawCount))
    : 2
  const model = requireModel('image', body.model)
  requireGemini()
  if (!capacity('image', res)) return
  const aspect = nearestAspect(size.width, size.height)
  const job = aiJobs.start('image', async (signal, progress) => {
    const r = await generateImages(
      prompt,
      aspect,
      imageSizeFor(size.width, size.height),
      count,
      signal,
      progress,
      model,
    )
    return { ...r, ...(await saveToGallery(r.images, prompt, gallery, model)), model }
  })
  started(res, job)
})

/**
 * Legt die erzeugten Bilder in der Galerie ab. Ein Fehler dabei (z. B. Galerie
 * voll) lässt die Erzeugung nicht scheitern: `galleryError` meldet ihn.
 */
export async function saveToGallery(
  images: { id: string }[],
  prompt: string,
  target: Gallery = gallery,
  model = '',
): Promise<{ saved: number; galleryError: string }> {
  let saved = 0
  let galleryError = ''
  for (const ref of images) {
    const img = getImage(ref.id)
    if (!img) continue
    try {
      await target.add(img.data, img.mime, prompt, model)
      saved++
    } catch (err) {
      galleryError ||=
        err instanceof GalleryFullError
          ? err.message
          : 'Das Bild konnte nicht in der Galerie gespeichert werden.'
      if (!(err instanceof GalleryFullError)) console.error('Galerie:', err)
    }
  }
  return { saved, galleryError }
}

// --- Galerie der KI-Bilder (dauerhaft auf dem Server) ------------------------------

function galleryView(i: GalleryImage): GalleryImage {
  return {
    id: i.id,
    mime: i.mime,
    prompt: i.prompt,
    createdAt: i.createdAt,
    size: i.size,
    model: i.model,
  }
}

aiRouter.get('/ai/gallery', (_req: Request, res: Response, next: NextFunction) => {
  gallery
    .init()
    .then(() =>
      res.json({
        images: gallery.list().map(galleryView),
        totalBytes: gallery.totalBytes,
        maxBytes: config.maxGalleryTotalBytes,
      }),
    )
    .catch(next)
})

function sendGalleryFile(thumb: boolean) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const id = req.params.id
    void (async () => {
      const f = isGalleryId(id) ? await gallery.pathOf(id, thumb) : null
      if (!f) {
        res.status(404).json({ error: 'Bild nicht in der Galerie.' })
        return
      }
      res.setHeader('Content-Type', f.mime)
      // Inhalt je ID unveränderlich -> lange cachen.
      res.setHeader('Cache-Control', 'private, max-age=86400, immutable')
      // Der Standardordner liegt unter ~/.video-cutter (Punkt-Ordner).
      res.sendFile(f.path, { dotfiles: 'allow' }, (err) => {
        if (err && !res.headersSent) res.status(404).end()
      })
    })().catch(next)
  }
}

aiRouter.get('/ai/gallery/:id/file', sendGalleryFile(false))
aiRouter.get('/ai/gallery/:id/thumb', sendGalleryFile(true))

/**
 * POST /api/ai/gallery/:id/media -> 201 MediaView. Legt ein Galerie-Video als
 * (temporäres) Bibliotheks-Video an, damit es in die Liste eingefügt werden kann.
 */
aiRouter.post('/ai/gallery/:id/media', (req: Request, res: Response, next: NextFunction) => {
  const id = req.params.id
  void (async () => {
    const img = isGalleryId(id) ? gallery.get(id) : undefined
    const src = img ? await gallery.pathOf(img.id, false) : null
    if (!img || !src) {
      res.status(404).json({ error: 'Video nicht in der Galerie.' })
      return
    }
    if (img.mime !== 'video/mp4') throw new ValidationError('Dieser Eintrag ist kein Video.')
    const file = path.join(config.tmpDir, `${randomUUID()}-gallery-video.mp4`)
    let stored = false
    try {
      await copyFile(src.path, file)
      const info = await probeMedia(file)
      const item = await mediaStore.add(file, aiVideoName(info.duration), info)
      stored = true
      res.status(201).json(mediaView(item))
    } catch (err) {
      if (err instanceof StorageFullError) {
        res.status(err.statusCode).json({ error: err.message })
        return
      }
      throw err
    } finally {
      if (!stored) await rm(file, { force: true }).catch(() => {})
    }
  })().catch(next)
})

aiRouter.delete('/ai/gallery/:id', (req: Request, res: Response, next: NextFunction) => {
  const id = req.params.id
  void (async () => {
    const ok = isGalleryId(id) && (await gallery.remove(id))
    res.status(ok ? 200 : 404).json({ deleted: ok })
  })().catch(next)
})

aiRouter.get('/ai/images/:id', (req: Request, res: Response) => {
  const img = getImage(req.params.id)
  if (!img) {
    res.status(404).json({ error: 'Bild nicht (mehr) vorhanden. Bitte neu erzeugen.' })
    return
  }
  res.setHeader('Content-Type', img.mime)
  res.setHeader('Cache-Control', 'private, max-age=1800')
  res.end(img.data)
})

/** GET /api/ai/jobs/:id/events (Server-Sent Events) – bis fertig/fehlerhaft. */
aiRouter.get('/ai/jobs/:id/events', (req: Request, res: Response) => {
  const first = aiJobs.get(req.params.id)
  if (!first) {
    res.status(404).end()
    return
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  const send = (s: AiJobSnapshot) => res.write(`data: ${JSON.stringify(s)}\n\n`)
  send(first)
  if (first.state !== 'processing') {
    res.end()
    return
  }
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000)
  const unsub = aiJobs.subscribe(req.params.id, (s) => {
    send(s)
    if (s.state !== 'processing') {
      clearInterval(heartbeat)
      res.end()
    }
  })
  req.on('close', () => {
    clearInterval(heartbeat)
    unsub()
  })
})

aiRouter.delete('/ai/jobs/:id', (req: Request, res: Response) => {
  const ok = aiJobs.cancel(req.params.id)
  res.status(ok ? 200 : 404).json({ cancelled: ok })
})

// --- KI-Sprecher (Claude schreibt/übersetzt, ElevenLabs spricht) -----------------------

export type ScriptRequest =
  | { mode: 'write'; idea: string; language: string; seconds: number }
  | { mode: 'translate'; text: string; language: string }

/** Prüft POST /api/ai/script. */
export function parseScriptRequest(body: Record<string, unknown>): ScriptRequest {
  const language = typeof body.language === 'string' ? body.language : ''
  if (!SCRIPT_LANGUAGES.includes(language)) throw new ValidationError('Unbekannte Sprache.')
  if (body.mode === 'translate') {
    const text = typeof body.text === 'string' ? body.text.trim() : ''
    if (!text) throw new ValidationError('Bitte zuerst einen Text eingeben.')
    if (text.length > MAX_SCRIPT_LENGTH) {
      throw new ValidationError(`Der Text ist zu lang (max. ${MAX_SCRIPT_LENGTH} Zeichen).`)
    }
    return { mode: 'translate', text, language }
  }
  if (body.mode !== 'write') throw new ValidationError('Unbekannte Aktion.')
  const idea = typeof body.idea === 'string' ? body.idea.trim() : ''
  if (!idea) throw new ValidationError('Bitte beschreiben, worum es gehen soll.')
  if (idea.length > MAX_SCRIPT_IDEA) {
    throw new ValidationError(`Die Beschreibung ist zu lang (max. ${MAX_SCRIPT_IDEA} Zeichen).`)
  }
  const raw = Math.round(Number(body.seconds))
  const seconds = Number.isFinite(raw)
    ? Math.min(MAX_SCRIPT_SECONDS, Math.max(MIN_SCRIPT_SECONDS, raw))
    : 30
  return { mode: 'write', idea, language, seconds }
}

aiRouter.post('/ai/script', json, (req: Request, res: Response) => {
  const request = parseScriptRequest((req.body ?? {}) as Record<string, unknown>)
  requireClaude()
  if (!capacity('claude', res)) return
  const job = aiJobs.start('claude', (signal) =>
    request.mode === 'write'
      ? writeScript(request.idea, request.language, request.seconds, signal)
      : translateScript(request.text, request.language, signal),
  )
  started(res, job)
})

function requireElevenlabs(): void {
  if (!elevenlabsReady()) {
    throw new ValidationError(
      'Der KI-Sprecher ist nicht eingerichtet (ELEVENLABS_API_KEY fehlt in der Server-.env).',
      503,
    )
  }
}

/** GET /api/ai/voices -> { voices } (10 min gemerkt). */
aiRouter.get('/ai/voices', (_req: Request, res: Response, next: NextFunction) => {
  requireElevenlabs()
  listVoices()
    .then((voices) => res.json({ voices }))
    .catch((err: unknown) =>
      next(new ValidationError(err instanceof Error ? err.message : String(err), 502)),
    )
})

/** Dateiname der Vertonung: „KI-Sprecher <Stimme> hh-mm-ss.mp3“. */
export function voiceOverName(voiceName: unknown, now = new Date()): string {
  const clean =
    typeof voiceName === 'string'
      ? voiceName
          .replace(/[^\p{L}\p{N} _-]/gu, '')
          .trim()
          .slice(0, 40)
      : ''
  const two = (n: number) => String(n).padStart(2, '0')
  const time = `${two(now.getHours())}-${two(now.getMinutes())}-${two(now.getSeconds())}`
  return `KI-Sprecher${clean ? ` ${clean}` : ''} ${time}.mp3`
}

/** Prüft POST /api/ai/voice-over. */
export function parseVoiceOverRequest(body: Record<string, unknown>): {
  text: string
  voiceId: string
  settings: { speed: number; stability: number }
} {
  const text = typeof body.text === 'string' ? body.text.trim() : ''
  if (!text) throw new ValidationError('Bitte zuerst einen Text eingeben.')
  if (text.length > MAX_SCRIPT_LENGTH) {
    throw new ValidationError(`Der Text ist zu lang (max. ${MAX_SCRIPT_LENGTH} Zeichen).`)
  }
  if (!isVoiceId(body.voiceId)) throw new ValidationError('Bitte eine Stimme wählen.')
  return { text, voiceId: body.voiceId, settings: parseVoiceSettings(body) }
}

/**
 * POST /api/ai/voice-over -> Job. Ergebnis: { media } – die Vertonung liegt
 * als Tondatei in der Bibliothek (wie ein Upload) und kann auf die Timeline.
 */
aiRouter.post('/ai/voice-over', json, (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>
  const request = parseVoiceOverRequest(body)
  requireElevenlabs()
  if (!capacity('voice', res)) return
  const name = voiceOverName(body.voiceName)
  const job = aiJobs.start('voice', async (signal, progress) => {
    progress(5)
    const data = await synthesizeSpeech(request.text, request.voiceId, request.settings, signal)
    progress(90)
    const file = path.join(config.tmpDir, `${randomUUID()}-voice.mp3`)
    let stored = false
    try {
      await writeFile(file, data)
      const info = await probeMedia(file).catch(() => {
        throw new Error('ElevenLabs lieferte keine gültige Tondatei.')
      })
      if (!info.hasAudio || !(info.duration > 0)) {
        throw new Error('ElevenLabs lieferte keine gültige Tondatei.')
      }
      const item = await mediaStore.add(file, name, info, data.length)
      stored = true
      return { media: mediaView(item) }
    } finally {
      if (!stored) await rm(file, { force: true }).catch(() => {})
    }
  })
  started(res, job)
})
