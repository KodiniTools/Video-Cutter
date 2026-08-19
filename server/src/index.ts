import express, { type NextFunction, type Request, type Response } from 'express'
import cors from 'cors'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import { mkdir } from 'node:fs/promises'
import { MulterError } from 'multer'
import { config } from './config'
import { cutRouter } from './routes/cut'
import { ValidationError } from './lib/validate'
import { jobManager } from './lib/jobs'

async function bootstrap(): Promise<void> {
  await mkdir(config.tmpDir, { recursive: true })

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

  app.use(
    '/api',
    rateLimit({
      windowMs: 15 * 60 * 1000,
      max: config.rateLimitMax,
      standardHeaders: true,
      legacyHeaders: false,
    }),
  )

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', active: jobManager.activeCount, maxConcurrent: config.maxConcurrent })
  })

  app.use('/api', cutRouter)

  // 404
  app.use((_req, res) => res.status(404).json({ error: 'Nicht gefunden.' }))

  // zentrale Fehlerbehandlung
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ValidationError) {
      res.status(err.statusCode).json({ error: err.message })
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
    server.close(() => {
      void jobManager.shutdown().finally(() => process.exit(0))
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
