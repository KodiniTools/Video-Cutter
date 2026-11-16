import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cancelRender,
  RENDER_UNSUPPORTED,
  renderDownloadUrl,
  startRender,
  startRenderJob,
  watchRender,
} from '@/lib/renderApi'
import { createDoc } from '@/timeline/model'

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

class FakeEventSource {
  static last: FakeEventSource | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  closed = false
  constructor(public url: string) {
    FakeEventSource.last = this
  }
  close(): void {
    this.closed = true
  }
  send(data: unknown): void {
    this.onmessage?.({ data: typeof data === 'string' ? data : JSON.stringify(data) })
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('startRender', () => {
  it('schickt Dokument, Qualität und Namen und liefert die Job-ID', async () => {
    const fetchMock = vi.fn(async () => json(202, { jobId: 'job-1' }))
    vi.stubGlobal('fetch', fetchMock)
    const doc = createDoc()
    expect(await startRender(doc, { quality: 'high', name: 'Film' })).toBe('job-1')
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('/api/render')
    expect(JSON.parse(init.body as string)).toMatchObject({ quality: 'high', name: 'Film' })
    expect(JSON.parse(init.body as string)).not.toHaveProperty('lossless')
  })

  it('verlangt verlustfrei und meldet, ob der Server es getan hat', async () => {
    const fetchMock = vi.fn(async () => json(202, { jobId: 'job-2', lossless: true }))
    vi.stubGlobal('fetch', fetchMock)
    const options = { quality: 'high', name: 'x', lossless: true } as const
    expect(await startRenderJob(createDoc(), options)).toEqual({ jobId: 'job-2', lossless: true })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toMatchObject({ lossless: true })
    // Altes Backend kennt die Option nicht: Antwort ohne `lossless`.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(202, { jobId: 'job-3' })),
    )
    expect(await startRenderJob(createDoc(), options)).toEqual({ jobId: 'job-3', lossless: false })
  })

  it('erkennt ein veraltetes Backend und reicht Server-Meldungen durch', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(404, { error: 'Nicht gefunden.' })),
    )
    await expect(startRender(createDoc(), { quality: 'standard', name: 'x' })).rejects.toThrow(
      RENDER_UNSUPPORTED,
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(422, { error: 'Die Timeline ist leer.' })),
    )
    await expect(startRender(createDoc(), { quality: 'standard', name: 'x' })).rejects.toThrow(
      'Die Timeline ist leer.',
    )
  })

  it('lehnt eine Antwort ohne Job-ID ab', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(202, {})),
    )
    await expect(startRender(createDoc(), { quality: 'standard', name: 'x' })).rejects.toThrow()
  })
})

describe('watchRender', () => {
  it('meldet den Fortschritt und endet bei „done“', async () => {
    vi.stubGlobal('EventSource', FakeEventSource)
    const seen: number[] = []
    const watch = watchRender('job-1', (p) => seen.push(p))
    const source = FakeEventSource.last as FakeEventSource
    expect(source.url).toContain('/api/cut/job-1/events')
    source.send(': ping')
    source.send({ state: 'processing', progress: 40 })
    source.send({ state: 'done', progress: 250 })
    await watch.done
    expect(seen).toEqual([40, 100])
    expect(source.closed).toBe(true)
  })

  it('lehnt bei Fehlern und Verbindungsabbruch ab', async () => {
    vi.stubGlobal('EventSource', FakeEventSource)
    const failed = watchRender('a', () => undefined)
    ;(FakeEventSource.last as FakeEventSource).send({ state: 'error', error: 'kaputt' })
    await expect(failed.done).rejects.toThrow('kaputt')
    const lost = watchRender('b', () => undefined)
    ;(FakeEventSource.last as FakeEventSource).onerror?.()
    await expect(lost.done).rejects.toThrow('unterbrochen')
  })
})

describe('cancelRender / renderDownloadUrl', () => {
  it('nutzt die Job-Endpunkte und schluckt Netzwerkfehler beim Abbrechen', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('offline')
    })
    vi.stubGlobal('fetch', fetchMock)
    await expect(cancelRender('job 1')).resolves.toBeUndefined()
    expect(fetchMock.mock.calls[0]).toEqual([
      expect.stringContaining('/api/cut/job%201'),
      { method: 'DELETE' },
    ])
    expect(renderDownloadUrl('job-1')).toContain('/api/cut/job-1/download')
  })
})
