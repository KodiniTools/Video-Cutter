import express, { Router, type NextFunction, type Request, type Response } from 'express'
import { config } from '../config'
import { mediaStore } from '../lib/media'
import { CompileError, compileTimeline } from '../lib/render/compile'
import { MICROS_PER_SECOND, docDuration, parseTimelineDoc } from '../lib/render/doc'
import {
  LoudnessCache,
  audioOnlyDoc,
  buildLoudnessArgs,
  loudnessKey,
  runLoudness,
} from '../lib/render/loudness'
import { resolvePreviewSources } from './preview'

const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res, next).catch(next)

/** Gleichzeitige Messungen (nur Ton, aber über die ganze Länge). */
const MAX_RUNNING = 2
let running = 0
const cache = new LoudnessCache()

export const qualityRouter = Router()

/**
 * POST /api/quality/loudness  { doc, duration? }
 * Misst die Lautheit des Tons, so wie der Export ihn mischt (ohne Angleichen).
 * Bild-Spuren zählen nur für die Länge; Texte, Grafiken und Effekte werden
 * ignoriert. `duration` (µs, optional): Länge des ganzen Films, falls Texte
 * oder Grafiken länger sind als die mitgeschickten Spuren. Antwort: integrierte Lautheit (LUFS), Lautheitsumfang (LU), echte
 * Spitze (dBFS) und je 0,1 s Momentan-Lautheit und Spitze.
 */
qualityRouter.post(
  '/quality/loudness',
  express.json({ limit: '2mb' }),
  asyncHandler(async (req, res) => {
    const body = req.body as { doc?: unknown; duration?: unknown } | undefined
    const parsed = parseTimelineDoc(body?.doc)
    if (!parsed.ok) {
      res.status(422).json({ error: 'Ungültiges Timeline-Dokument.', details: parsed.errors })
      return
    }
    const asked =
      typeof body?.duration === 'number' &&
      Number.isSafeInteger(body.duration) &&
      body.duration > 0 &&
      body.duration <= config.maxDurationSec * MICROS_PER_SECOND
        ? body.duration
        : 0
    const end = Math.max(docDuration(parsed.doc), asked)
    if (end <= 0) {
      res.status(422).json({ error: 'Die Timeline ist leer.' })
      return
    }
    const doc = audioOnlyDoc(parsed.doc)
    // Aus den Originalen wie beim Export (die Vorschau-Kopien sind neu kodiert).
    const sources = await resolvePreviewSources(doc, {
      get: (id) => mediaStore.get(id),
      proxy: async () => null,
    })
    let compiled
    try {
      compiled = compileTimeline(doc, {
        sources,
        range: { start: 0, end },
        size: { width: 16, height: 16 },
      })
    } catch (e) {
      if (e instanceof CompileError) {
        res.status(422).json({ error: e.message })
        return
      }
      throw e
    }
    if (compiled.duration > config.maxDurationSec) {
      res
        .status(422)
        .json({ error: `Die Timeline überschreitet das Limit von ${config.maxDurationSec}s.` })
      return
    }
    const args = buildLoudnessArgs(compiled)
    const key = loudnessKey(args)
    const hit = cache.get(key)
    if (hit) {
      res.json(hit)
      return
    }
    if (running >= MAX_RUNNING) {
      res.setHeader('Retry-After', '10')
      res.status(429).json({ error: 'Server ausgelastet. Bitte gleich erneut versuchen.' })
      return
    }
    running++
    try {
      const result = await runLoudness(args, compiled.duration)
      cache.set(key, result)
      res.json(result)
    } catch (e) {
      console.error('Lautheit messen fehlgeschlagen:', e)
      res.status(500).json({ error: 'Der Ton konnte nicht gemessen werden.' })
    } finally {
      running--
    }
  }),
)
