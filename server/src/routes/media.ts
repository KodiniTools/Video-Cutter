import { Router, type Request, type Response, type NextFunction } from 'express'
import multer from 'multer'
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { config } from '../config'
import { probeMedia } from '../lib/probe'
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
