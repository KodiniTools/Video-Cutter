import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  fetchPreviewPlan,
  fetchPreviewSegment,
  parsePreviewPlan,
  PREVIEW_UNSUPPORTED,
} from '@/lib/previewApi'
import { createDoc } from '@/timeline/model'

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

const plan = {
  width: 960,
  height: 540,
  fps: 30,
  duration: 6_000_000,
  segments: [
    { index: 0, start: 0, duration: 4_000_000, key: 'a'.repeat(32), state: 'ready' },
    { index: 1, start: 4_000_000, duration: 2_000_000, key: 'b'.repeat(32), state: 'queued' },
  ],
}

afterEach(() => vi.unstubAllGlobals())

describe('parsePreviewPlan', () => {
  it('übernimmt einen vollständigen Plan', () => {
    const p = parsePreviewPlan(plan)
    expect(p.duration).toBe(6_000_000)
    expect(p.segments).toEqual([
      { index: 0, start: 0, duration: 4_000_000, key: 'a'.repeat(32) },
      { index: 1, start: 4_000_000, duration: 2_000_000, key: 'b'.repeat(32) },
    ])
  })

  it('ist robust gegen Unsinn und endet an der ersten Lücke', () => {
    expect(parsePreviewPlan(null).segments).toEqual([])
    const p = parsePreviewPlan({
      segments: [plan.segments[0], { start: 1, duration: 0, key: 'x' }, plan.segments[1]],
    })
    expect(p.segments).toHaveLength(1)
    expect(p.width).toBe(0)
  })
})

describe('fetchPreviewPlan', () => {
  it('schickt Dokument und Abspielkopf', async () => {
    const fetchMock = vi.fn(async () => json(200, plan))
    vi.stubGlobal('fetch', fetchMock)
    const doc = createDoc()
    const p = await fetchPreviewPlan(doc, 1_500_000.4)
    expect(p.segments).toHaveLength(2)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('/api/preview/plan')
    expect(JSON.parse(init.body as string)).toEqual({
      doc: JSON.parse(JSON.stringify(doc)),
      at: 1_500_000,
    })
  })

  it('volle Auflösung: schickt den Wunsch und liest die Antwort des Servers', async () => {
    const fetchMock = vi.fn(async () =>
      json(200, { ...plan, width: 1920, height: 1080, full: true }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const p = await fetchPreviewPlan(createDoc(), 0, undefined, true)
    expect(p.full).toBe(true)
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string).full).toBe(true)
    // Altes Backend antwortet ohne das Feld: gilt als kleine Vorschau.
    expect(parsePreviewPlan(plan).full).toBe(false)
  })

  it('erkennt ein veraltetes Backend', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(404, { error: 'Nicht gefunden.' })),
    )
    await expect(fetchPreviewPlan(createDoc(), 0)).rejects.toThrow(PREVIEW_UNSUPPORTED)
  })

  it('reicht die Meldung des Servers durch', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(409, { error: 'Bitte erneut hochladen.' })),
    )
    await expect(fetchPreviewPlan(createDoc(), 0)).rejects.toThrow('Bitte erneut hochladen.')
  })
})

describe('fetchPreviewSegment', () => {
  it('fragt erneut, solange der Abschnitt in Arbeit ist', async () => {
    const answers = [
      json(202, { state: 'rendering' }),
      new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
    ]
    const fetchMock = vi.fn(async () => answers.shift() as Response)
    vi.stubGlobal('fetch', fetchMock)
    const data = await fetchPreviewSegment('k')
    expect(new Uint8Array(data as ArrayBuffer)).toEqual(new Uint8Array([1, 2, 3]))
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('meldet unbekannte Abschnitte mit null und Renderfehler als Fehler', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(404, { error: 'Unbekannter Abschnitt.' })),
    )
    expect(await fetchPreviewSegment('k')).toBeNull()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(500, { error: 'Vorschau konnte nicht gerendert werden.' })),
    )
    await expect(fetchPreviewSegment('k')).rejects.toThrow('nicht gerendert')
  })
})
