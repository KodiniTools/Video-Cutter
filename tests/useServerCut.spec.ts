import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  parseJobStart,
  useServerCut,
  CROP_UNSUPPORTED,
  APPEND_UNSUPPORTED,
  FORMAT_UNSUPPORTED,
  MUSIC_UNSUPPORTED,
  MEDIA_UNSUPPORTED,
  GRAPHICS_UNSUPPORTED,
  AUDIO_FADE_UNSUPPORTED,
  PREVIEW_UNSUPPORTED,
  startTextJob,
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
      music: false,
      seamTransitions: false,
      audioFade: false,
      storeResult: false,
      preview: false,
      mergeHold: false,
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
      music: false,
      seamTransitions: false,
      audioFade: false,
      storeResult: false,
      preview: false,
      mergeHold: false,
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
      music: false,
      seamTransitions: false,
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

  it('sendet Musik + Einstellungen und bricht ab, wenn der Server sie nicht bestätigt', async () => {
    const { FakeXhr, instances } = fakeXhr('{"jobId":"job-8","outputFormat":true}')
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
    const song = new File([new Uint8Array([1])], 'song.mp3', { type: 'audio/mpeg' })
    const { cut } = useServerCut()

    await expect(
      cut(file, segments, 'reencode', 'keep', 10, undefined, undefined, [], false, undefined, {
        file: song,
        volume: 0.25,
        originalVolume: 0.8,
        fade: false,
        loop: true,
      }),
    ).rejects.toThrow(MUSIC_UNSUPPORTED)
    const form = instances[0].sentForm
    expect(form?.get('music')).toBeInstanceOf(File)
    expect(form?.get('musicVolume')).toBe('0.25')
    expect(form?.get('musicOriginalVolume')).toBe('0.8')
    expect(form?.get('musicFade')).toBe('0')
    expect(form?.get('musicLoop')).toBe('1')
    expect(fetchMock).toHaveBeenCalledWith('/api/cut/job-8', { method: 'DELETE' })
  })

  it('sendet Übergänge je Nahtstelle (mit Dauer) und bricht ab, wenn nicht bestätigt', async () => {
    const { FakeXhr, instances } = fakeXhr('{"jobId":"job-9","append":1,"appendTrim":true}')
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
    const extra = new File([new Uint8Array([1])], 'b.mp4', { type: 'video/mp4' })
    const { cut } = useServerCut()
    await expect(
      cut(
        file,
        segments,
        'reencode',
        'keep',
        10,
        { preset: 'none', duration: 3 },
        undefined,
        [{ file: extra }],
        false,
        undefined,
        undefined,
        ['slide'],
      ),
    ).rejects.toThrow(APPEND_UNSUPPORTED)
    const form = instances[0].sentForm
    expect(form?.get('seamTransitions')).toBe('["slide"]')
    expect(form?.get('transitionDuration')).toBe('3')
    expect(form?.has('transitionPreset')).toBe(false)
  })

  it('nur Standard-Nahtstellen -> kein seamTransitions-Feld', async () => {
    const { FakeXhr, instances } = fakeXhr('{"jobId":"job-10"}')
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
    const extra = new File([new Uint8Array([1])], 'b.mp4', { type: 'video/mp4' })
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
        [{ file: extra }],
        false,
        undefined,
        undefined,
        [null],
      ),
    ).rejects.toThrow(APPEND_UNSUPPORTED)
    expect(instances[0].sentForm?.has('seamTransitions')).toBe(false)
  })
})

describe('useServerCut – Video-Bibliothek (cutMedia)', () => {
  const A = '00000000-0000-4000-8000-00000000000a'
  const B = '00000000-0000-4000-8000-00000000000b'
  const R = '00000000-0000-4000-8000-0000000000ee'
  let fetchMock: ReturnType<typeof vi.fn>

  /** SSE liefert sofort "done" – optional mit der Bibliotheks-ID des Ergebnisses. */
  function fakeEventSource(mediaId?: string) {
    return class {
      onmessage: null | ((ev: { data: string }) => void) = null
      onerror: null | (() => void) = null
      constructor() {
        queueMicrotask(() =>
          this.onmessage?.({
            data: JSON.stringify({ state: 'done', progress: 100, error: null, mediaId }),
          }),
        )
      }
      close(): void {}
    }
  }

  beforeEach(() => {
    fetchMock = vi.fn(async (url: string) => {
      if (url === `/api/media/${R}`)
        return new Response(
          JSON.stringify({
            id: R,
            name: 'a_cut.mp4',
            size: 3,
            duration: 4,
            width: 640,
            height: 360,
            hasAudio: true,
          }),
          { status: 200 },
        )
      if (url === `/api/media/${R}/file`) return new Response('xyz', { status: 200 })
      return new Response('{}', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('schickt IDs statt Dateien, fordert Speichern an und lädt das Ergebnis', async () => {
    const { FakeXhr, instances } = fakeXhr(
      `{"jobId":"job-m1","append":1,"appendTrim":true,"appendSlots":true,"storeResult":true}`,
    )
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
    vi.stubGlobal('EventSource', fakeEventSource(R))
    const { cutMedia, isProcessing } = useServerCut()

    const res = await cutMedia({
      mediaId: A,
      segments: [{ start: 0, duration: 5 }],
      mode: 'reencode',
      appends: [{ mediaId: B, start: 1, duration: 2, position: 'after' }],
    })
    const form = instances[0].sentForm
    expect(form?.get('mediaId')).toBe(A)
    expect(form?.get('appendMediaIds')).toBe(JSON.stringify([B]))
    expect(form?.get('storeResult')).toBe('1')
    expect(form?.has('video')).toBe(false)
    expect(form?.has('append')).toBe(false)
    expect(res.media).toMatchObject({ id: R, name: 'a_cut.mp4', duration: 4 })
    expect(res.blob.size).toBe(3)
    expect(isProcessing.value).toBe(false)
  })

  it('altes Backend ohne storeResult-Bestätigung -> MEDIA_UNSUPPORTED, Job wird gelöscht', async () => {
    const { FakeXhr } = fakeXhr('{"jobId":"job-m2"}')
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
    const { cutMedia } = useServerCut()
    await expect(
      cutMedia({ mediaId: A, segments: [{ start: 0, duration: 5 }], mode: 'copy' }),
    ).rejects.toThrow(MEDIA_UNSUPPORTED)
    expect(fetchMock).toHaveBeenCalledWith('/api/cut/job-m2', { method: 'DELETE' })
  })

  it('sendet Ton-Blende (Dauer + Kurve) und bricht ab, wenn der Server sie nicht bestätigt', async () => {
    const { FakeXhr, instances } = fakeXhr('{"jobId":"job-f1","storeResult":true}')
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
    const { cutMedia } = useServerCut()
    await expect(
      cutMedia({
        mediaId: A,
        segments: [{ start: 0, duration: 5 }],
        mode: 'copy',
        audioFade: { inDuration: 1.5, inCurve: 'exp', outDuration: 0, outCurve: 'tri' },
      }),
    ).rejects.toThrow(AUDIO_FADE_UNSUPPORTED)
    const form = instances[0].sentForm
    expect(form?.get('audioFadeIn')).toBe('1.5')
    expect(form?.get('audioFadeInCurve')).toBe('exp')
    expect(form?.get('audioFadeOut')).toBe('0')
    expect(form?.get('audioFadeOutCurve')).toBe('tri')
    expect(fetchMock).toHaveBeenCalledWith('/api/cut/job-f1', { method: 'DELETE' })
  })

  it('ohne Ton-Blende keine Felder (altes Backend bleibt nutzbar)', async () => {
    const { FakeXhr, instances } = fakeXhr('{"jobId":"job-f2","storeResult":true}')
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
    vi.stubGlobal('EventSource', fakeEventSource(R))
    const { cutMedia } = useServerCut()
    await cutMedia({ mediaId: A, segments: [{ start: 0, duration: 5 }], mode: 'copy' })
    expect(instances[0].sentForm?.has('audioFadeIn')).toBe(false)
  })

  it('fertig ohne Ergebnis-ID -> MEDIA_UNSUPPORTED', async () => {
    const { FakeXhr } = fakeXhr('{"jobId":"job-m3","storeResult":true}')
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
    vi.stubGlobal('EventSource', fakeEventSource())
    const { cutMedia } = useServerCut()
    await expect(
      cutMedia({ mediaId: A, segments: [{ start: 0, duration: 5 }], mode: 'copy' }),
    ).rejects.toThrow(MEDIA_UNSUPPORTED)
  })
})

describe('startTextJob – Grafiken (Formen/Emojis)', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  const graphic = {
    png: 'data:image/png;base64,AAAA',
    x: 0.5,
    y: 0.5,
    start: 0,
    end: 2,
    animation: 'none' as const,
  }

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('ohne Grafiken: kein Health-Abruf, Anfrage unverändert', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"jobId":"t1","text":true}', { status: 202 }))
    await expect(startTextJob('m1', [])).resolves.toBe('t1')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body as string)).toEqual({
      mediaId: 'm1',
      texts: [],
    })
  })

  it('altes Backend (Feature fehlt in /api/health) -> GRAPHICS_UNSUPPORTED, kein Job', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"features":["text"]}', { status: 200 }))
    await expect(startTextJob('m1', [], undefined, [graphic])).rejects.toThrow(GRAPHICS_UNSUPPORTED)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('fehlende Bestätigung in der Job-Antwort -> Job abbrechen, GRAPHICS_UNSUPPORTED', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('{"features":["graphics"]}', { status: 200 }))
      .mockResolvedValueOnce(new Response('{"jobId":"t2","text":true}', { status: 202 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
    await expect(startTextJob('m1', [], undefined, [graphic])).rejects.toThrow(GRAPHICS_UNSUPPORTED)
    expect(fetchMock).toHaveBeenCalledWith('/api/cut/t2', { method: 'DELETE' })
  })

  it('neues Backend: sendet Grafiken mit', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('{"features":["graphics"]}', { status: 200 }))
      .mockResolvedValueOnce(
        new Response('{"jobId":"t3","text":true,"graphics":true}', { status: 202 }),
      )
    await expect(startTextJob('m1', [], undefined, [graphic])).resolves.toBe('t3')
    const body = JSON.parse(fetchMock.mock.calls[1]![1].body as string)
    expect(body.graphics).toEqual([graphic])
  })
})

describe('useServerCut – Vorschau des Zusammenfügens (previewMerge)', () => {
  const A = '00000000-0000-4000-8000-00000000000a'
  const B = '00000000-0000-4000-8000-00000000000b'
  let fetchMock: ReturnType<typeof vi.fn>

  class DoneEventSource {
    onmessage: null | ((ev: { data: string }) => void) = null
    onerror: null | (() => void) = null
    constructor() {
      queueMicrotask(() =>
        this.onmessage?.({ data: JSON.stringify({ state: 'done', progress: 100, error: null }) }),
      )
    }
    close(): void {}
  }

  beforeEach(() => {
    fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/download')) return new Response('vorschau', { status: 200 })
      return new Response('{}', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('EventSource', DoneEventSource)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const req = {
    mediaId: A,
    segments: [{ start: 0, duration: 5 }],
    mode: 'reencode' as const,
    appends: [{ mediaId: B, start: 0, position: 'after' as const }],
  }

  it('fordert preview statt storeResult an und lädt die Vorschau herunter', async () => {
    const { FakeXhr, instances } = fakeXhr(
      '{"jobId":"job-p1","append":1,"appendTrim":true,"appendSlots":true,"preview":true}',
    )
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
    const { previewMerge, isProcessing } = useServerCut()
    const blob = await previewMerge(req)
    const form = instances[0].sentForm
    expect(form?.get('preview')).toBe('1')
    expect(form?.has('storeResult')).toBe(false)
    expect(form?.get('appendMediaIds')).toBe(JSON.stringify([B]))
    expect(fetchMock).toHaveBeenCalledWith('/api/cut/job-p1/download')
    expect(await blob.text()).toBe('vorschau')
    expect(isProcessing.value).toBe(false)
  })

  it('altes Backend ohne preview-Bestätigung -> PREVIEW_UNSUPPORTED, Job wird gelöscht', async () => {
    const { FakeXhr } = fakeXhr(
      '{"jobId":"job-p2","append":1,"appendTrim":true,"appendSlots":true}',
    )
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
    const { previewMerge } = useServerCut()
    await expect(previewMerge(req)).rejects.toThrow(PREVIEW_UNSUPPORTED)
    expect(fetchMock).toHaveBeenCalledWith('/api/cut/job-p2', { method: 'DELETE' })
  })
})
