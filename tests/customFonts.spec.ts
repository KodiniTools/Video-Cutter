import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  fontFileUrl,
  getCustomFont,
  groupFonts,
  loadCustomFonts,
  parseFontList,
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
  afterEach(() => vi.unstubAllGlobals())

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

  it('lädt die Liste vom Server; Vorschau nutzt deren Messwerte, sonst Roboto', async () => {
    expect(fontPreview('f:Supreme-Regular')).toEqual(FONT_OPTIONS.roboto)
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
