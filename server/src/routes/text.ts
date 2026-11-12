import express, { Router, type Request, type Response, type NextFunction } from 'express'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { rm, writeFile } from 'node:fs/promises'
import { config } from '../config'
import { PROGRESS, reencodeCodecs } from '../lib/args'
import { isMediaId, mediaStore } from '../lib/media'
import { buildAss, buildTextFilter, parseTextOverlays } from '../lib/textOverlay'
import { customFontView, customFontsEnv, listCustomFonts } from '../lib/customFonts'
import { safeBaseName, safeExt, ValidationError } from '../lib/validate'
import { jobManager } from '../lib/jobs'

const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res, next).catch(next)

/** FFmpeg-Argumente: Text (ASS) einbrennen, Ton neu kodieren wie beim Schneiden. */
export function buildTextArgs(
  inputPath: string,
  assPath: string,
  fontsDir: string,
  outputPath: string,
): string[] {
  return [
    ...PROGRESS,
    '-i',
    inputPath,
    '-vf',
    buildTextFilter(assPath, fontsDir),
    '-map',
    '0:v:0',
    '-map',
    '0:a:0?',
    ...reencodeCodecs(outputPath),
    outputPath,
  ]
}

export const textRouter = Router()

/** GET /api/fonts -> { fonts: CustomFontView[] } – eigene Schriften des Servers. */
textRouter.get('/fonts', (_req: Request, res: Response) => {
  res.json({ fonts: listCustomFonts().map(customFontView) })
})

/**
 * POST /api/text  (JSON: { mediaId, texts: TextOverlay[] })
 * Brennt die Texte in ein Bibliotheks-Video ein. Das Ergebnis wird als neues
 * Bibliotheks-Video gespeichert (wie „Schneiden" mit storeResult); Fortschritt
 * und Abbruch laufen über die bekannten Job-Endpunkte (/api/cut/:id/…).
 * Antwort: 202 { jobId, text: true, storeResult: true }
 */
textRouter.post(
  '/text',
  express.json({ limit: '256kb' }),
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    if (!isMediaId(body.mediaId)) throw new ValidationError('Kein Video angegeben.')
    const item = mediaStore.get(body.mediaId)
    if (!item) throw new ValidationError('Video nicht (mehr) auf dem Server vorhanden.')
    const { width, height, duration } = item.info
    const texts = parseTextOverlays(body.texts, duration)

    if (!jobManager.hasCapacity()) {
      res.setHeader('Retry-After', '30')
      res.status(429).json({ error: 'Server ausgelastet. Bitte gleich erneut versuchen.' })
      return
    }

    const id = randomUUID()
    const assPath = path.join(config.tmpDir, `${id}-text.ass`)
    const outExt = safeExt(item.name) === 'webm' ? 'webm' : 'mp4'
    const outputPath = path.join(config.tmpDir, `${id}-out.${outExt}`)

    // Sperre sofort setzen; bei Fehlern vor dem Job-Start wieder freigeben.
    mediaStore.acquire([item.id])
    try {
      await writeFile(assPath, buildAss(texts, width, height), 'utf8')
      const baseName = safeBaseName(item.name).replace(/_text$/, '')
      const job = jobManager.create({
        id,
        inputPath: item.path,
        ownsInput: false,
        // Die .ass-Datei gehört dem Job und wird danach gelöscht.
        extraInputPaths: [assPath],
        mediaRefs: [item.id],
        storeResult: true,
        outputPath,
        outputName: `${baseName}_text.${outExt}`,
      })
      void jobManager.run(
        job,
        buildTextArgs(item.path, assPath, config.fontsDir, outputPath),
        duration,
        customFontsEnv(),
      )
      res.status(202).json({ jobId: id, text: true, storeResult: true })
    } catch (err) {
      await rm(assPath, { force: true }).catch(() => {})
      await mediaStore.release([item.id])
      throw err
    }
  }),
)
