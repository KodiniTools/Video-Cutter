import { Router, type Request, type Response, type NextFunction } from 'express'
import multer from 'multer'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { rm } from 'node:fs/promises'
import { config } from '../config'
import { buildServerArgs, computeKeepRanges } from '../lib/args'
import { parseCutParams, safeExt, safeBaseName, ValidationError } from '../lib/validate'
import { jobManager } from '../lib/jobs'

const upload = multer({
  storage: multer.diskStorage({
    destination: config.tmpDir,
    filename: (_req, file, cb) => cb(null, `${randomUUID()}-in.${safeExt(file.originalname)}`),
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

export const cutRouter = Router()

/**
 * POST /api/cut  (multipart: video, segments|start+duration, mode, operation, total)
 * Legt einen Job an und startet die Verarbeitung. Antwort: { jobId }.
 */
cutRouter.post(
  '/cut',
  upload.single('video'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw new ValidationError('Keine Videodatei empfangen.')

    // Ab hier existiert eine Datei auf der Platte -> bei Fehlern löschen.
    try {
      const params = parseCutParams(req.body ?? {}, config.maxDurationSec)

      if (!jobManager.hasCapacity()) {
        await rm(req.file.path, { force: true }).catch(() => {})
        res.setHeader('Retry-After', '30')
        res.status(429).json({ error: 'Server ausgelastet. Bitte gleich erneut versuchen.' })
        return
      }

      const id = randomUUID()
      const inExt = safeExt(req.file.originalname)

      // Tatsächlich zu behaltende Bereiche (nach Zusammenführen/Komplement).
      const keepTotal =
        params.operation === 'keep'
          ? (params.total ?? Number.POSITIVE_INFINITY)
          : (params.total as number)
      const keep = computeKeepRanges(params.segments, params.operation, keepTotal)

      // Verlustfreies Kopieren ist nur bei genau einem behaltenen Bereich +
      // 'keep' + copy möglich – dann bleibt der Original-Container erhalten.
      // Sonst (remove oder mehrere Bereiche oder reencode) wird neu kodiert:
      // WebM-Input -> WebM (VP9/Opus), sonst mp4 (H.264/AAC).
      const isWebm = inExt === 'webm'
      const lossless = params.operation === 'keep' && params.mode === 'copy' && keep.length === 1
      const outExt = lossless ? inExt : isWebm ? 'webm' : 'mp4'
      const outputPath = path.join(config.tmpDir, `${id}-out.${outExt}`)
      const outputName = `${safeBaseName(req.file.originalname)}_cut.${outExt}`

      const job = jobManager.create({
        id,
        inputPath: req.file.path,
        outputPath,
        outputName,
      })

      const args = buildServerArgs({
        inputPath: req.file.path,
        outputPath,
        mode: params.mode,
        operation: params.operation,
        total: params.total,
        segments: params.segments,
      })

      // Erwartete Ausgabedauer für die Fortschrittsanzeige = Summe der
      // behaltenen Bereiche.
      const outputDuration = keep.reduce((sum, r) => sum + r.duration, 0)

      // Nicht awaiten: läuft im Hintergrund, Client verfolgt via SSE.
      void jobManager.run(job, args, outputDuration)

      res.status(202).json({ jobId: id })
    } catch (err) {
      await rm(req.file.path, { force: true }).catch(() => {})
      throw err
    }
  }),
)

/**
 * GET /api/cut/:id/events  (Server-Sent Events)
 * Sendet Statusupdates bis der Job fertig oder fehlerhaft ist.
 */
cutRouter.get('/cut/:id/events', (req: Request, res: Response) => {
  const snap = jobManager.getSnapshot(req.params.id)
  if (!snap) {
    res.status(404).end()
    return
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // Nginx: nicht puffern
  })

  const send = (s: typeof snap) => {
    res.write(`data: ${JSON.stringify(s)}\n\n`)
  }

  send(snap)
  if (snap.state === 'done' || snap.state === 'error') {
    res.end()
    return
  }

  // Heartbeat gegen Idle-Timeouts.
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000)

  const unsub = jobManager.subscribe(req.params.id, (s) => {
    send(s)
    if (s.state === 'done' || s.state === 'error') {
      clearInterval(heartbeat)
      res.end()
    }
  })

  req.on('close', () => {
    clearInterval(heartbeat)
    unsub()
  })
})

/**
 * GET /api/cut/:id/download
 * Liefert die geschnittene Datei und räumt den Job danach auf.
 */
cutRouter.get('/cut/:id/download', (req: Request, res: Response) => {
  const out = jobManager.getOutput(req.params.id)
  if (!out) {
    res.status(404).json({ error: 'Ergebnis nicht verfügbar.' })
    return
  }
  res.download(out.path, out.name, (err) => {
    // Nach dem Senden (oder Abbruch) Job + Dateien entfernen.
    void jobManager.remove(req.params.id)
    if (err && !res.headersSent) {
      res.status(500).end()
    }
  })
})

/**
 * DELETE /api/cut/:id  -> laufenden Job abbrechen.
 */
cutRouter.delete(
  '/cut/:id',
  asyncHandler(async (req, res) => {
    const ok = await jobManager.cancel(req.params.id)
    res.status(ok ? 200 : 404).json({ cancelled: ok })
  }),
)
