import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  buildImageRequest,
  extractImage,
  generateImages,
  geminiHttpError,
  getImage,
  imageSizeFor,
  nearestAspect,
} from '../src/lib/gemini'
import { buildImagePromptInput, parseImagePrompt } from '../src/lib/claude'
import { AiJobManager } from '../src/lib/aiJobs'

const PNG_B64 = Buffer.from('fake-png').toString('base64')
const okBody = {
  candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: PNG_B64 } }] } }],
}

describe('nearestAspect / imageSizeFor', () => {
  it('wählt das nächstliegende Seitenverhältnis', () => {
    expect(nearestAspect(1920, 1080)).toBe('16:9')
    expect(nearestAspect(1080, 1920)).toBe('9:16')
    expect(nearestAspect(1080, 1080)).toBe('1:1')
    expect(nearestAspect(1440, 1080)).toBe('4:3')
    expect(nearestAspect(2560, 1080)).toBe('21:9')
    expect(nearestAspect(0, 0)).toBe('16:9')
  })
  it('Auflösungsstufe nach längster Seite', () => {
    expect(imageSizeFor(1024, 576)).toBe('1K')
    expect(imageSizeFor(1920, 1080)).toBe('2K')
    expect(imageSizeFor(3840, 2160)).toBe('4K')
  })
})

describe('buildImageRequest', () => {
  it('nur Bildausgabe mit Seitenverhältnis und Größe', () => {
    expect(buildImageRequest('Berg', '16:9', '2K')).toEqual({
      contents: [{ role: 'user', parts: [{ text: 'Berg' }] }],
      generationConfig: {
        responseModalities: ['IMAGE'],
        imageConfig: { aspectRatio: '16:9', imageSize: '2K' },
      },
    })
  })
})

describe('extractImage', () => {
  it('liest inlineData (auch snake_case)', () => {
    expect(extractImage(okBody).mime).toBe('image/png')
    const snake = {
      candidates: [
        { content: { parts: [{ inline_data: { mime_type: 'image/jpeg', data: PNG_B64 } }] } },
      ],
    }
    expect(extractImage(snake).data.toString()).toBe('fake-png')
  })
  it('verständliche Fehler bei Sicherheitsfilter oder ohne Bild', () => {
    expect(() => extractImage({ promptFeedback: { blockReason: 'SAFETY' } })).toThrow(/abgelehnt/)
    expect(() => extractImage({ candidates: [{ finishReason: 'IMAGE_SAFETY' }] })).toThrow(
      /Sicherheitsfilter/,
    )
    expect(() =>
      extractImage({ candidates: [{ content: { parts: [{ text: 'nur Text' }] } }] }),
    ).toThrow(/kein Bild/)
    expect(() => extractImage(null)).toThrow(/kein Bild/)
  })
  it('ignoriert fremde MIME-Typen', () => {
    const svg = {
      candidates: [
        { content: { parts: [{ inlineData: { mimeType: 'image/svg+xml', data: PNG_B64 } }] } },
      ],
    }
    expect(() => extractImage(svg)).toThrow(/kein Bild/)
  })
})

describe('geminiHttpError', () => {
  it('übersetzt typische Fehler', () => {
    expect(geminiHttpError(400, { error: { message: 'API key not valid.' } }).message).toMatch(
      /GEMINI_API_KEY/,
    )
    expect(geminiHttpError(429, {}).message).toMatch(/429/)
    expect(geminiHttpError(404, {}).message).toMatch(/GEMINI_IMAGE_MODEL/)
    expect(geminiHttpError(500, { error: { message: 'boom' } }).message).toMatch(/500.*boom/)
  })
})

describe('generateImages', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.GEMINI_API_KEY
  })

  it('erzeugt Varianten parallel, sendet den Schlüssel nur im Header', async () => {
    process.env.GEMINI_API_KEY = 'test-key'
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(okBody), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const progress = vi.fn()
    const r = await generateImages('Berg', '16:9', '2K', 3, new AbortController().signal, progress)
    expect(r.images).toHaveLength(3)
    expect(r.failed).toBe(0)
    expect(getImage(r.images[0].id)?.data.toString()).toBe('fake-png')
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toMatch(/models\/.+:generateContent$/)
    expect(url).not.toContain('test-key')
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('test-key')
    expect(progress).toHaveBeenLastCalledWith(100)
  })

  it('liefert die gelungenen Varianten, wenn einzelne scheitern', async () => {
    let n = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        n++ === 0
          ? new Response(JSON.stringify({ error: { message: 'x' } }), { status: 500 })
          : new Response(JSON.stringify(okBody), { status: 200 }),
      ),
    )
    const r = await generateImages('Berg', '1:1', '1K', 2, new AbortController().signal, () => {})
    expect(r.images).toHaveLength(1)
    expect(r.failed).toBe(1)
  })

  it('wirft, wenn keine Variante klappt', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 429 })),
    )
    await expect(
      generateImages('Berg', '1:1', '1K', 2, new AbortController().signal, () => {}),
    ).rejects.toThrow(/429/)
  })
})

describe('Bild-Prompt (Claude)', () => {
  it('baut Text-, Bild- und Transkript-Blöcke je Nachbarclip', () => {
    const blocks = buildImagePromptInput([
      { role: 'before', name: 'a.mp4', jpeg: Buffer.from('j'), transcript: 'Hallo Welt' },
      { role: 'after', name: 'b.mp4', jpeg: null, transcript: '' },
    ])
    expect(blocks.map((b) => b.type)).toEqual(['text', 'image', 'text', 'text'])
    expect(buildImagePromptInput([])).toHaveLength(1)
  })
  it('prüft die Antwort', () => {
    expect(parseImagePrompt({ prompt: '  Ein Berg  ' })).toBe('Ein Berg')
    expect(() => parseImagePrompt({ prompt: '' })).toThrow()
    expect(parseImagePrompt({ prompt: 'x'.repeat(5000) })).toHaveLength(2000)
  })
})

describe('AiJobManager: Bilder', () => {
  it('höchstens 2 Bild-Jobs gleichzeitig', () => {
    const m = new AiJobManager()
    const never = () => new Promise<never>(() => {})
    m.start('image', never)
    expect(m.hasCapacity('image')).toBe(true)
    m.start('image', never)
    expect(m.hasCapacity('image')).toBe(false)
    expect(m.hasCapacity('claude')).toBe(true)
    m.shutdown()
  })
})
