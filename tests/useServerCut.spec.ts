import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  parseJobStart,
  useServerCut,
  CROP_UNSUPPORTED,
  APPEND_UNSUPPORTED,
  FORMAT_UNSUPPORTED,
} from '@/composables/useServerCut'

describe('parseJobStart', () => {
  it('liest jobId und Crop-Bestätigung', () => {
    expect(parseJobStart('{"jobId":"abc","crop":true}')).toEqual({
      jobId: 'abc',
      crop: true,
      append: 0,
      appendTrim: false,
      appendSlots: false,
      normalizeAudio: false,
      outputFormat: false,
    })
  })

  it('altes Backend ohne crop-Feld -> crop false', () => {
    expect(parseJobStart('{"jobId":"abc"}')).toEqual({
      jobId: 'abc',
      crop: false,
      append: 0,
      appendTrim: false,
      appendSlots: false,
      normalizeAudio: false,
      outputFormat: false,
    })
  })

  it('liest die Anzahl übernommener angehängter Videos', () => {
    expect(parseJobStart('{"jobId":"abc","append":2}').append).toBe(2)
    expect(parseJobStart('{"jobId":"abc","append":"2"}').append).toBe(0)
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

  it('schickt angehängte Videos als "append" und bricht bei altem Backend ab', async () => {
    const { FakeXhr, instances } = fakeXhr('{"jobId":"job-3","crop":false}') // ohne append
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
    const extra = new File([new Uint8Array([1])], 'b.mp4', { type: 'video/mp4' })
    const { cut, isProcessing } = useServerCut()

    await expect(
      cut(file, segments, 'reencode', 'keep', 10, undefined, undefined, [
        { file: extra },
        { file: extra },
      ]),
    ).rejects.toThrow(APPEND_UNSUPPORTED)

    expect(instances[0].sentForm?.getAll('append')).toHaveLength(2)
    expect(fetchMock).toHaveBeenCalledWith('/api/cut/job-3', { method: 'DELETE' })
    expect(isProcessing.value).toBe(false)
  })

  it('sendet Kürzung/Position als appendMeta und bricht ab, wenn der Server sie nicht bestätigt', async () => {
    // Server kennt "append", aber noch nicht "appendTrim".
    const { FakeXhr, instances } = fakeXhr('{"jobId":"job-4","append":1}')
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
    const extra = new File([new Uint8Array([1])], 'intro.mp4', { type: 'video/mp4' })
    const { cut } = useServerCut()

    await expect(
      cut(file, segments, 'reencode', 'keep', 10, undefined, undefined, [
        { file: extra, start: 1, duration: 2, position: 'before' },
      ]),
    ).rejects.toThrow(APPEND_UNSUPPORTED)

    expect(JSON.parse(String(instances[0].sentForm?.get('appendMeta')))).toEqual([
      { start: 1, duration: 2, position: 'before' },
    ])
    expect(fetchMock).toHaveBeenCalledWith('/api/cut/job-4', { method: 'DELETE' })
  })
  it('sendet slot + normalizeAudio und bricht ab, wenn der Server sie nicht bestätigt', async () => {
    // Server kennt append/appendTrim, aber weder appendSlots noch normalizeAudio.
    const { FakeXhr, instances } = fakeXhr('{"jobId":"job-5","append":1,"appendTrim":true}')
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
    const extra = new File([new Uint8Array([1])], 'mitte.mp4', { type: 'video/mp4' })
    const { cut } = useServerCut()

    await expect(
      cut(
        file,
        segments,
        'reencode',
        'keep',
        10,
        undefined,
        undefined,
        [{ file: extra, position: 'after', slot: 1 }],
        true,
      ),
    ).rejects.toThrow(APPEND_UNSUPPORTED)

    const form = instances[0].sentForm
    expect(JSON.parse(String(form?.get('appendMeta')))).toEqual([
      { start: 0, position: 'after', slot: 1 },
    ])
    expect(form?.get('normalizeAudio')).toBe('1')
    expect(fetchMock).toHaveBeenCalledWith('/api/cut/job-5', { method: 'DELETE' })
  })

  it('parseJobStart liest appendSlots/normalizeAudio', () => {
    expect(
      parseJobStart('{"jobId":"j","append":1,"appendSlots":true,"normalizeAudio":true}'),
    ).toMatchObject({ appendSlots: true, normalizeAudio: true })
    expect(parseJobStart('{"jobId":"j"}')).toMatchObject({
      appendSlots: false,
      normalizeAudio: false,
      outputFormat: false,
    })
  })

  it('sendet Ausgabeformat nur bei != auto und bricht ab, wenn der Server es nicht bestätigt', async () => {
    const { FakeXhr, instances } = fakeXhr('{"jobId":"job-6"}')
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
    const { cut } = useServerCut()

    await expect(
      cut(file, segments, 'reencode', 'keep', 10, undefined, undefined, [], false, {
        aspect: '9:16',
        fill: 'blur',
      }),
    ).rejects.toThrow(FORMAT_UNSUPPORTED)
    expect(instances[0].sentForm?.get('outputAspect')).toBe('9:16')
    expect(instances[0].sentForm?.get('outputFill')).toBe('blur')
    expect(fetchMock).toHaveBeenCalledWith('/api/cut/job-6', { method: 'DELETE' })
  })

  it("'auto' sendet keine Formatfelder", async () => {
    const { FakeXhr, instances } = fakeXhr('{"jobId":"job-7"}')
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
    vi.stubGlobal(
      'EventSource',
      class {
        onmessage: null | ((ev: { data: string }) => void) = null
        onerror: null | (() => void) = null
        constructor() {
          queueMicrotask(() =>
            this.onmessage?.({ data: '{"state":"done","progress":100,"error":null}' }),
          )
        }
        close(): void {}
      },
    )
    fetchMock.mockResolvedValueOnce(new Response('xyz', { status: 200 }))
    const { cut } = useServerCut()
    await cut(file, segments, 'copy', 'keep', 10, undefined, undefined, [], false, {
      aspect: 'auto',
      fill: 'pad',
    })
    expect(instances[0].sentForm?.has('outputAspect')).toBe(false)
  })
})
