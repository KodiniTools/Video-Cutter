import { Router, type Request, type Response, type NextFunction } from 'express'
import multer from 'multer'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { rm } from 'node:fs/promises'
import { config } from '../config'
import { probeMedia } from '../lib/probe'
import { runFfmpeg } from '../lib/ffmpeg'
import { jobManager } from '../lib/jobs'
import { buildStillArgs, parseStillParams, stillClipName } from '../lib/stillClip'
import { safeExt, ValidationError } from '../lib/validate'
import { isMediaId, mediaStore, mediaView, StorageFullError } from '../lib/media'

/**
 * Video-Bibliothek: Videos werden EINMAL hochgeladen und dann per ID zum
 * Schneiden/Zusammenfügen benutzt (POST /api/cut mit `mediaId`/`appendMediaIds`).
 */
const upload = multer({
  storage: multer.diskStorage({
    destination: config.tmpDir,
    filename: (_req, file, cb) => cb(null, `${randomUUID()}-media.${safeExt(file.originalname)}`),
  }),
  limits: { fileSize: config.maxFileSizeBytes, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('video/')) cb(null, true)
    else cb(new ValidationError('Nur Videodateien werden akzeptiert.'))
  },
})

/** Bild für einen Bild-Clip (vom Browser bereits in Zielgröße gezeichnet). */
const STILL_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])
const stillUpload = multer({
  storage: multer.diskStorage({
    destination: config.tmpDir,
    filename: (_req, file, cb) => cb(null, `${randomUUID()}-still.${safeExt(file.originalname)}`),
  }),
  limits: { fileSize: 40 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (STILL_IMAGE_TYPES.has(file.mimetype)) cb(null, true)
    else cb(new ValidationError('Nur PNG-, JPEG- oder WebP-Bilder werden akzeptiert.'))
  },
})

/** Laufende Bild-Clip-Berechnungen (kurz, aber nicht parallel). */
let stillActive = 0

const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res, next).catch(next)

/** Anzeigename: Pfadanteile und Steuerzeichen entfernen, Länge begrenzen. */
export function displayName(original: string): string {
  const base = original.split(/[\\/]/).pop() ?? ''
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f"]/g, '').trim()
  return (clean || 'video').slice(0, 200)
}

export const mediaRouter = Router()

/** POST /api/media (multipart: video) -> 201 { id, name, size, duration, width, height, hasAudio } */
mediaRouter.post(
  '/media',
  upload.single('video'),
  asyncHandler(async (req, res) => {
    const file = req.file
    if (!file) throw new ValidationError('Keine Videodatei empfangen.')
    try {
      const info = await probeMedia(file.path)
      if (!(info.duration > 0)) throw new ValidationError('Dauer des Videos unbekannt.')
      const item = await mediaStore.add(file.path, displayName(file.originalname), info, file.size)
      res.status(201).json(mediaView(item))
    } catch (err) {
      await rm(file.path, { force: true }).catch(() => {})
      if (err instanceof StorageFullError) {
        res.status(err.statusCode).json({ error: err.message })
        return
      }
      throw err
    }
  }),
)

/**
 * POST /api/media/still (multipart: image, duration, width, height, fps?, name?)
 * -> 201 MediaView. Erzeugt aus einem Bild einen Video-Clip mit stiller
 * Tonspur und legt ihn in der Bibliothek ab.
 */
mediaRouter.post(
  '/media/still',
  stillUpload.single('image'),
  asyncHandler(async (req, res) => {
    const file = req.file
    const outputPath = path.join(config.tmpDir, `${randomUUID()}-still-out.mp4`)
    let stored = false
    try {
      if (!file) throw new ValidationError('Kein Bild empfangen.')
      const params = parseStillParams((req.body ?? {}) as Record<string, unknown>)
      if (stillActive > 0 || !jobManager.hasCapacity()) {
        res.status(503).json({ error: 'Server ist ausgelastet. Bitte gleich erneut versuchen.' })
        return
      }
      const rawName = typeof req.body?.name === 'string' ? req.body.name.trim() : ''
      const name = rawName ? displayName(rawName) : stillClipName(params.duration)
      stillActive++
      try {
        await runFfmpeg(buildStillArgs(file.path, outputPath, params), params.duration, () => {})
          .promise
      } finally {
        stillActive--
      }
      const info = await probeMedia(outputPath)
      const item = await mediaStore.add(outputPath, name, info)
      stored = true
      res.status(201).json(mediaView(item))
    } catch (err) {
      if (err instanceof StorageFullError) {
        res.status(err.statusCode).json({ error: err.message })
        return
      }
      throw err
    } finally {
      if (file) await rm(file.path, { force: true }).catch(() => {})
      if (!stored) await rm(outputPath, { force: true }).catch(() => {})
    }
  }),
)

/** GET /api/media/:id -> Metadaten */
mediaRouter.get('/media/:id', (req: Request, res: Response) => {
  const item = isMediaId(req.params.id) ? mediaStore.get(req.params.id) : undefined
  if (!item) {
    res.status(404).json({ error: 'Video nicht gefunden.' })
    return
  }
  res.json(mediaView(item))
})

/** GET /api/media/:id/file -> Datei (Wiedergabe/Download) */
mediaRouter.get('/media/:id/file', (req: Request, res: Response) => {
  const item = isMediaId(req.params.id) ? mediaStore.get(req.params.id) : undefined
  if (!item) {
    res.status(404).json({ error: 'Video nicht gefunden.' })
    return
  }
  // Während der Übertragung nicht löschen.
  mediaStore.acquire([item.id])
  let released = false
  const release = () => {
    if (released) return
    released = true
    void mediaStore.release([item.id])
  }
  res.on('close', release)
  res.download(item.path, item.name, (err) => {
    release()
    if (err && !res.headersSent) res.status(500).end()
  })
})

/** DELETE /api/media/:id -> sofort vom Server löschen */
mediaRouter.delete(
  '/media/:id',
  asyncHandler(async (req, res) => {
    const ok = isMediaId(req.params.id) && (await mediaStore.remove(req.params.id))
    res.status(ok ? 200 : 404).json({ deleted: ok })
  }),
)
