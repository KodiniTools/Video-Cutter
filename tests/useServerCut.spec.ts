import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { parseJobStart, useServerCut, CROP_UNSUPPORTED } from '@/composables/useServerCut'

describe('parseJobStart', () => {
  it('liest jobId und Crop-Bestätigung', () => {
    expect(parseJobStart('{"jobId":"abc","crop":true}')).toEqual({ jobId: 'abc', crop: true })
  })

  it('altes Backend ohne crop-Feld -> crop false', () => {
    expect(parseJobStart('{"jobId":"abc"}')).toEqual({ jobId: 'abc', crop: false })
  })

  it('wirft bei fehlender jobId oder ungültigem JSON', () => {
    expect(() => parseJobStart('{}')).toThrow(/jobId/)
    expect(() => parseJobStart('nicht-json')).toThrow(/Ungültige Serverantwort/)
  })
})

/**
 * Minimaler XHR-Ersatz: beantwortet den Upload sofort mit `responseText`.
 * Nur das Nötigste, was `uploadForJob` benutzt.
 */
function fakeXhr(responseText: string) {
  const instances: FakeXhr[] = []
  class FakeXhr {
    status = 202
    responseText = responseText
    upload = { onprogress: null as null | ((e: ProgressEvent) => void) }
    onload: null | (() => void) = null
    onerror: null | (() => void) = null
    onabort: null | (() => void) = null
    sentForm: FormData | null = null
    constructor() {
      instances.push(this)
    }
    open(): void {}
    abort(): void {}
    send(form: FormData): void {
      this.sentForm = form
      queueMicrotask(() => this.onload?.())
    }
  }
  return { FakeXhr, instances }
}

describe('useServerCut – Crop-Bestätigung des Backends', () => {
  const file = new File([new Uint8Array([0])], 'clip.mp4', { type: 'video/mp4' })
  const segments = [{ start: 0, duration: 5 }]
  const crop = { x: 0.1, y: 0.1, width: 0.5, height: 0.5 }
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response('{"cancelled":true}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('bricht ab und löscht den Job, wenn der Server den Crop nicht bestätigt', async () => {
    const { FakeXhr, instances } = fakeXhr('{"jobId":"job-1"}') // altes Backend
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
    const { cut, isProcessing } = useServerCut()

    await expect(cut(file, segments, 'reencode', 'keep', 10, undefined, crop)).rejects.toThrow(
      CROP_UNSUPPORTED,
    )

    // Crop wurde mitgeschickt …
    expect(instances[0].sentForm?.get('crop')).toBe(JSON.stringify(crop))
    // … und der (ungeschnittene) Job serverseitig abgebrochen.
    expect(fetchMock).toHaveBeenCalledWith('/api/cut/job-1', { method: 'DELETE' })
    expect(isProcessing.value).toBe(false)
  })

  it('ohne Crop-Anforderung ist ein altes Backend kein Fehler (kein DELETE)', async () => {
    const { FakeXhr } = fakeXhr('{"jobId":"job-2"}')
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
    // SSE-Phase sofort beenden: EventSource liefert "done".
    class FakeEventSource {
      onmessage: null | ((ev: { data: string }) => void) = null
      onerror: null | (() => void) = null
      constructor() {
        queueMicrotask(() =>
          this.onmessage?.({ data: '{"state":"done","progress":100,"error":null}' }),
        )
      }
      close(): void {}
    }
    vi.stubGlobal('EventSource', FakeEventSource)
    // Download-Antwort (String-Body: jsdom-Blob und Node-Response passen nicht zusammen).
    fetchMock.mockResolvedValueOnce(new Response('xyz', { status: 200 }))

    const { cut } = useServerCut()
    const blob = await cut(file, segments, 'copy', 'keep', 10)
    expect(blob.size).toBe(3)
    expect(fetchMock).not.toHaveBeenCalledWith('/api/cut/job-2', { method: 'DELETE' })
  })
})
