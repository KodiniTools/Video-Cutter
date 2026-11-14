import { randomUUID } from 'node:crypto'
import { config } from '../config'

/**
 * Bilderzeugung mit Google Gemini („Nano Banana“, generateContent mit
 * Bildausgabe) für Bild-Clips. Der Schlüssel kommt ausschließlich aus
 * GEMINI_API_KEY (Server-.env) und verlässt den Server nie.
 *
 * Gemini liefert pro Aufruf genau ein Bild; mehrere Varianten = mehrere
 * parallele Aufrufe. Die Bilder bleiben eine Weile im Speicher und werden
 * vom Browser per GET /api/ai/images/:id abgeholt.
 */

export function geminiReady(): boolean {
  return Boolean(process.env.GEMINI_API_KEY)
}

/** Seitenverhältnisse, die alle aktuellen Gemini-Bildmodelle kennen. */
export const IMAGE_ASPECTS = [
  '1:1',
  '2:3',
  '3:2',
  '3:4',
  '4:3',
  '4:5',
  '5:4',
  '9:16',
  '16:9',
  '21:9',
] as const
export type ImageAspect = (typeof IMAGE_ASPECTS)[number]

/** Nächstliegendes unterstütztes Seitenverhältnis zu Breite × Höhe. */
export function nearestAspect(width: number, height: number): ImageAspect {
  if (!(width > 0 && height > 0)) return '16:9'
  const target = Math.log(width / height)
  let best: ImageAspect = '16:9'
  let bestDiff = Infinity
  for (const a of IMAGE_ASPECTS) {
    const [w, h] = a.split(':').map(Number)
    const diff = Math.abs(Math.log(w / h) - target)
    if (diff < bestDiff) {
      bestDiff = diff
      best = a
    }
  }
  return best
}

/** Auflösungsstufe passend zur längsten Seite des Clips (1K/2K/4K). */
export function imageSizeFor(width: number, height: number): '1K' | '2K' | '4K' {
  const m = Math.max(width, height)
  if (m > 2048) return '4K'
  if (m > 1024) return '2K'
  return '1K'
}

export const MIN_IMAGE_COUNT = 1
export const MAX_IMAGE_COUNT = 4
export const MAX_PROMPT_LENGTH = 2000

// --- Zwischenspeicher der erzeugten Bilder -------------------------------------

interface StoredImage {
  data: Buffer
  mime: string
  createdAt: number
}

const IMAGE_TTL_MS = 30 * 60 * 1000
/** Obergrenze, damit der Speicher nicht vollläuft (ältere fliegen zuerst). */
const MAX_STORED_IMAGES = 40

const images = new Map<string, StoredImage>()

const sweeper = setInterval(() => sweepImages(), 60_000)
sweeper.unref?.()

export function sweepImages(now = Date.now()): void {
  for (const [id, img] of images) if (now - img.createdAt > IMAGE_TTL_MS) images.delete(id)
}

export function storeImage(data: Buffer, mime: string): string {
  const id = randomUUID()
  images.set(id, { data, mime, createdAt: Date.now() })
  while (images.size > MAX_STORED_IMAGES) {
    const oldest = images.keys().next().value
    if (oldest === undefined) break
    images.delete(oldest)
  }
  return id
}

export function getImage(id: string): StoredImage | undefined {
  return images.get(id)
}

// --- Aufruf --------------------------------------------------------------------

const ALLOWED_MIME = ['image/png', 'image/jpeg', 'image/webp']

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Holt das Bild aus einer generateContent-Antwort. Wirft mit verständlicher
 * Meldung, wenn Gemini kein Bild liefert (z. B. Sicherheitsfilter).
 */
export function extractImage(raw: unknown): { data: Buffer; mime: string } {
  const d = isRecord(raw) ? raw : {}
  const feedback = isRecord(d.promptFeedback) ? d.promptFeedback : {}
  if (typeof feedback.blockReason === 'string') {
    throw new Error('Gemini hat den Prompt abgelehnt (Sicherheitsfilter). Bitte umformulieren.')
  }
  const candidates = Array.isArray(d.candidates) ? d.candidates.filter(isRecord) : []
  for (const c of candidates) {
    const content = isRecord(c.content) ? c.content : {}
    const parts = Array.isArray(content.parts) ? content.parts.filter(isRecord) : []
    for (const p of parts) {
      const inline = isRecord(p.inlineData)
        ? p.inlineData
        : isRecord(p.inline_data)
          ? p.inline_data
          : null
      if (!inline) continue
      const mime = String(inline.mimeType ?? inline.mime_type ?? '')
      const data = typeof inline.data === 'string' ? inline.data : ''
      if (!data || !ALLOWED_MIME.includes(mime)) continue
      const buf = Buffer.from(data, 'base64')
      if (buf.length > 0) return { data: buf, mime }
    }
  }
  const reason = candidates.map((c) => String(c.finishReason ?? '')).find(Boolean) ?? ''
  if (/SAFETY|PROHIBITED|BLOCK/i.test(reason)) {
    throw new Error('Gemini hat das Bild abgelehnt (Sicherheitsfilter). Bitte umformulieren.')
  }
  throw new Error('Gemini hat kein Bild geliefert.')
}

/** Übersetzt HTTP-Fehler von Gemini in verständliche Meldungen. */
export function geminiHttpError(
  status: number,
  body: unknown,
  model: string = config.geminiImageModel,
): Error {
  const err = isRecord(body) && isRecord(body.error) ? body.error : {}
  const msg = typeof err.message === 'string' ? err.message : ''
  if (status === 400 && /api key/i.test(msg)) {
    return new Error('Gemini-API-Key ungültig (GEMINI_API_KEY in der Server-.env prüfen).')
  }
  if (status === 401 || status === 403) {
    return new Error('Der Gemini-API-Key hat keinen Zugriff auf das Bildmodell.')
  }
  if (status === 404) {
    return new Error(
      `Gemini-Bildmodell „${model}“ nicht gefunden (anderes Modell wählen bzw. GEMINI_IMAGE_MODEL prüfen).`,
    )
  }
  if (status === 429) {
    return new Error('Gemini ist ausgelastet oder das Kontingent ist aufgebraucht (429).')
  }
  return new Error(`Gemini-Fehler (${status})${msg ? `: ${msg.slice(0, 300)}` : ''}`)
}

/** Request-Body für ein Bild. */
export function buildImageRequest(
  prompt: string,
  aspect: ImageAspect,
  size: '1K' | '2K' | '4K',
  model: string = config.geminiImageModel,
): Record<string, unknown> {
  const imageConfig: Record<string, unknown> = { aspectRatio: aspect }
  // Ältere Modelle (2.5) kennen imageSize nicht; GEMINI_IMAGE_SIZE=off lässt es immer weg.
  if (config.geminiImageSize !== 'off' && !model.startsWith('gemini-2.')) {
    imageConfig.imageSize = config.geminiImageSize || size
  }
  return {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { responseModalities: ['IMAGE'], imageConfig },
  }
}

async function generateOne(
  prompt: string,
  aspect: ImageAspect,
  size: '1K' | '2K' | '4K',
  signal: AbortSignal,
  model: string,
): Promise<{ data: Buffer; mime: string }> {
  const url = `${config.geminiBaseUrl.replace(/\/+$/, '')}/models/${encodeURIComponent(
    model,
  )}:generateContent`
  let res: globalThis.Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': process.env.GEMINI_API_KEY ?? '',
      },
      body: JSON.stringify(buildImageRequest(prompt, aspect, size, model)),
      signal: AbortSignal.any([signal, AbortSignal.timeout(config.geminiTimeoutMs)]),
    })
  } catch (err) {
    if (signal.aborted) throw new Error('Abgebrochen.')
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new Error('Gemini hat zu lange nicht geantwortet.')
    }
    throw new Error('Gemini ist nicht erreichbar (Netzwerk).')
  }
  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    /* keine JSON-Antwort */
  }
  if (!res.ok) throw geminiHttpError(res.status, body, model)
  return extractImage(body)
}

export interface GeneratedImage {
  id: string
  mime: string
}

/**
 * Erzeugt `count` Varianten parallel. Klappt mindestens eine, kommen die
 * fertigen zurück (`failed` zählt die übrigen); sonst der erste Fehler.
 */
export async function generateImages(
  prompt: string,
  aspect: ImageAspect,
  size: '1K' | '2K' | '4K',
  count: number,
  signal: AbortSignal,
  progress: (p: number) => void,
  model: string = config.geminiImageModel,
): Promise<{ images: GeneratedImage[]; failed: number; error: string }> {
  let done = 0
  const results = await Promise.allSettled(
    Array.from({ length: count }, async () => {
      const img = await generateOne(prompt, aspect, size, signal, model)
      done++
      progress((done / count) * 100)
      return img
    }),
  )
  if (signal.aborted) throw new Error('Abgebrochen.')
  const ok: GeneratedImage[] = []
  let firstError = ''
  for (const r of results) {
    if (r.status === 'fulfilled')
      ok.push({ id: storeImage(r.value.data, r.value.mime), mime: r.value.mime })
    else firstError ||= r.reason instanceof Error ? r.reason.message : String(r.reason)
  }
  if (ok.length === 0) throw new Error(firstError || 'Gemini hat kein Bild geliefert.')
  return { images: ok, failed: count - ok.length, error: firstError }
}
