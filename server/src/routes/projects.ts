import express, { Router, type Request, type Response, type NextFunction } from 'express'
import { StorageFullError } from '../lib/media'
import {
  isAssetHash,
  MissingMediaError,
  parseSaveInput,
  ProjectNotFoundError,
  projectStore,
  ProjectStorageFullError,
} from '../lib/projects'

/**
 * Projekte: Bearbeitungsstand auf dem Server speichern und später fortsetzen.
 *
 *   GET    /api/projects                     -> { projects: ProjectSummary[] }
 *   POST   /api/projects                     -> { project, missingAssets } (neu oder überschreiben)
 *   GET    /api/projects/:id                 -> { project, state }
 *   POST   /api/projects/:id/open            -> { media: { token: MediaView } }
 *   POST   /api/projects/:id/assets/:hash    (Rohdaten) -> 204
 *   GET    /api/projects/:id/assets/:hash    -> Datei
 *   DELETE /api/projects/:id                 -> { deleted }
 *
 * Nur POST/GET/DELETE (CORS erlaubt kein PUT).
 */
const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res, next).catch(next)

/** Projekt-Fehler mit eigenem Status direkt beantworten, sonst weiterreichen. */
function sendKnown(err: unknown, res: Response): boolean {
  if (err instanceof MissingMediaError) {
    res.status(err.statusCode).json({ error: err.message, missingMedia: err.missing })
    return true
  }
  if (
    err instanceof ProjectNotFoundError ||
    err instanceof ProjectStorageFullError ||
    err instanceof StorageFullError
  ) {
    res.status(err.statusCode).json({ error: err.message })
    return true
  }
  return false
}

const handle = (fn: (req: Request, res: Response) => Promise<void>) =>
  asyncHandler(async (req, res, next) => {
    try {
      await fn(req, res)
    } catch (err) {
      if (!sendKnown(err, res)) next(err)
    }
  })

export const projectsRouter = Router()

projectsRouter.get(
  '/projects',
  handle(async (_req, res) => {
    res.json({ projects: await projectStore.list() })
  }),
)

projectsRouter.post(
  '/projects',
  express.json({ limit: '20mb' }),
  handle(async (req, res) => {
    const result = await projectStore.save(parseSaveInput(req.body))
    res.status(200).json(result)
  }),
)

projectsRouter.get(
  '/projects/:id',
  handle(async (req, res) => {
    res.json(await projectStore.get(String(req.params.id)))
  }),
)

projectsRouter.post(
  '/projects/:id/open',
  handle(async (req, res) => {
    res.json({ media: await projectStore.open(String(req.params.id)) })
  }),
)

projectsRouter.post(
  '/projects/:id/assets/:hash',
  handle(async (req, res) => {
    const hash = String(req.params.hash)
    if (!isAssetHash(hash)) throw new ProjectNotFoundError()
    await projectStore.putAsset(String(req.params.id), hash, req)
    res.status(204).end()
  }),
)

projectsRouter.get(
  '/projects/:id/assets/:hash',
  handle(async (req, res) => {
    const hash = String(req.params.hash)
    if (!isAssetHash(hash)) throw new ProjectNotFoundError()
    const a = await projectStore.asset(String(req.params.id), hash)
    res.type(a.type)
    res.sendFile(a.path, { dotfiles: 'allow' })
  }),
)

projectsRouter.delete(
  '/projects/:id',
  handle(async (req, res) => {
    const ok = await projectStore.remove(String(req.params.id))
    res.status(ok ? 200 : 404).json({ deleted: ok })
  }),
)
