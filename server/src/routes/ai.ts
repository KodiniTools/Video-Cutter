import express, { Router, type Request, type Response } from 'express'
import path from 'node:path'
import { config } from '../config'
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
  claudeReady,
  createCutSuggestions,
  createSubtitles,
  type SubtitleTarget,
} from '../lib/claude'
import { MAX_TEXT_OVERLAYS } from '../lib/textOverlay'

/**
 * KI-Funktionen:
 * - POST /api/ai/transcribe { mediaId, language }  -> Whisper-Transkript (pro Video gemerkt)
 * - POST /api/ai/subtitles  { mediaId, target }    -> Untertitel (Claude)
 * - POST /api/ai/cuts       { mediaId, minPause }  -> Schnittvorschläge (Claude + Pausen)
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
export function aiStatus(): { transcribe: boolean; claude: boolean } {
  return { transcribe: whisperReady(), claude: claudeReady() }
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
