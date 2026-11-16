import express, { Router, type NextFunction, type Request, type Response } from 'express'
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { config } from '../config'
import { customFontsEnv } from '../lib/customFonts'
import { jobManager } from '../lib/jobs'
import { mediaStore } from '../lib/media'
import { buildRenderArgs, compileTimeline } from '../lib/render/compile'
import { docDuration, parseTimelineDoc } from '../lib/render/doc'
import { graphicStore, resolveDocGraphics } from '../lib/render/graphics'
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
  /** Lautstärke des fertigen Tons angleichen. */
  normalizeAudio: boolean
}

/** Liest die Export-Einstellungen; Unbekanntes fällt auf den Standard zurück. */
export function parseRenderRequest(body: unknown): RenderRequest {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const quality: RenderQuality =
    typeof b.quality === 'string' && Object.hasOwn(RENDER_QUALITIES, b.quality)
      ? (b.quality as RenderQuality)
      : 'standard'
  const base = typeof b.name === 'string' ? safeBaseName(b.name) : 'video'
  return {
    quality,
    outputName: `${base === 'video' ? 'projekt' : base}.mp4`,
    normalizeAudio: b.normalizeAudio === true,
  }
}

export const renderRouter = Router()

/**
 * POST /api/render  { doc, quality?, name?, normalizeAudio? }
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
    const { graphics, missing } = resolveDocGraphics(parsed.doc, (g) => graphicStore.get(g))
    if (missing.length > 0) {
      // Der Editor lädt die Bilder erneut hoch und startet den Export noch einmal.
      res.status(409).json({
        error: 'Eine Grafik liegt nicht mehr auf dem Server. Bitte erneut versuchen.',
        missingGraphics: missing,
      })
      return
    }
    const compiled = compileTimeline(parsed.doc, {
      sources,
      graphics,
      normalizeAudio: settings.normalizeAudio,
    })
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
    // Texte: Die Untertitel-Datei gehört dem Auftrag und wird danach gelöscht.
    const assPath = compiled.ass === undefined ? null : path.join(config.tmpDir, `${id}-text.ass`)
    const args = buildRenderArgs(compiled, {
      ...(assPath ? { assPath, fontsDir: config.fontsDir } : {}),
      output: outputPath,
      preset: 'medium',
      crf: RENDER_QUALITIES[settings.quality],
      audioBitrate: '192k',
    })
    // Verwendete Videos für die Dauer des Exports gegen Löschen sperren.
    if (assPath) await writeFile(assPath, compiled.ass ?? '', 'utf8')
    const refs = Object.keys(sources)
    mediaStore.acquire(refs)
    const job = jobManager.create({
      id,
      inputPath: '',
      ownsInput: false,
      extraInputPaths: assPath ? [assPath] : [],
      mediaRefs: refs,
      outputPath,
      outputName: settings.outputName,
    })
    // Nicht awaiten: läuft im Hintergrund, der Client verfolgt den Fortschritt.
    void jobManager.run(job, args, compiled.duration, assPath ? customFontsEnv() : undefined)

    res.status(202).json({
      jobId: id,
      width: compiled.width,
      height: compiled.height,
      /** Länge in Sekunden. */
      duration: compiled.duration,
    })
  }),
)
