import express, { type NextFunction, type Request, type Response } from 'express'
import cors from 'cors'
import helmet from 'helmet'
import { mkdir } from 'node:fs/promises'
import { MulterError } from 'multer'
import { config } from './config'
import { cutRouter, SERVER_FEATURES } from './routes/cut'
import { mediaRouter } from './routes/media'
import { textRouter } from './routes/text'
import { projectsRouter } from './routes/projects'
import { previewRouter } from './routes/preview'
import { graphicsRouter } from './routes/graphics'
import { renderRouter } from './routes/render'
import { qualityRouter } from './routes/quality'
import { previewStore } from './lib/render/preview'
import { graphicStore } from './lib/render/graphics'
import { mediaStore } from './lib/media'
import { derivedStore } from './lib/derived'
import { ValidationError } from './lib/validate'
import { jobManager } from './lib/jobs'
import { initCustomFonts } from './lib/customFonts'
import { aiRouter, aiStatus } from './routes/ai'
import { aiJobs } from './lib/aiJobs'
import { gallery } from './lib/gallery'
import { createApiRateLimit } from './lib/rateLimits'

async function bootstrap(): Promise<void> {
  await mkdir(config.tmpDir, { recursive: true })
  const restored = await mediaStore.init()
  console.log(
    config.mediaIndexFile
      ? `Videos: ${restored} wiederhergestellt (${config.mediaIndexFile})`
      : 'Videos: nur im Arbeitsspeicher (MEDIA_INDEX_FILE leer)',
  )
  await derivedStore.init()
  await previewStore.init()
  await graphicStore.init()
  await mkdir(config.projectsDir, { recursive: true })
  console.log(`Projekte: ${config.projectsDir}`)
  await gallery.init()
  console.log(`Galerie (KI-Bilder): ${gallery.list().length} Bilder in ${config.galleryDir}`)
  const fonts = await initCustomFonts(config.customFontsDir, config.tmpDir)
  console.log(`Eigene Schriften: ${fonts.length} aus ${config.customFontsDir}`)
  const ai = aiStatus()
  console.log(
    `KI: Transkription ${ai.transcribe ? 'bereit' : 'aus'}, Claude ${ai.claude ? 'bereit' : 'aus'}`,
  )

  const app = express()
  app.disable('x-powered-by')
  app.set('trust proxy', 1) // hinter Nginx

  app.use(helmet())
  app.use(
    cors({
      origin: (origin, cb) => {
        // Requests ohne Origin (curl, gleiche Herkunft) erlauben.
        if (!origin || config.allowedOrigins.includes(origin)) cb(null, true)
        else cb(new Error('Origin nicht erlaubt.'))
      },
      methods: ['GET', 'POST', 'DELETE'],
    }),
  )

  if (process.env.RATE_LIMIT_MAX !== undefined) {
    console.warn(
      'RATE_LIMIT_MAX wird nicht mehr verwendet – stattdessen RATE_LIMIT_WRITE_MAX/RATE_LIMIT_READ_MAX.',
    )
  }
  app.use(
    '/api',
    createApiRateLimit({
      windowMs: 15 * 60 * 1000,
      writeMax: config.rateLimitWriteMax,
      readMax: config.rateLimitReadMax,
    }),
  )

  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      active: jobManager.activeCount,
      maxConcurrent: config.maxConcurrent,
      features: SERVER_FEATURES,
      ai: aiStatus(),
    })
  })

  app.use('/api', cutRouter)
  app.use('/api', mediaRouter)
  app.use('/api', textRouter)
  app.use('/api', aiRouter)
  app.use('/api', projectsRouter)
  app.use('/api', previewRouter)
  app.use('/api', graphicsRouter)
  app.use('/api', renderRouter)
  app.use('/api', qualityRouter)

  // 404
  app.use((_req, res) => res.status(404).json({ error: 'Nicht gefunden.' }))

  // zentrale Fehlerbehandlung
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ValidationError) {
      res.status(err.statusCode).json({ error: err.message })
      return
    }
    // express.json(): kaputtes oder zu großes JSON (POST /api/text).
    const bodyErr = (err as { type?: unknown } | null)?.type
    if (bodyErr === 'entity.parse.failed' || bodyErr === 'entity.too.large') {
      const tooLarge = bodyErr === 'entity.too.large'
      res
        .status(tooLarge ? 413 : 400)
        .json({ error: tooLarge ? 'Anfrage zu groß.' : 'Ungültige Anfrage (JSON).' })
      return
    }
    if (err instanceof MulterError) {
      const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400
      res.status(status).json({ error: `Upload-Fehler: ${err.message}` })
      return
    }
    if (err instanceof Error && err.message === 'Origin nicht erlaubt.') {
      res.status(403).json({ error: err.message })
      return
    }

    console.error('Unerwarteter Fehler:', err)
    res.status(500).json({ error: 'Interner Serverfehler.' })
  })

  const server = app.listen(config.port, config.host, () => {
    console.log(`video-cutter-api läuft auf http://${config.host}:${config.port}`)
  })

  // Große/langsame Uploads dürfen lange dauern. Node bricht sonst jede Anfrage
  // nach dem Standard-requestTimeout (5 min) ab -> Verbindung reset (langsamer
  // Upload). Deshalb: kein Gesamt-Limit auf die Anfrage, aber Header-Timeout als
  // Slowloris-Schutz, und keepAlive > Nginx, um Reuse-Races zu vermeiden.
  server.requestTimeout = 0
  server.headersTimeout = 120_000
  server.keepAliveTimeout = 75_000

  const shutdown = (signal: string) => {
    console.log(`${signal} empfangen – fahre herunter …`)
    aiJobs.shutdown()
    derivedStore.shutdown()
    void previewStore.shutdown()
    void graphicStore.shutdown()
    server.close(() => {
      void jobManager
        .shutdown()
        .then(() => mediaStore.shutdown())
        .finally(() => process.exit(0))
    })
    // Notausstieg, falls Verbindungen hängen.
    setTimeout(() => process.exit(0), 10_000).unref()
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

bootstrap().catch((err) => {
  console.error('Start fehlgeschlagen:', err)
  process.exit(1)
})
