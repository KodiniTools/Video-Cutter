import { Router, type Request, type Response, type NextFunction } from 'express'
import multer from 'multer'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { rm } from 'node:fs/promises'
import { config } from '../config'
import { isAudioOnly, probeMedia, type MediaInfo } from '../lib/probe'
import { runFfmpeg } from '../lib/ffmpeg'
import { jobManager } from '../lib/jobs'
import { buildStillArgs, parseStillParams, stillClipName } from '../lib/stillClip'
import { safeExt, ValidationError } from '../lib/validate'
import { isMediaId, mediaStore, mediaView, StorageFullError } from '../lib/media'
import { derivedStore, type DerivedPart } from '../lib/derived'
import { beatStore } from '../lib/beats'

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
    // Tondateien (Musik, Sprachaufnahmen) nutzt der Timeline-Editor auf Ton-Spuren,
    // Bilder (JPEG, PNG, WebP) als Bild-Einblendungen auf Ebenen-Spuren.
    if (
      file.mimetype.startsWith('video/') ||
      file.mimetype.startsWith('audio/') ||
      MEDIA_IMAGE_TYPES.has(file.mimetype)
    )
      cb(null, true)
    else cb(new ValidationError('Nur Video-, Ton- und Bilddateien werden akzeptiert.'))
  },
})

/** Eigene Bilder für Bild-Einblendungen (der Browser zeichnet sie, der Server bewahrt sie auf). */
export const MEDIA_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])
/** Größte Bilddatei (wie im Browser). */
export const MAX_MEDIA_IMAGE_BYTES = 30 * 1024 * 1024
/** Größte Kantenlänge eines Bildes (wie im Browser). */
export const MAX_MEDIA_IMAGE_DIM = 12000

/**
 * Eckdaten eines hochgeladenen Bildes. ffprobe liest JPEG/PNG/WebP als
 * Einzelbild; Dauer und Bildrate haben für ein Bild keine Bedeutung.
 */
export async function probeImage(filePath: string, size: number): Promise<MediaInfo> {
  if (size > MAX_MEDIA_IMAGE_BYTES) throw new ValidationError('Bild zu groß (höchstens 30 MB).')
  let info: MediaInfo
  try {
    info = await probeMedia(filePath)
  } catch {
    throw new ValidationError('Bild kann nicht gelesen werden.')
  }
  if (!(info.width > 0 && info.height > 0))
    throw new ValidationError('Bild kann nicht gelesen werden.')
  if (info.width > MAX_MEDIA_IMAGE_DIM || info.height > MAX_MEDIA_IMAGE_DIM)
    throw new ValidationError('Bild zu groß (höchstens 12000 px Kantenlänge).')
  return {
    width: info.width,
    height: info.height,
    hasAudio: false,
    duration: 0,
    fps: 0,
    hasVideo: true,
    image: true,
  }
}

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

/**
 * POST /api/media (multipart: video; auch Ton- und Bilddateien)
 * -> 201 { id, name, size, duration, width, height, hasAudio, fps, kind }
 * Bilder: kind 'image', duration 0.
 */
mediaRouter.post(
  '/media',
  upload.single('video'),
  asyncHandler(async (req, res) => {
    const file = req.file
    if (!file) throw new ValidationError('Keine Videodatei empfangen.')
    try {
      if (MEDIA_IMAGE_TYPES.has(file.mimetype)) {
        const info = await probeImage(file.path, file.size)
        const item = await mediaStore.add(
          file.path,
          displayName(file.originalname),
          info,
          file.size,
        )
        res.status(201).json(mediaView(item))
        return
      }
      const info = await probeMedia(file.path)
      if (!(info.duration > 0)) throw new ValidationError('Dauer des Videos unbekannt.')
      if (isAudioOnly(info) && !info.hasAudio)
        throw new ValidationError('Die Datei enthält weder Bild noch Ton.')
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
 * POST /api/media/still (multipart: image, duration, width, height, fps?, name?, audio?)
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

/**
 * Abgeleitete Dateien für den Timeline-Editor (Wellenform, Filmstreifen,
 * Vorschau-Kopie). Sie entstehen nur auf Abruf:
 *  - POST /api/media/:id/derived -> 202 Stand; startet fehlende Teile im Hintergrund
 *  - GET  /api/media/:id/derived -> Stand je Teil (missing | queued | running | ready | error | unavailable)
 */
mediaRouter.post(
  '/media/:id/derived',
  asyncHandler(async (req, res) => {
    const status = await derivedStore.ensure(req.params.id)
    if (!status) {
      res.status(404).json({ error: 'Video nicht gefunden.' })
      return
    }
    res.status(202).json(status)
  }),
)

mediaRouter.get(
  '/media/:id/derived',
  asyncHandler(async (req, res) => {
    const status = await derivedStore.status(req.params.id)
    if (!status) {
      res.status(404).json({ error: 'Video nicht gefunden.' })
      return
    }
    res.json(status)
  }),
)

/** Liefert eine fertige abgeleitete Datei aus (404, solange sie fehlt). */
function sendDerived(part: DerivedPart, type: string) {
  return asyncHandler(async (req, res) => {
    const id = req.params.id
    const file = await derivedStore.file(id, part)
    if (!file) {
      res.status(404).json({ error: 'Noch nicht vorhanden.' })
      return
    }
    // Zählt als Benutzung des Videos (Frist fürs Auto-Aufräumen).
    mediaStore.get(id)
    // Der Inhalt zu einer Video-ID ändert sich nie.
    res.set('Cache-Control', 'private, max-age=3600')
    res.type(type)
    res.sendFile(file, (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: 'Noch nicht vorhanden.' })
    })
  })
}

/** GET /api/media/:id/peaks -> Wellenform: ein Byte (0–255) je Abschnitt */
mediaRouter.get('/media/:id/peaks', sendDerived('peaks', 'application/octet-stream'))
/** GET /api/media/:id/strip -> Filmstreifen als Kachelbild (JPEG) */
mediaRouter.get('/media/:id/strip', sendDerived('strip', 'image/jpeg'))
/** GET /api/media/:id/proxy -> Vorschau-Kopie (MP4, unterstützt Bereichsanfragen) */
mediaRouter.get('/media/:id/proxy', sendDerived('proxy', 'video/mp4'))

/**
 * GET /api/media/:id/beats -> { bpm, beats: [s…], downbeat }
 * Takt der Tonspur (ohne KI). Wird beim ersten Abruf berechnet (bei langen
 * Stücken einige Sekunden) und danach gespeichert. Ohne Tonspur: leer.
 */
mediaRouter.get(
  '/media/:id/beats',
  asyncHandler(async (req, res) => {
    let result
    try {
      result = await beatStore.get(req.params.id)
    } catch (err) {
      console.error(`Takt für ${req.params.id} fehlgeschlagen:`, err)
      res.status(500).json({ error: 'Der Takt konnte nicht erkannt werden.' })
      return
    }
    if (!result) {
      res.status(404).json({ error: 'Video nicht gefunden.' })
      return
    }
    res.set('Cache-Control', 'private, max-age=3600')
    res.json(result)
  }),
)

/** DELETE /api/media/:id -> sofort vom Server löschen */
mediaRouter.delete(
  '/media/:id',
  asyncHandler(async (req, res) => {
    const ok = isMediaId(req.params.id) && (await mediaStore.remove(req.params.id))
    res.status(ok ? 200 : 404).json({ deleted: ok })
  }),
)
