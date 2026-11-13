import express, { Router, type Request, type Response, type NextFunction } from 'express'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { rm, writeFile } from 'node:fs/promises'
import { config } from '../config'
import { PROGRESS, reencodeCodecs } from '../lib/args'
import { isMediaId, mediaStore } from '../lib/media'
import { buildAss, buildTextFilter, parseTextOverlays } from '../lib/textOverlay'
import {
  buildGraphicsFilterComplex,
  graphicInputArgs,
  parseGraphicOverlays,
  type GraphicOverlay,
} from '../lib/graphicOverlay'
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

/**
 * FFmpeg-Argumente mit Grafiken (PNG-Standbilder per overlay), optional
 * zusätzlich Texte (ASS) darüber. Ohne Grafiken: genau buildTextArgs.
 */
export function buildOverlayArgs(params: {
  inputPath: string
  assPath: string | null
  fontsDir: string
  graphics: GraphicOverlay[]
  graphicPaths: string[]
  width: number
  height: number
  duration: number
  outputPath: string
}): string[] {
  const { inputPath, assPath, fontsDir, graphics, graphicPaths, outputPath } = params
  if (!graphics.length) {
    if (!assPath) throw new ValidationError('Keine Texte oder Grafiken angegeben.')
    return buildTextArgs(inputPath, assPath, fontsDir, outputPath)
  }
  const textFilter = assPath ? buildTextFilter(assPath, fontsDir) : undefined
  return [
    ...PROGRESS,
    '-i',
    inputPath,
    ...graphicInputArgs(graphicPaths, params.duration),
    '-filter_complex',
    buildGraphicsFilterComplex(graphics, params.width, params.height, textFilter),
    '-map',
    '[vout]',
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
 * POST /api/text  (JSON: { mediaId, texts?: TextOverlay[], graphics?: GraphicOverlay[] })
 * Brennt Texte und/oder Grafiken (PNG, siehe graphicOverlay) in ein
 * Bibliotheks-Video ein. Das Ergebnis wird als neues
 * Bibliotheks-Video gespeichert (wie „Schneiden" mit storeResult); Fortschritt
 * und Abbruch laufen über die bekannten Job-Endpunkte (/api/cut/:id/…).
 * Antwort: 202 { jobId, text: true, graphics: true, storeResult: true }
 */
textRouter.post(
  '/text',
  // Grafiken/Bilder kommen als Base64-PNGs (max. 48 MB dekodiert, siehe
  // graphicOverlay; Base64 = 4/3 davon + Texte).
  express.json({ limit: '70mb' }),
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    if (!isMediaId(body.mediaId)) throw new ValidationError('Kein Video angegeben.')
    const item = mediaStore.get(body.mediaId)
    if (!item) throw new ValidationError('Video nicht (mehr) auf dem Server vorhanden.')
    const { width, height, duration } = item.info
    const graphics = parseGraphicOverlays(body.graphics, duration)
    const noTexts =
      body.texts === undefined || (Array.isArray(body.texts) && body.texts.length === 0)
    // Texte sind optional, sobald Grafiken dabei sind (sonst Pflicht wie bisher).
    const texts = graphics.length && noTexts ? [] : parseTextOverlays(body.texts, duration)

    if (!jobManager.hasCapacity()) {
      res.setHeader('Retry-After', '30')
      res.status(429).json({ error: 'Server ausgelastet. Bitte gleich erneut versuchen.' })
      return
    }

    const id = randomUUID()
    const assPath = texts.length ? path.join(config.tmpDir, `${id}-text.ass`) : null
    const graphicPaths = graphics.map((_, i) => path.join(config.tmpDir, `${id}-g${i + 1}.png`))
    const ownedFiles = [...(assPath ? [assPath] : []), ...graphicPaths]
    const outExt = safeExt(item.name) === 'webm' ? 'webm' : 'mp4'
    const outputPath = path.join(config.tmpDir, `${id}-out.${outExt}`)

    // Sperre sofort setzen; bei Fehlern vor dem Job-Start wieder freigeben.
    mediaStore.acquire([item.id])
    try {
      if (assPath) await writeFile(assPath, buildAss(texts, width, height), 'utf8')
      await Promise.all(graphics.map((g, i) => writeFile(graphicPaths[i]!, g.png)))
      const args = buildOverlayArgs({
        inputPath: item.path,
        assPath,
        fontsDir: config.fontsDir,
        graphics,
        graphicPaths,
        width,
        height,
        duration,
        outputPath,
      })
      const baseName = safeBaseName(item.name).replace(/_text$/, '')
      const job = jobManager.create({
        id,
        inputPath: item.path,
        ownsInput: false,
        // .ass-Datei und PNGs gehören dem Job und werden danach gelöscht.
        extraInputPaths: ownedFiles,
        mediaRefs: [item.id],
        storeResult: true,
        outputPath,
        outputName: `${baseName}_text.${outExt}`,
      })
      void jobManager.run(job, args, duration, customFontsEnv())
      res.status(202).json({ jobId: id, text: true, graphics: true, storeResult: true })
    } catch (err) {
      await Promise.all(ownedFiles.map((p) => rm(p, { force: true }).catch(() => {})))
      await mediaStore.release([item.id])
      throw err
    }
  }),
)
