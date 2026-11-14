import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  FALLBACK_MODELS,
  listModels,
  modelKindOf,
  orderModels,
  parseModelList,
  resetModelCache,
  resolveModel,
} from '../src/lib/geminiModels'
import { buildImageRequest } from '../src/lib/gemini'
import { buildVideoRequest } from '../src/lib/geminiVideo'
import { parseGalleryMeta } from '../src/lib/gallery'
import { config } from '../src/config'

/** Modellliste eines echten Schlüssels (14.11.2026), gekürzt um Textmodelle. */
const LIVE = {
  models: [
    { name: 'models/gemini-3.8-flash' },
    { name: 'models/gemini-2.5-flash-image' },
    { name: 'models/gemini-3-pro-image-preview' },
    { name: 'models/gemini-3-pro-image' },
    { name: 'models/nano-banana-pro-preview' },
    { name: 'models/gemini-3.1-flash-image-preview' },
    { name: 'models/gemini-3.1-flash-image' },
    { name: 'models/gemini-3.1-flash-lite-image' },
    { name: 'models/gemini-nano-banana-2.1' },
    { name: 'models/gemini-omni-flash-preview' },
    { name: 'models/gemini-omni-1.1-flash' },
    { name: 'models/gemini-omni-1.2-flash' },
  ],
}

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.GEMINI_API_KEY
  resetModelCache()
})

describe('Modellnamen', () => {
  it('erkennt Bild- und Videomodelle am Namen', () => {
    expect(modelKindOf('gemini-nano-banana-2.1')).toBe('image')
    expect(modelKindOf('gemini-3-pro-image')).toBe('image')
    expect(modelKindOf('gemini-omni-1.2-flash')).toBe('video')
    expect(modelKindOf('veo-3.1-generate-preview')).toBe('video')
    expect(modelKindOf('gemini-3.8-flash')).toBeNull()
    expect(modelKindOf('../omni')).toBeNull()
    expect(modelKindOf('gemini-omni-1.2-flash:generateContent?x=1')).toBeNull()
  })

  it('resolveModel: leer = Voreinstellung, falsche Art oder Unsinn abgelehnt', () => {
    expect(resolveModel('image', undefined)).toBe(config.geminiImageModel)
    expect(resolveModel('video', '')).toBe(config.geminiVideoModel)
    expect(resolveModel('image', 'gemini-3-pro-image')).toBe('gemini-3-pro-image')
    expect(resolveModel('image', 'gemini-omni-1.2-flash')).toBeNull()
    expect(resolveModel('video', 'gemini-3-pro-image')).toBeNull()
    expect(resolveModel('video', 42)).toBeNull()
    expect(resolveModel('image', 'models/x/../../y')).toBeNull()
  })

  it('parseModelList und Reihenfolge: Voreinstellung zuerst, Vorschau zuletzt', () => {
    const lists = parseModelList(LIVE)
    expect(lists.video).toEqual([
      'gemini-omni-flash-preview',
      'gemini-omni-1.1-flash',
      'gemini-omni-1.2-flash',
    ])
    expect(orderModels('video', lists.video)).toEqual([
      'gemini-omni-1.2-flash',
      'gemini-omni-1.1-flash',
      'gemini-omni-flash-preview',
    ])
    const img = orderModels('image', lists.image)
    expect(img[0]).toBe('gemini-nano-banana-2.1')
    expect(img).toHaveLength(8)
    expect(img.slice(-3).every((m) => m.includes('preview'))).toBe(true)
    expect(parseModelList(null)).toEqual({ image: [], video: [] })
  })
})

describe('listModels', () => {
  it('fragt Google einmal und merkt sich die Liste', async () => {
    process.env.GEMINI_API_KEY = 'k'
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(LIVE), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const a = await listModels()
    expect(a.live).toBe(true)
    expect(a.video.models).toContain('gemini-omni-1.1-flash')
    expect(a.image.default).toBe(config.geminiImageModel)
    await listModels()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).not.toContain('k=')
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('k')
  })

  it('Ersatzliste ohne Schlüssel oder bei Fehler', async () => {
    const a = await listModels()
    expect(a.live).toBe(false)
    expect(a.image.models).toEqual(orderModels('image', FALLBACK_MODELS.image))
    process.env.GEMINI_API_KEY = 'k'
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 500 })),
    )
    expect((await listModels()).live).toBe(false)
  })
})

describe('gewähltes Modell in den Anfragen', () => {
  it('Video: Modell im Body', () => {
    expect(buildVideoRequest('x', '16:9', 8, 'gemini-omni-1.1-flash').model).toBe(
      'gemini-omni-1.1-flash',
    )
  })
  it('Bild: 2.5er Modell ohne imageSize', () => {
    const cfg = (m: string) =>
      (buildImageRequest('x', '16:9', '2K', m).generationConfig as { imageConfig: unknown })
        .imageConfig
    expect(cfg('gemini-2.5-flash-image')).toEqual({ aspectRatio: '16:9' })
    expect(cfg('gemini-3-pro-image')).toEqual({ aspectRatio: '16:9', imageSize: '2K' })
  })
  it('Galerie merkt sich das Modell (alte Einträge: leer)', () => {
    const id = '11111111-1111-4111-8111-111111111111'
    expect(parseGalleryMeta({ id, mime: 'image/png' })?.model).toBe('')
    expect(parseGalleryMeta({ id, mime: 'image/png', model: 'gemini-3-pro-image' })?.model).toBe(
      'gemini-3-pro-image',
    )
  })
})
