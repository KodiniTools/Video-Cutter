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
  mergeOutputDuration,
  mergeSequence,
  mergeTargetSize,
  outputDurationFor,
  previewTargetSize,
  outputTargetSize,
  audioFadeForcesReencode,
  type AppendClip,
  type MusicTrack,
} from '../lib/args'
import { probeMedia, type MediaInfo } from '../lib/probe'
import { isMediaId, mediaStore } from '../lib/media'
import {
  parseAppendMeta,
  parseAudioFade,
  parseCutParams,
  parseNormalizeAudio,
  parseOutputFormat,
  parseMusicParams,
  parseSeamTransitions,
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
  limits: { fileSize: config.maxFileSizeBytes, files: 2 + config.maxAppendFiles },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('video/')) cb(null, true)
    // Hintergrundmusik darf auch eine reine Audiodatei sein.
    else if (file.fieldname === 'music' && file.mimetype.startsWith('audio/')) cb(null, true)
    else cb(new ValidationError('Nur Video- (bzw. für Musik Audio-)Dateien werden akzeptiert.'))
  },
})

/** Hauptvideo (`video`) + optional angehängte Videos (`append`) + Hintergrundmusik (`music`). */
const uploadFields = upload.fields([
  { name: 'video', maxCount: 1 },
  { name: 'append', maxCount: config.maxAppendFiles },
  { name: 'music', maxCount: 1 },
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
  'music',
  'seamTransitions',
  'media',
  'text',
  'customFonts',
  'ai',
  'graphics',
  'aiTranslate',
  'audioFade',
  'projects',
  'stillClip',
  'mergePreview',
] as const

/** Eine Eingabedatei: frisch hochgeladen (gehört dem Job) oder aus der Bibliothek. */
interface Source {
  path: string
  originalname: string
  owned: boolean
  info?: MediaInfo
  mediaId?: string
}

/** Liest `appendMediaIds` (JSON-Array von Bibliotheks-IDs). */
function parseMediaIdList(raw: unknown, max: number): string[] {
  if (raw === undefined || raw === null || raw === '') return []
  let v: unknown = raw
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v)
    } catch {
      throw new ValidationError('Ungültige Liste gespeicherter Videos.')
    }
  }
  if (!Array.isArray(v) || !v.every(isMediaId)) {
    throw new ValidationError('Ungültige Liste gespeicherter Videos.')
  }
  if (v.length > max) throw new ValidationError(`Maximal ${max} angehängte Videos.`)
  return v
}

/**
 * POST /api/cut  (multipart: video, append[], appendMeta, segments|start+duration, mode,
 *                 operation, total, crop, transitionPreset, transitionDuration,
 *                 normalizeAudio, outputAspect, outputFill,
 *                 music, musicVolume, musicOriginalVolume, musicFade, musicLoop,
 *                 seamTransitions, audioFadeIn, audioFadeInCurve, audioFadeOut,
 *                 audioFadeOutCurve)
 * Legt einen Job an und startet die Verarbeitung.
 * Antwort: { jobId, crop, append, appendTrim, appendSlots, normalizeAudio } –
 * `crop` bestätigt den Bildausschnitt, `append` die Anzahl der angehängten
 * Videos, `appendTrim` die Übernahme von Kürzung/Position (`appendMeta`),
 * `appendSlots` freie Einfügestellen zwischen den Ausschnitten und
 * `normalizeAudio` die Lautstärke-Angleichung (nur beim Zusammenfügen),
 * `outputFormat` die Übernahme von Seitenverhältnis/Füllmodus, `music` die
 * Hintergrundmusik, `seamTransitions` die Übergänge je Nahtstelle,
 * `audioFade` das Ein-/Ausblenden des Tons (bei Videos ohne Ton wirkungslos),
 * `preview` eine kleine, schnell kodierte Vorschau (nur beim Zusammenfügen,
 * Ergebnis per /download abholen, nie in der Bibliothek).
 */
cutRouter.post(
  '/cut',
  uploadFields,
  asyncHandler(async (req, res) => {
    const files = (req.files ?? {}) as Record<string, Express.Multer.File[] | undefined>
    const main = files.video?.[0]
    const appendFiles = files.append ?? []
    const musicFile = files.music?.[0]
    const allPaths = [
      ...(main ? [main.path] : []),
      ...appendFiles.map((f) => f.path),
      ...(musicFile ? [musicFile.path] : []),
    ]

    // Bibliotheks-Videos sofort sperren, damit sie während des Jobs nicht
    // gelöscht werden; bei Fehlern wieder freigeben.
    const acquired: string[] = []
    const fromLibrary = (id: string): Source => {
      const item = mediaStore.get(id)
      if (!item) throw new ValidationError('Video nicht (mehr) auf dem Server vorhanden.')
      mediaStore.acquire([id])
      acquired.push(id)
      return {
        path: item.path,
        originalname: item.name,
        owned: false,
        info: item.info,
        mediaId: id,
      }
    }

    // Ab hier existieren Dateien auf der Platte -> bei Fehlern löschen.
    try {
      const body = (req.body ?? {}) as Record<string, unknown>
      let mainSrc: Source
      if (main) {
        mainSrc = { path: main.path, originalname: main.originalname, owned: true }
      } else if (isMediaId(body.mediaId)) {
        mainSrc = fromLibrary(body.mediaId)
      } else {
        throw new ValidationError('Keine Videodatei empfangen.')
      }
      const appendIds = parseMediaIdList(body.appendMediaIds, config.maxAppendFiles)
      if (appendIds.length && appendFiles.length) {
        throw new ValidationError('Angehängte Videos entweder hochladen oder per ID angeben.')
      }
      const appendSrcs: Source[] = appendFiles.length
        ? appendFiles.map((f) => ({ path: f.path, originalname: f.originalname, owned: true }))
        : appendIds.map(fromLibrary)
      // Vorschau: klein + schnell kodiert, nur zum Ansehen (nie in der Bibliothek).
      const preview = body.preview === '1' || body.preview === 'true'
      const storeResult = !preview && (body.storeResult === '1' || body.storeResult === 'true')

      const params = parseCutParams(req.body ?? {}, config.maxDurationSec)
      const appendMeta = parseAppendMeta(req.body ?? {}, appendSrcs.length)
      // Lautstärke-Angleichung wirkt nur beim Zusammenfügen mit angehängten Videos.
      const normalizeAudio = appendSrcs.length > 0 && parseNormalizeAudio(req.body ?? {})
      const output = parseOutputFormat(req.body ?? {})
      // Zusammenfügen ODER anderes Seitenverhältnis -> Normierungs-Pipeline.
      const musicParams = musicFile ? parseMusicParams(req.body ?? {}) : null
      // Übergänge je Nahtstelle gelten nur beim Zusammenfügen mit angehängten Videos.
      const seamInput = appendSrcs.length > 0 ? parseSeamTransitions(req.body ?? {}) : undefined
      const useMerge = appendSrcs.length > 0 || output.aspect !== 'auto' || musicFile !== undefined
      const audioFade = parseAudioFade(req.body ?? {})
      if (preview && !useMerge) {
        throw new ValidationError('Die Vorschau gibt es nur beim Zusammenfügen.')
      }

      if (!jobManager.hasCapacity()) {
        await removeFiles(allPaths)
        if (acquired.length) await mediaStore.release(acquired.splice(0))
        res.setHeader('Retry-After', '30')
        res.status(429).json({ error: 'Server ausgelastet. Bitte gleich erneut versuchen.' })
        return
      }

      const id = randomUUID()
      const inExt = safeExt(mainSrc.originalname)
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
        const [mainInfo, musicInfo, ...appendInfos] = await Promise.all([
          mainSrc.info ? Promise.resolve(mainSrc.info) : probeMedia(mainSrc.path),
          musicFile ? probeMedia(musicFile.path) : Promise.resolve(null),
          ...appendSrcs.map((s) => (s.info ? Promise.resolve(s.info) : probeMedia(s.path))),
        ])
        let music: MusicTrack | undefined
        if (musicFile && musicParams) {
          if (!musicInfo?.hasAudio) {
            throw new ValidationError('Die Musikdatei enthält keine Tonspur.')
          }
          music = { path: musicFile.path, ...musicParams }
        }
        const appends: AppendClip[] = appendInfos.map((info, i) => {
          if (!(info.duration > 0)) {
            throw new ValidationError(
              `Dauer des angehängten Videos „${safeBaseName(appendSrcs[i].originalname)}" unbekannt.`,
            )
          }
          const range = resolveAppendRange(appendMeta[i], info.duration)
          if (range.duration > config.maxDurationSec) {
            throw new ValidationError(
              `Angehängtes Video überschreitet das Limit von ${config.maxDurationSec}s.`,
            )
          }
          return {
            path: appendSrcs[i].path,
            start: range.start,
            duration: range.duration,
            hasAudio: info.hasAudio,
            position: appendMeta[i].position,
            slot: appendMeta[i].slot,
          }
        })
        // Übergänge je Nahtstelle: Anzahl muss zur Gesamtreihenfolge passen.
        const seqLen = mergeSequence(keep.length, appends).length
        if (seamInput && seamInput.seams.length !== Math.max(0, seqLen - 1)) {
          throw new ValidationError('Die Übergänge passen nicht zur Anzahl der Clips.')
        }
        // Dauer für animierte Nahtstellen auch dann, wenn global „keiner" gewählt ist.
        const transition = seamInput
          ? (params.transition ?? { preset: 'none' as const, duration: seamInput.duration })
          : params.transition
        const seams = seamInput?.seams
        const fullSize = outputTargetSize(
          mergeTargetSize(mainInfo.width, mainInfo.height, params.crop),
          output.aspect,
        )
        const size = preview ? previewTargetSize(fullSize) : fullSize
        // Vorschau immer als mp4 (H.264 ultrafast) – VP9 wäre viel langsamer.
        outExt = isWebm && !preview ? 'webm' : 'mp4'
        outputPath = path.join(config.tmpDir, `${id}-out.${outExt}`)
        args = buildMergeArgs({
          inputPath: mainSrc.path,
          outputPath,
          keep,
          mainHasAudio: mainInfo.hasAudio,
          appends,
          width: size.width,
          height: size.height,
          transition,
          crop: params.crop,
          normalizeAudio,
          fill: output.fill,
          music,
          seams,
          audioFade,
          preview,
        })
        // Reihenfolge ist für die Gesamtdauer egal (Summe minus Überlappungen).
        outputDuration = mergeOutputDuration(
          [...keep, ...appends.map((a) => ({ start: 0, duration: a.duration }))],
          transition,
          seams,
        )
      } else {
        // Ton-Blende nur mit Tonspur (ein -af ohne Tonspur bricht FFmpeg ab).
        const mainHasAudio = audioFade
          ? (mainSrc.info ?? (await probeMedia(mainSrc.path))).hasAudio
          : false
        const fade = mainHasAudio ? audioFade : undefined
        // Verlustfreies Kopieren ist nur bei genau einem behaltenen Bereich +
        // 'keep' + copy + OHNE Zuschnitt möglich – dann bleibt der Original-
        // Container erhalten. Sonst (remove, mehrere Bereiche, reencode oder
        // Zuschnitt) wird neu kodiert: WebM-Input -> WebM (VP9/Opus), sonst
        // mp4 (H.264/AAC).
        const lossless =
          !params.crop &&
          params.operation === 'keep' &&
          params.mode === 'copy' &&
          keep.length === 1 &&
          !audioFadeForcesReencode(fade, keep, params.transition)
        outExt = lossless ? inExt : isWebm ? 'webm' : 'mp4'
        outputPath = path.join(config.tmpDir, `${id}-out.${outExt}`)
        args = buildServerArgs({
          inputPath: mainSrc.path,
          outputPath,
          mode: params.mode,
          operation: params.operation,
          total: params.total,
          segments: params.segments,
          transition: params.transition,
          crop: params.crop,
          audioFade: fade,
        })
        // Erwartete Ausgabedauer für die Fortschrittsanzeige = Summe der
        // behaltenen Bereiche (abzüglich Übergangs-Überlappungen).
        outputDuration = outputDurationFor(keep, params.transition)
      }

      // Wiederholtes Schneiden stapelt kein „_cut_cut".
      const baseName = safeBaseName(mainSrc.originalname).replace(/_cut$/, '')
      const outputName = `${baseName}_${preview ? 'preview' : 'cut'}.${outExt}`

      const job = jobManager.create({
        id,
        inputPath: mainSrc.path,
        ownsInput: mainSrc.owned,
        extraInputPaths: [
          ...appendSrcs.filter((s) => s.owned).map((s) => s.path),
          ...(musicFile ? [musicFile.path] : []),
        ],
        // Sperren gehen an den Job über und werden nach dem Lauf freigegeben.
        mediaRefs: acquired.splice(0),
        storeResult,
        outputPath,
        outputName,
      })

      // Nicht awaiten: läuft im Hintergrund, Client verfolgt via SSE.
      void jobManager.run(job, args, outputDuration)

      res.status(202).json({
        jobId: id,
        crop: params.crop !== undefined,
        append: appendSrcs.length,
        appendTrim: appendSrcs.length > 0,
        appendSlots: appendSrcs.length > 0,
        normalizeAudio,
        outputFormat: true,
        music: musicFile !== undefined,
        seamTransitions: seamInput !== undefined,
        audioFade: audioFade !== undefined,
        storeResult,
        preview,
      })
    } catch (err) {
      await removeFiles(allPaths)
      if (acquired.length) await mediaStore.release(acquired.splice(0))
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
