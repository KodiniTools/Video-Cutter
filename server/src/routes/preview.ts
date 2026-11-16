import express, { Router, type NextFunction, type Request, type Response } from 'express'
import { derivedStore } from '../lib/derived'
import { isMediaId, mediaStore } from '../lib/media'
import type { RenderSource } from '../lib/render/compile'
import { parseTimelineDoc, type RenderDoc } from '../lib/render/doc'
import { graphicStore, resolveDocGraphics } from '../lib/render/graphics'
import { isPreviewKey, previewStore } from '../lib/render/preview'
import { ValidationError } from '../lib/validate'

const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res, next).catch(next)

/** So lange hält der Server eine Abschnitts-Anfrage offen, bevor er „noch nicht fertig“ meldet. */
const WAIT_MS = 25_000

export interface SourceLookup {
  get: (id: string) => { path: string; info: { hasAudio: boolean; hasVideo?: boolean } } | undefined
  proxy: (id: string) => Promise<string | null>
}

/**
 * Dateien zu den im Dokument verwendeten Medien. Ist die kleine Vorschau-Kopie
 * eines Videos fertig, wird sie genommen (schneller zu dekodieren), sonst das
 * Original. Wirft, wenn ein verwendetes Medium nicht (mehr) auf dem Server liegt.
 */
export async function resolvePreviewSources(
  doc: RenderDoc,
  lookup: SourceLookup,
): Promise<Record<string, RenderSource>> {
  const used = new Set<string>()
  /** Medien, die als Bild gebraucht werden (Clips auf Video-Spuren). */
  const asPicture = new Set<string>()
  for (const track of doc.tracks)
    if (track.kind !== 'overlay')
      for (const clip of track.clips) {
        used.add(clip.asset)
        if (track.kind === 'video') asPicture.add(clip.asset)
      }
  const sources: Record<string, RenderSource> = {}
  for (const id of used) {
    const item = isMediaId(id) ? lookup.get(id) : undefined
    if (!item)
      throw new ValidationError(
        'Ein verwendetes Video liegt nicht mehr auf dem Server. Bitte erneut hochladen.',
        409,
      )
    if (asPicture.has(id) && item.info.hasVideo === false)
      throw new ValidationError('Eine Tondatei liegt auf einer Video-Spur.')
    sources[id] = { path: (await lookup.proxy(id)) ?? item.path, hasAudio: item.info.hasAudio }
  }
  return sources
}

export const previewRouter = Router()

/**
 * POST /api/preview/plan  { doc, at? }
 * Prüft das Timeline-Dokument, teilt es in Abschnitte und reiht fehlende ab
 * der Zeit `at` (µs) zum Rendern ein. Antwort: Größe, Länge und je Abschnitt
 * Schlüssel + Stand (ready | queued | rendering | error) sowie `missingGraphics`
 * (IDs von Grafiken, deren Bild der Server nicht mehr hat).
 */
previewRouter.post(
  '/preview/plan',
  express.json({ limit: '2mb' }),
  asyncHandler(async (req, res) => {
    const body = req.body as { doc?: unknown; at?: unknown } | undefined
    const parsed = parseTimelineDoc(body?.doc)
    if (!parsed.ok) {
      res.status(422).json({ error: 'Ungültiges Timeline-Dokument.', details: parsed.errors })
      return
    }
    const at =
      typeof body?.at === 'number' && Number.isSafeInteger(body.at) && body.at >= 0 ? body.at : 0
    const sources = await resolvePreviewSources(parsed.doc, {
      get: (id) => mediaStore.get(id),
      proxy: (id) => derivedStore.file(id, 'proxy'),
    })
    // Fehlende Grafiken werden ausgelassen und gemeldet: Der Editor lädt sie
    // erneut hoch und fragt dann noch einmal.
    const { graphics, missing } = resolveDocGraphics(parsed.doc, (id) => graphicStore.get(id))
    res.json({
      ...previewStore.plan(parsed.doc, sources, at, graphics),
      missingGraphics: missing,
    })
  }),
)

/**
 * GET /api/preview/segment/:key
 * Liefert einen Abschnitt (fragmentiertes MP4). Ist er noch nicht fertig, wird
 * er vorgezogen und die Anfrage bis zu 25 s offen gehalten.
 *  200 Datei · 202 noch in Arbeit · 404 gehört zu keinem aktuellen Plan · 500 Rendern fehlgeschlagen
 */
previewRouter.get(
  '/preview/segment/:key',
  asyncHandler(async (req, res) => {
    const key = req.params.key
    if (!isPreviewKey(key)) {
      res.status(404).json({ error: 'Unbekannter Abschnitt.' })
      return
    }
    const result = await previewStore.wait(key, WAIT_MS)
    if (result === 'timeout') {
      res.status(202).json({ state: previewStore.state(key) ?? 'queued' })
      return
    }
    if (result === 'error') {
      res.status(500).json({ error: 'Vorschau konnte nicht gerendert werden.' })
      return
    }
    const file = result === 'ready' ? previewStore.file(key) : null
    if (!file) {
      res.status(404).json({ error: 'Unbekannter Abschnitt.' })
      return
    }
    // Der Inhalt zu einem Schlüssel ändert sich nie.
    res.set('Cache-Control', 'private, max-age=3600, immutable')
    res.type('video/mp4')
    res.sendFile(file, (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: 'Unbekannter Abschnitt.' })
    })
  }),
)

/** GET /api/preview/stats -> Renderzeiten und Größe des Zwischenspeichers */
previewRouter.get('/preview/stats', (_req, res) => {
  res.json(previewStore.stats())
})
