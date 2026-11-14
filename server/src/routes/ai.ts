import express, { Router, type Request, type Response } from 'express'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { config } from '../config'
import { runFfmpeg } from '../lib/ffmpeg'
import { isMediaId, mediaStore, type MediaItem } from '../lib/media'
import { ValidationError } from '../lib/validate'
import { aiJobs, type AiJobKind, type AiJobSnapshot } from '../lib/aiJobs'
import {
  TRANSCRIBE_LANGUAGES,
  transcribeFile,
  whisperReady,
  type TranscribeLanguage,
  type Transcript,
} from '../lib/whisper'
import {
  SUBTITLE_TARGETS,
  TRANSLATE_TARGETS,
  claudeReady,
  IMAGE_STYLES,
  createCutSuggestions,
  createImagePrompt,
  createSubtitles,
  translateTexts,
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

/**
 * KI-Funktionen:
 * - POST /api/ai/transcribe { mediaId, language }  -> Whisper-Transkript (pro Video gemerkt)
 * - POST /api/ai/subtitles  { mediaId, target }    -> Untertitel (Claude)
 * - POST /api/ai/cuts       { mediaId, minPause }  -> Schnittvorschläge (Claude + Pausen)
 * - POST /api/ai/translate  { texts, target }      -> vorhandene Texte übersetzen (Claude)
 * - POST /api/ai/image-prompt { idea, style, width, height, language, before?, after? }
 *                                                  -> Bild-Prompt für einen Bild-Clip (Claude)
 * - POST /api/ai/images     { prompt, width, height, count } -> Bildvarianten (Gemini)
 * - GET  /api/ai/images/:id                         -> erzeugtes Bild (30 min abrufbar)
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
export function aiStatus(): { transcribe: boolean; claude: boolean; image: boolean } {
  return { transcribe: whisperReady(), claude: claudeReady(), image: geminiReady() }
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

aiRouter.post('/ai/image-prompt', json, (req: Request, res: Response) => {
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
    return createImagePrompt(
      { idea, style, aspect: nearestAspect(size.width, size.height), language, scenes },
      signal,
    )
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
  requireGemini()
  if (!capacity('image', res)) return
  const aspect = nearestAspect(size.width, size.height)
  const job = aiJobs.start('image', (signal, progress) =>
    generateImages(prompt, aspect, imageSizeFor(size.width, size.height), count, signal, progress),
  )
  started(res, job)
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
