import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  FONT_RETRY_DELAYS,
  fontFileUrl,
  getCustomFont,
  groupFonts,
  loadCustomFonts,
  parseFontList,
  resetCustomFonts,
} from '@/lib/customFonts'
import { FONT_OPTIONS, fontPreview } from '@/lib/textOverlay'

const entry = (file: string, extra: Record<string, unknown> = {}) => ({
  key: `f:${file.replace(/\.[^.]+$/, '')}`,
  file,
  group: file.split('-')[0],
  label: 'Regular',
  weight: 400,
  italic: false,
  lineRatio: 1.3,
  shift: 0.05,
  ...extra,
})

describe('eigene Schriften (Frontend)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    resetCustomFonts()
  })

  it('kennt die Dateien aus src/assets/fonts', () => {
    expect(fontFileUrl('Supreme-Regular.woff2')).toBeTruthy()
    expect(fontFileUrl('Gibtsnicht.woff2')).toBeUndefined()
  })

  it('parseFontList: nur gültige Einträge mit vorhandener Datei', () => {
    const list = parseFontList({
      fonts: [
        entry('Supreme-Regular.woff2'),
        entry('Gibtsnicht.woff2'),
        { key: 'roboto', file: 'Supreme-Bold.woff2' },
        null,
      ],
    })
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ key: 'f:Supreme-Regular', css: 'VCF Supreme-Regular' })
    expect(parseFontList({})).toEqual([])
  })

  it('groupFonts sortiert Familien und Schnitte (Stärke, dann kursiv)', () => {
    const list = parseFontList({
      fonts: [
        entry('Zodiak-Bold.woff2', { group: 'Zodiak', weight: 700 }),
        entry('Supreme-BoldItalic.woff2', { group: 'Supreme', weight: 700, italic: true }),
        entry('Supreme-Bold.woff2', { group: 'Supreme', weight: 700 }),
        entry('Supreme-Light.woff2', { group: 'Supreme', weight: 300 }),
      ],
    })
    const g = groupFonts(list)
    expect(g.map((x) => x.group)).toEqual(['Supreme', 'Zodiak'])
    expect(g[0].fonts.map((f) => f.file)).toEqual([
      'Supreme-Light.woff2',
      'Supreme-Bold.woff2',
      'Supreme-BoldItalic.woff2',
    ])
  })

  it('versucht es erneut, wenn der Server gerade nicht antwortet (Neustart beim Deploy)', async () => {
    vi.useFakeTimers()
    try {
      const fetchMock = vi
        .fn()
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockResolvedValueOnce(new Response('Bad Gateway', { status: 502 }))
        .mockResolvedValue(new Response(JSON.stringify({ fonts: [entry('Zodiak-Bold.woff2')] })))
      vi.stubGlobal('fetch', fetchMock)
      await loadCustomFonts()
      expect(getCustomFont('f:Zodiak-Bold')).toBeUndefined()
      // Die Wahl bleibt sichtbar, auch wenn die Schrift noch nicht geladen ist.
      expect(fontPreview('f:Zodiak-Bold')).toEqual({ ...FONT_OPTIONS.roboto, label: 'Zodiak Bold' })
      await vi.advanceTimersByTimeAsync(FONT_RETRY_DELAYS[0])
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(getCustomFont('f:Zodiak-Bold')).toBeUndefined()
      await vi.advanceTimersByTimeAsync(FONT_RETRY_DELAYS[1])
      expect(fetchMock).toHaveBeenCalledTimes(3)
      expect(getCustomFont('f:Zodiak-Bold')).toBeDefined()
      // Danach kein weiterer Abruf.
      await vi.advanceTimersByTimeAsync(60000)
      expect(fetchMock).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('lädt die Liste vom Server; Vorschau nutzt deren Messwerte, sonst Roboto', async () => {
    expect(fontPreview('f:Supreme-Regular')).toMatchObject({ css: FONT_OPTIONS.roboto.css })
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ fonts: [entry('Supreme-Regular.woff2')] })),
        ),
    )
    await loadCustomFonts()
    expect(getCustomFont('f:Supreme-Regular')).toBeDefined()
    expect(fontPreview('f:Supreme-Regular')).toMatchObject({
      css: 'VCF Supreme-Regular',
      lineRatio: 1.3,
      shift: 0.05,
    })
  })
})
