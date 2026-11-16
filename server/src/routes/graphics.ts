import express, { Router, type NextFunction, type Request, type Response } from 'express'
import { MAX_GRAPHIC_BYTES } from '../lib/graphicOverlay'
import { graphicStore } from '../lib/render/graphics'
import { ValidationError } from '../lib/validate'

const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res, next).catch(next)

export const graphicsRouter = Router()

/**
 * POST /api/graphics  (Body: PNG, `Content-Type: image/png`)
 * Legt eine vom Browser gezeichnete Grafik (Form, Symbol, Emoji) ab. Antwort:
 * `{ id, width, height }`; die ID steht danach im Timeline-Dokument. Dasselbe
 * Bild ergibt immer dieselbe ID.
 */
graphicsRouter.post(
  '/graphics',
  express.raw({ type: 'image/png', limit: MAX_GRAPHIC_BYTES }),
  asyncHandler(async (req, res) => {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0)
      throw new ValidationError('Die Grafik ist kein PNG-Bild.')
    const { id, width, height } = await graphicStore.put(req.body)
    res.json({ id, width, height })
  }),
)
