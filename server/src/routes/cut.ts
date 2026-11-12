import { Router, type Request, type Response, type NextFunction } from 'express'
import multer from 'multer'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { rm } from 'node:fs/promises'
import { config } from '../config'
import {
  buildMergeArgs,
  buildServerArgs,
  computeKeepRanges,
  mergeTargetSize,
  outputDurationFor,
  outputTargetSize,
  type AppendClip,
} from '../lib/args'
import { probeMedia } from '../lib/probe'
import {
  parseAppendMeta,
  parseCutParams,
  parseNormalizeAudio,
  parseOutputFormat,
  resolveAppendRange,
  safeExt,
  safeBaseName,
  ValidationError,
} from '../lib/validate'
import { jobManager } from '../lib/jobs'

const upload = multer({
  storage: multer.diskStorage({
    destination: config.tmpDir,
    filename: (_req, file, cb) => cb(null, `${randomUUID()}-in.${safeExt(file.originalname)}`),
  }),
  limits: { fileSize: config.maxFileSizeBytes, files: 1 + config.maxAppendFiles },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('video/')) cb(null, true)
    else cb(new ValidationError('Nur Videodateien werden akzeptiert.'))
  },
})

/** Hauptvideo (`video`) + optional angehängte Videos (`append`, in Reihenfolge). */
const uploadFields = upload.fields([
  { name: 'video', maxCount: 1 },
  { name: 'append', maxCount: config.maxAppendFiles },
])

const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res, next).catch(next)

async function removeFiles(paths: string[]): Promise<void> {
  await Promise.all(paths.map((p) => rm(p, { force: true }).catch(() => {})))
}

export const cutRouter = Router()

/**
 * Features dieses Backends. Das Frontend prüft darüber (Health + Job-Antwort),
 * ob der laufende Server neue Felder wie `crop` überhaupt kennt – ein altes
 * Backend würde sie sonst stillschweigend ignorieren und ungeschnitten liefern.
 */
export const SERVER_FEATURES = [
  'crop',
  'append',
  'appendTrim',
  'appendSlots',
  'normalizeAudio',
  'outputFormat',
] as const

/**
 * POST /api/cut  (multipart: video, append[], appendMeta, segments|start+duration, mode,
 *                 operation, total, crop, transitionPreset, transitionDuration,
 *                 normalizeAudio, outputAspect, outputFill)
 * Legt einen Job an und startet die Verarbeitung.
 * Antwort: { jobId, crop, append, appendTrim, appendSlots, normalizeAudio } –
 * `crop` bestätigt den Bildausschnitt, `append` die Anzahl der angehängten
 * Videos, `appendTrim` die Übernahme von Kürzung/Position (`appendMeta`),
 * `appendSlots` freie Einfügestellen zwischen den Ausschnitten und
 * `normalizeAudio` die Lautstärke-Angleichung (nur beim Zusammenfügen),
 * `outputFormat` die Übernahme von Seitenverhältnis/Füllmodus.
 */
cutRouter.post(
  '/cut',
  uploadFields,
  asyncHandler(async (req, res) => {
    const files = (req.files ?? {}) as Record<string, Express.Multer.File[] | undefined>
    const main = files.video?.[0]
    const appendFiles = files.append ?? []
    const allPaths = [...(main ? [main.path] : []), ...appendFiles.map((f) => f.path)]

    if (!main) {
      await removeFiles(allPaths)
      throw new ValidationError('Keine Videodatei empfangen.')
    }

    // Ab hier existieren Dateien auf der Platte -> bei Fehlern löschen.
    try {
      const params = parseCutParams(req.body ?? {}, config.maxDurationSec)
      const appendMeta = parseAppendMeta(req.body ?? {}, appendFiles.length)
      // Lautstärke-Angleichung wirkt nur beim Zusammenfügen mit angehängten Videos.
      const normalizeAudio = appendFiles.length > 0 && parseNormalizeAudio(req.body ?? {})
      const output = parseOutputFormat(req.body ?? {})
      // Zusammenfügen ODER anderes Seitenverhältnis -> Normierungs-Pipeline.
      const useMerge = appendFiles.length > 0 || output.aspect !== 'auto'

      if (!jobManager.hasCapacity()) {
        await removeFiles(allPaths)
        res.setHeader('Retry-After', '30')
        res.status(429).json({ error: 'Server ausgelastet. Bitte gleich erneut versuchen.' })
        return
      }

      const id = randomUUID()
      const inExt = safeExt(main.originalname)
      const isWebm = inExt === 'webm'

      // Tatsächlich zu behaltende Bereiche (nach Zusammenführen/Komplement).
      const keepTotal =
        params.operation === 'keep'
          ? (params.total ?? Number.POSITIVE_INFINITY)
          : (params.total as number)
      const keep = computeKeepRanges(params.segments, params.operation, keepTotal)

      let args: string[]
      let outExt: string
      let outputPath: string
      let outputDuration: number

      if (useMerge) {
        // Zusammenfügen: Auflösung/Tonspur/Dauer aller Dateien ermitteln, damit
        // die Clips auf ein gemeinsames Format normiert werden können.
        const [mainInfo, ...appendInfos] = await Promise.all([
          probeMedia(main.path),
          ...appendFiles.map((f) => probeMedia(f.path)),
        ])
        const appends: AppendClip[] = appendInfos.map((info, i) => {
          if (!(info.duration > 0)) {
            throw new ValidationError(
              `Dauer des angehängten Videos „${safeBaseName(appendFiles[i].originalname)}" unbekannt.`,
            )
          }
          const range = resolveAppendRange(appendMeta[i], info.duration)
          if (range.duration > config.maxDurationSec) {
            throw new ValidationError(
              `Angehängtes Video überschreitet das Limit von ${config.maxDurationSec}s.`,
            )
          }
          return {
            path: appendFiles[i].path,
            start: range.start,
            duration: range.duration,
            hasAudio: info.hasAudio,
            position: appendMeta[i].position,
            slot: appendMeta[i].slot,
          }
        })
        const size = outputTargetSize(
          mergeTargetSize(mainInfo.width, mainInfo.height, params.crop),
          output.aspect,
        )
        outExt = isWebm ? 'webm' : 'mp4'
        outputPath = path.join(config.tmpDir, `${id}-out.${outExt}`)
        args = buildMergeArgs({
          inputPath: main.path,
          outputPath,
          keep,
          mainHasAudio: mainInfo.hasAudio,
          appends,
          width: size.width,
          height: size.height,
          transition: params.transition,
          crop: params.crop,
          normalizeAudio,
          fill: output.fill,
        })
        // Reihenfolge ist für die Gesamtdauer egal (Summe minus Überlappungen).
        outputDuration = outputDurationFor(
          [...keep, ...appends.map((a) => ({ start: 0, duration: a.duration }))],
          params.transition,
        )
      } else {
        // Verlustfreies Kopieren ist nur bei genau einem behaltenen Bereich +
        // 'keep' + copy + OHNE Zuschnitt möglich – dann bleibt der Original-
        // Container erhalten. Sonst (remove, mehrere Bereiche, reencode oder
        // Zuschnitt) wird neu kodiert: WebM-Input -> WebM (VP9/Opus), sonst
        // mp4 (H.264/AAC).
        const lossless =
          !params.crop && params.operation === 'keep' && params.mode === 'copy' && keep.length === 1
        outExt = lossless ? inExt : isWebm ? 'webm' : 'mp4'
        outputPath = path.join(config.tmpDir, `${id}-out.${outExt}`)
        args = buildServerArgs({
          inputPath: main.path,
          outputPath,
          mode: params.mode,
          operation: params.operation,
          total: params.total,
          segments: params.segments,
          transition: params.transition,
          crop: params.crop,
        })
        // Erwartete Ausgabedauer für die Fortschrittsanzeige = Summe der
        // behaltenen Bereiche (abzüglich Übergangs-Überlappungen).
        outputDuration = outputDurationFor(keep, params.transition)
      }

      const outputName = `${safeBaseName(main.originalname)}_cut.${outExt}`

      const job = jobManager.create({
        id,
        inputPath: main.path,
        extraInputPaths: appendFiles.map((f) => f.path),
        outputPath,
        outputName,
      })

      // Nicht awaiten: läuft im Hintergrund, Client verfolgt via SSE.
      void jobManager.run(job, args, outputDuration)

      res.status(202).json({
        jobId: id,
        crop: params.crop !== undefined,
        append: appendFiles.length,
        appendTrim: appendFiles.length > 0,
        appendSlots: appendFiles.length > 0,
        normalizeAudio,
        outputFormat: true,
      })
    } catch (err) {
      await removeFiles(allPaths)
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
