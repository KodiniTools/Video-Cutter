import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import {
  DEFAULT_TEXT_STYLE,
  MAX_TEXT_OVERLAYS,
  isValidOverlay,
  overlayFrame,
  toServerOverlay,
  type TextOverlayData,
} from '@/lib/textOverlay'
import { useTextOverlayStore } from '@/stores/textOverlays'
import { startTextJob, TEXT_UNSUPPORTED } from '@/composables/useServerCut'

const o = (p: Partial<TextOverlayData> = {}): TextOverlayData => ({
  ...DEFAULT_TEXT_STYLE,
  text: 'Hallo',
  start: 1,
  end: 4,
  ...p,
})

describe('overlayFrame (Vorschau = Server-Animation)', () => {
  it('nur im Zeitbereich sichtbar', () => {
    expect(overlayFrame(o(), 0.99).visible).toBe(false)
    expect(overlayFrame(o(), 1).visible).toBe(true)
    expect(overlayFrame(o(), 4).visible).toBe(false)
  })

  it('fade: 400 ms ein und aus', () => {
    const a = o({ animation: 'fade' })
    expect(overlayFrame(a, 1).opacity).toBe(0)
    expect(overlayFrame(a, 1.2).opacity).toBeCloseTo(0.5)
    expect(overlayFrame(a, 2).opacity).toBe(1)
    expect(overlayFrame(a, 3.8).opacity).toBeCloseTo(0.5)
  })

  it('slide: startet um SLIDE_OFFSET tiefer und kommt nach 500 ms an', () => {
    const a = o({ animation: 'slide' })
    expect(overlayFrame(a, 1).dy).toBeCloseTo(0.06)
    expect(overlayFrame(a, 1.25).dy).toBeCloseTo(0.03)
    expect(overlayFrame(a, 1.5).dy).toBe(0)
  })

  it('pop: 0.4 -> 1.12 -> 1', () => {
    const a = o({ animation: 'pop' })
    expect(overlayFrame(a, 1).scale).toBeCloseTo(0.4)
    expect(overlayFrame(a, 1.3).scale).toBeCloseTo(1.12)
    expect(overlayFrame(a, 2).scale).toBe(1)
  })

  it('typewriter: ein Zeichen je 60 ms, Umbrüche zählen nicht', () => {
    const a = o({ text: 'ab\ncd', animation: 'typewriter' })
    expect(overlayFrame(a, 1).chars).toBe(1)
    expect(overlayFrame(a, 1.061).chars).toBe(2)
    expect(overlayFrame(a, 1.2).chars).toBe(4)
  })

  it('none: voll sichtbar', () => {
    expect(overlayFrame(o({ animation: 'none' }), 1)).toMatchObject({ opacity: 1, scale: 1 })
  })
})

describe('Hilfsfunktionen', () => {
  it('toServerOverlay entfernt die ID und rundet', () => {
    const s = toServerOverlay({ ...o({ x: 0.123456789 }), id: 7 })
    expect(s).not.toHaveProperty('id')
    expect(s.x).toBe(0.1235)
  })

  it('isValidOverlay prüft Text und Zeitbereich', () => {
    expect(isValidOverlay(o(), 10)).toBe(true)
    expect(isValidOverlay(o({ text: '  ' }), 10)).toBe(false)
    expect(isValidOverlay(o({ start: 5, end: 5.1 }), 10)).toBe(false)
    expect(isValidOverlay(o({ start: 9.9, end: 12 }), 10)).toBe(false)
  })
})

describe('useTextOverlayStore', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('Texte je Video, neue Texte übernehmen das Design des gewählten', () => {
    const s = useTextOverlayStore()
    expect(s.add(1, 10, 'x')).toBeNull() // kein Video gewählt
    s.setItem(1)
    const a = s.add(2, 10, 'A')!
    expect(a).toMatchObject({ start: 2, end: 5, text: 'A' })
    s.update(a.id, { font: 'bebas', size: 5, x: -1 })
    expect(s.selected).toMatchObject({ font: 'bebas', size: 0.3, x: 0 })
    const b = s.add(9.5, 10, 'B')!
    expect(b).toMatchObject({ start: 9.5, end: 10, font: 'bebas' })
    s.setItem(2)
    expect(s.overlays).toHaveLength(0)
    s.setItem(1)
    expect(s.overlays).toHaveLength(2)
    s.clearItem(1)
    expect(s.overlays).toHaveLength(0)
  })

  it('am Videoende wird der Bereich nach vorne verschoben; Limit greift', () => {
    const s = useTextOverlayStore()
    s.setItem(1)
    expect(s.add(10, 10, 'A')).toMatchObject({ start: 7, end: 10 })
    for (let i = 1; i < MAX_TEXT_OVERLAYS; i++) s.add(0, 10, 'x')
    expect(s.canAdd).toBe(false)
    expect(s.add(0, 10, 'zu viel')).toBeNull()
  })
})

describe('startTextJob', () => {
  afterEach(() => vi.unstubAllGlobals())

  const respond = (status: number, body: unknown) =>
    vi
      .fn()
      .mockResolvedValue(
        new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }),
      )

  it('liefert die Job-ID bei Bestätigung', async () => {
    const fetchMock = respond(202, { jobId: 'j1', text: true })
    vi.stubGlobal('fetch', fetchMock)
    await expect(startTextJob('m1', [o()])).resolves.toBe('j1')
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toMatch(/\/api\/text$/)
    expect(JSON.parse(init.body)).toMatchObject({ mediaId: 'm1', texts: [{ text: 'Hallo' }] })
  })

  it('altes Backend (404) -> TEXT_UNSUPPORTED', async () => {
    vi.stubGlobal('fetch', respond(404, { error: 'Nicht gefunden.' }))
    await expect(startTextJob('m1', [o()])).rejects.toThrow(TEXT_UNSUPPORTED)
  })

  it('Validierungsfehler des Servers wird durchgereicht', async () => {
    vi.stubGlobal('fetch', respond(400, { error: 'Text 1 ist leer.' }))
    await expect(startTextJob('m1', [o()])).rejects.toThrow('Text 1 ist leer.')
  })
})
