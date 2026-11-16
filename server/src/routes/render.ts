import express, { Router, type NextFunction, type Request, type Response } from 'express'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { config } from '../config'
import { jobManager } from '../lib/jobs'
import { mediaStore } from '../lib/media'
import { buildRenderArgs, compileTimeline } from '../lib/render/compile'
import { docDuration, parseTimelineDoc } from '../lib/render/doc'
import { safeBaseName } from '../lib/validate'
import { resolvePreviewSources } from './preview'

const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res, next).catch(next)

/** Qualitätsstufen des Exports (x264 `crf`, kleiner = besser und größer). */
export const RENDER_QUALITIES = { high: 18, standard: 21, small: 26 } as const
export type RenderQuality = keyof typeof RENDER_QUALITIES

export interface RenderRequest {
  quality: RenderQuality
  /** Dateiname des Ergebnisses (bereinigt, mit `.mp4`). */
  outputName: string
}

/** Liest die Export-Einstellungen; Unbekanntes fällt auf den Standard zurück. */
export function parseRenderRequest(body: unknown): RenderRequest {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const quality: RenderQuality =
    typeof b.quality === 'string' && Object.hasOwn(RENDER_QUALITIES, b.quality)
      ? (b.quality as RenderQuality)
      : 'standard'
  const base = typeof b.name === 'string' ? safeBaseName(b.name) : 'video'
  return { quality, outputName: `${base === 'video' ? 'projekt' : base}.mp4` }
}

export const renderRouter = Router()

/**
 * POST /api/render  { doc, quality?, name? }
 * Rendert die ganze Timeline in voller Größe (H.264 + AAC, MP4) – mit demselben
 * Compiler wie die Vorschau. Antwort 202 `{ jobId }`; Fortschritt, Download und
 * Abbrechen laufen über die Job-Endpunkte `/api/cut/:id/events`,
 * `/api/cut/:id/download` und `DELETE /api/cut/:id`.
 */
renderRouter.post(
  '/render',
  express.json({ limit: '2mb' }),
  asyncHandler(async (req, res) => {
    const body = req.body as { doc?: unknown } | undefined
    const parsed = parseTimelineDoc(body?.doc)
    if (!parsed.ok) {
      res.status(422).json({ error: 'Ungültiges Timeline-Dokument.', details: parsed.errors })
      return
    }
    const settings = parseRenderRequest(body)
    // Export immer aus den Originalen, nie aus den kleinen Vorschau-Kopien.
    const sources = await resolvePreviewSources(parsed.doc, {
      get: (id) => mediaStore.get(id),
      proxy: async () => null,
    })
    if (docDuration(parsed.doc) <= 0) {
      res.status(422).json({ error: 'Die Timeline ist leer.' })
      return
    }
    const compiled = compileTimeline(parsed.doc, { sources })
    if (compiled.duration > config.maxDurationSec) {
      res
        .status(422)
        .json({ error: `Die Timeline überschreitet das Limit von ${config.maxDurationSec}s.` })
      return
    }
    if (!jobManager.hasCapacity()) {
      res.setHeader('Retry-After', '30')
      res.status(429).json({ error: 'Server ausgelastet. Bitte gleich erneut versuchen.' })
      return
    }

    const id = randomUUID()
    const outputPath = path.join(config.tmpDir, `${id}-out.mp4`)
    const args = buildRenderArgs(compiled, {
      output: outputPath,
      preset: 'medium',
      crf: RENDER_QUALITIES[settings.quality],
      audioBitrate: '192k',
    })
    // Verwendete Videos für die Dauer des Exports gegen Löschen sperren.
    const refs = Object.keys(sources)
    mediaStore.acquire(refs)
    const job = jobManager.create({
      id,
      inputPath: '',
      ownsInput: false,
      mediaRefs: refs,
      outputPath,
      outputName: settings.outputName,
    })
    // Nicht awaiten: läuft im Hintergrund, der Client verfolgt den Fortschritt.
    void jobManager.run(job, args, compiled.duration)

    res.status(202).json({
      jobId: id,
      width: compiled.width,
      height: compiled.height,
      /** Länge in Sekunden. */
      duration: compiled.duration,
    })
  }),
)
