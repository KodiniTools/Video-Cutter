import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { mount, flushPromises } from '@vue/test-utils'
import type { MediaView } from '@/lib/mediaApi'
import type { DerivedStatus, PartState } from '@/lib/derivedApi'
import { i18n } from '@/i18n'

// --- Server-Zugriffe als Attrappen -----------------------------------------
interface PendingUpload {
  file: File
  progress: (ratio: number) => void
  resolve: (m: MediaView) => void
  reject: (e: Error) => void
  abort: ReturnType<typeof vi.fn>
}
const uploads: PendingUpload[] = []
const deleteMedia = vi.fn((_id: string) => Promise.resolve())
const fetchMediaFile = vi.fn((_id: string) =>
  Promise.resolve(new Blob(['bild'], { type: 'image/png' })),
)

// Bilder: Dekodieren gibt es in jsdom nicht, daher eine einfache Registry.
const images = new Map<string, { name: string; file: File; pinned?: boolean }>()
vi.mock('@/lib/imageAssets', async (original) => ({
  ...(await original<typeof import('@/lib/imageAssets')>()),
  hasImageAsset: (id: string) => images.has(id),
  getImageAsset: (id: string) =>
    images.has(id) ? { id, ...images.get(id), source: {}, width: 40, height: 30 } : undefined,
  loadImageFile: async (file: File) => {
    if (file.name.startsWith('kaputt')) throw new Error('Bild kann nicht gelesen werden.')
    return { name: file.name, file, source: {}, width: 40, height: 30 }
  },
  registerImage: (id: string, image: { name: string; file: File }) => {
    images.set(id, { ...image, pinned: true })
    return { id, ...image }
  },
  removeImageAsset: (id: string) => images.delete(id),
  releaseDecodedImage: () => {},
}))

vi.mock('@/lib/mediaApi', () => ({
  UPLOAD_ABORTED: 'UPLOAD_ABORTED',
  MEDIA_UNSUPPORTED: 'MEDIA_UNSUPPORTED',
  MEDIA_AUDIO_UNSUPPORTED: 'MEDIA_AUDIO_UNSUPPORTED',
  MEDIA_IMAGE_UNSUPPORTED: 'MEDIA_IMAGE_UNSUPPORTED',
  isAudioFile: (f: File) => f.type.startsWith('audio/'),
  isImageFile: (f: File) => ['image/png', 'image/jpeg', 'image/webp'].includes(f.type),
  fetchMediaFile: (id: string) => fetchMediaFile(id),
  uploadMedia: (file: File, onProgress: (ratio: number) => void) => {
    let resolve!: (m: MediaView) => void
    let reject!: (e: Error) => void
    const promise = new Promise<MediaView>((res, rej) => {
      resolve = res
      reject = rej
    })
    const abort = vi.fn(() => reject(new Error('UPLOAD_ABORTED')))
    uploads.push({ file, progress: onProgress, resolve, reject, abort })
    return { promise, abort }
  },
  deleteMedia: (id: string) => deleteMedia(id),
}))

const ensureDerived = vi.fn<(id: string) => Promise<DerivedStatus>>()
const fetchDerivedStatus = vi.fn<(id: string) => Promise<DerivedStatus>>()
const fetchPeaks = vi.fn<(id: string) => Promise<Uint8Array>>()

vi.mock('@/lib/derivedApi', async (original) => ({
  ...(await original<typeof import('@/lib/derivedApi')>()),
  ensureDerived: (id: string) => ensureDerived(id),
  fetchDerivedStatus: (id: string) => fetchDerivedStatus(id),
  fetchPeaks: (id: string) => fetchPeaks(id),
}))

const { useMediaPoolStore, DERIVED_POLL_MS } = await import('@/stores/mediaPool')
const { useTimelineStore } = await import('@/stores/timeline')
const { default: MediaPool } = await import('@/components/timeline/MediaPool.vue')
const { secondsToTime } = await import('@/timeline/model')
type Clip = import('@/timeline/model').Clip

const video = (name: string) => new File([new Uint8Array([0])], name, { type: 'video/mp4' })
const media = (over: Partial<MediaView> = {}): MediaView => ({
  id: 'm1',
  name: 'a.mp4',
  size: 1000,
  duration: 12.5,
  width: 1920,
  height: 1080,
  hasAudio: true,
  fps: 30,
  ...over,
})
const status = (peaks: PartState, strip: PartState, proxy: PartState, progress = 0) =>
  ({
    peaks: { state: peaks, rate: peaks === 'ready' ? 50 : 0, count: peaks === 'ready' ? 3 : 0 },
    strip:
      strip === 'ready'
        ? { state: strip, interval: 1, count: 13, columns: 10, tileWidth: 160, tileHeight: 90 }
        : { state: strip, interval: 0, count: 0, columns: 0, tileWidth: 0, tileHeight: 0 },
    proxy: {
      state: proxy,
      progress,
      width: proxy === 'ready' ? 960 : 0,
      height: proxy === 'ready' ? 540 : 0,
    },
  }) satisfies DerivedStatus

describe('Medienliste (Store)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.useFakeTimers()
    uploads.length = 0
    deleteMedia.mockClear()
    ensureDerived.mockReset()
    fetchDerivedStatus.mockReset()
    fetchPeaks.mockReset().mockResolvedValue(new Uint8Array([10, 200, 30]))
  })
  afterEach(() => {
    useMediaPoolStore().dispose()
    vi.useRealTimers()
  })

  it('lädt hoch, meldet das Medium an und fragt den Stand ab, bis alles fertig ist', async () => {
    const pool = useMediaPoolStore()
    const timeline = useTimelineStore()
    ensureDerived.mockResolvedValue(status('queued', 'queued', 'queued'))
    fetchDerivedStatus
      .mockResolvedValueOnce(status('ready', 'ready', 'running', 40))
      .mockResolvedValueOnce(status('ready', 'ready', 'ready'))

    pool.add([video('a.mp4')])
    expect(pool.items).toMatchObject([{ name: 'a.mp4', state: 'uploading', progress: 0 }])
    uploads[0].progress(0.5)
    expect(pool.items[0].progress).toBe(0.5)

    uploads[0].resolve(media())
    await flushPromises()
    expect(pool.items[0]).toMatchObject({ state: 'ready', prepare: 'busy' })
    expect(timeline.doc.assets.m1).toMatchObject({
      kind: 'video',
      duration: secondsToTime(12.5),
      hasAudio: true,
      fps: 30,
    })
    // Anmelden ist kein Verlaufsschritt.
    expect(timeline.canUndo).toBe(false)
    expect(ensureDerived).toHaveBeenCalledWith('m1')

    await vi.advanceTimersByTimeAsync(DERIVED_POLL_MS)
    expect(pool.items[0].derived?.proxy).toMatchObject({ state: 'running', progress: 40 })
    expect(pool.items[0].prepare).toBe('busy')
    expect([...pool.items[0].peaks!]).toEqual([10, 200, 30])

    await vi.advanceTimersByTimeAsync(DERIVED_POLL_MS)
    expect(pool.items[0].prepare).toBe('done')
    // Danach wird nicht weiter gefragt, die Wellenform nicht doppelt geladen.
    await vi.advanceTimersByTimeAsync(DERIVED_POLL_MS * 10)
    expect(fetchDerivedStatus).toHaveBeenCalledTimes(2)
    expect(fetchPeaks).toHaveBeenCalledTimes(1)
  })

  it('nimmt Videos und Tondateien an, lehnt alles andere ab', () => {
    const pool = useMediaPoolStore()
    pool.add([
      new File(['x'], 'notiz.txt', { type: 'text/plain' }),
      video('a.mp4'),
      new File(['x'], 'lied.mp3', { type: 'audio/mpeg' }),
    ])
    expect(pool.rejected).toEqual(['notiz.txt'])
    expect(pool.items.map((i) => i.name)).toEqual(['a.mp4', 'lied.mp3'])
    pool.add([video('b.mp4')])
    expect(pool.rejected).toEqual([])
  })

  it('zeigt Upload-Fehler am Eintrag', async () => {
    const pool = useMediaPoolStore()
    pool.add([video('a.mp4')])
    uploads[0].reject(new Error('Speicher auf dem Server ist voll.'))
    await flushPromises()
    expect(pool.items[0]).toMatchObject({
      state: 'error',
      error: 'Speicher auf dem Server ist voll.',
    })
    expect(ensureDerived).not.toHaveBeenCalled()
  })

  it('erkennt ein veraltetes Backend und fehlgeschlagene Teile; „Erneut“ stößt neu an', async () => {
    const pool = useMediaPoolStore()
    ensureDerived.mockRejectedValueOnce(new Error('DERIVED_UNSUPPORTED'))
    pool.add([video('a.mp4')])
    uploads[0].resolve(media())
    await flushPromises()
    expect(pool.items[0].prepare).toBe('unsupported')

    ensureDerived.mockResolvedValueOnce(status('ready', 'error', 'error'))
    await pool.prepare(pool.items[0].key)
    expect(pool.items[0].prepare).toBe('failed')

    ensureDerived.mockResolvedValueOnce(status('ready', 'ready', 'ready'))
    await pool.prepare(pool.items[0].key)
    expect(pool.items[0].prepare).toBe('done')
    expect(ensureDerived).toHaveBeenCalledTimes(3)
  })

  it('meldet ein auf dem Server gelöschtes Video', async () => {
    const pool = useMediaPoolStore()
    ensureDerived.mockResolvedValue(status('queued', 'queued', 'queued'))
    fetchDerivedStatus.mockRejectedValue(new Error('DERIVED_MEDIA_GONE'))
    pool.add([video('a.mp4')])
    uploads[0].resolve(media())
    await flushPromises()
    await vi.advanceTimersByTimeAsync(DERIVED_POLL_MS)
    expect(pool.items[0]).toMatchObject({ state: 'error', error: 'DERIVED_MEDIA_GONE' })
  })

  it('entfernt ein Medium überall und beendet die Abfragen', async () => {
    const pool = useMediaPoolStore()
    const timeline = useTimelineStore()
    ensureDerived.mockResolvedValue(status('queued', 'queued', 'queued'))
    fetchDerivedStatus.mockResolvedValue(status('queued', 'queued', 'running'))
    pool.add([video('a.mp4')])
    uploads[0].resolve(media())
    await flushPromises()

    expect(pool.remove(pool.items[0].key)).toBe('removed')
    expect(pool.items).toEqual([])
    expect(timeline.doc.assets.m1).toBeUndefined()
    expect(deleteMedia).toHaveBeenCalledWith('m1')
    await vi.advanceTimersByTimeAsync(DERIVED_POLL_MS * 5)
    expect(fetchDerivedStatus).not.toHaveBeenCalled()
    expect(pool.remove('gibt-es-nicht')).toBe('not-found')
  })

  it('entfernt kein Medium, das ein Clip verwendet', async () => {
    const pool = useMediaPoolStore()
    const timeline = useTimelineStore()
    ensureDerived.mockResolvedValue(status('ready', 'ready', 'ready'))
    pool.add([video('a.mp4')])
    uploads[0].resolve(media())
    await flushPromises()
    timeline.addTrack({ id: 'V1', kind: 'video', name: 'Video' })
    timeline.insertClip('V1', {
      id: 'c',
      kind: 'video',
      asset: 'm1',
      start: 0,
      duration: secondsToTime(2),
      sourceIn: 0,
      speed: 1,
    })
    expect(pool.remove(pool.items[0].key)).toBe('in-use')
    expect(pool.items).toHaveLength(1)
    expect(deleteMedia).not.toHaveBeenCalled()

    timeline.removeClip('c')
    expect(pool.remove(pool.items[0].key)).toBe('removed')
    // Der Clip steckt noch im Verlauf -> Verlauf geleert, damit er nicht ohne Medium zurückkommt.
    expect(timeline.canUndo).toBe(false)
  })

  it('bricht einen laufenden Upload beim Entfernen ab und räumt ein spät fertiges Video weg', async () => {
    const pool = useMediaPoolStore()
    pool.add([video('a.mp4'), video('b.mp4')])
    expect(pool.remove(pool.items[0].key)).toBe('removed')
    expect(uploads[0].abort).toHaveBeenCalled()
    await flushPromises()
    expect(pool.items.map((i) => i.name)).toEqual(['b.mp4'])

    // Upload, der trotz Entfernen noch durchkommt.
    const key = pool.items[0].key
    uploads[1].abort.mockImplementation(() => {})
    pool.remove(key)
    uploads[1].resolve(media({ id: 'm2' }))
    await flushPromises()
    expect(deleteMedia).toHaveBeenCalledWith('m2')
    expect(useTimelineStore().doc.assets.m2).toBeUndefined()
  })
})

describe('Medienliste: Bilder', () => {
  const png = (name: string) => new File([new Uint8Array([1])], name, { type: 'image/png' })
  const imageView = (over: Partial<MediaView> = {}): MediaView =>
    media({
      id: 'b1',
      name: 'logo.png',
      duration: 0,
      hasAudio: false,
      fps: 0,
      kind: 'image',
      ...over,
    })

  beforeEach(() => {
    setActivePinia(createPinia())
    uploads.length = 0
    images.clear()
    deleteMedia.mockClear()
    ensureDerived.mockReset()
    fetchMediaFile.mockClear()
  })

  it('lädt ein Bild auf den Server, registriert es unter der Medien-ID und meldet es an', async () => {
    const pool = useMediaPoolStore()
    const timeline = useTimelineStore()
    const ready = vi.fn()
    pool.add([png('logo.png')], ready)
    expect(pool.rejected).toEqual([])
    expect(pool.items).toMatchObject([{ name: 'logo.png', state: 'uploading' }])
    uploads[0].resolve(imageView())
    await flushPromises()
    expect(pool.items[0]).toMatchObject({
      state: 'ready',
      prepare: 'done',
      media: { kind: 'image' },
    })
    expect(images.has('b1')).toBe(true)
    expect(timeline.doc.assets.b1).toMatchObject({ kind: 'image', duration: null, width: 1920 })
    // Keine Wellenform/Filmstreifen für Bilder.
    expect(ensureDerived).not.toHaveBeenCalled()
    expect(ready).toHaveBeenCalledWith(expect.objectContaining({ id: 'b1' }))
  })

  it('Klick auf das Vorschaubild eines Bildes öffnet die große Vorschau, ✕/Esc/daneben schließt', async () => {
    const pool = useMediaPoolStore()
    pool.add([png('logo.png')])
    uploads[0].resolve(imageView())
    await flushPromises()
    const wrapper = mount(MediaPool, { global: { plugins: [i18n] }, attachTo: document.body })
    const thumb = wrapper.get('[data-testid="media-pool-image-thumb"]')
    expect(thumb.element.tagName).toBe('BUTTON')
    expect(thumb.attributes('aria-label')).toBe('logo.png groß anzeigen')
    expect(wrapper.find('[data-testid="image-lightbox"]').exists()).toBe(false)

    await thumb.trigger('click')
    const box = wrapper.get('[data-testid="image-lightbox"]')
    expect(box.attributes('aria-label')).toBe('logo.png')
    expect(wrapper.get('[data-testid="image-lightbox-img"]').attributes('src')).toBe(
      '/api/media/b1/file',
    )
    expect(box.text()).toContain('1920×1080')
    // Klick aufs Bild schließt nicht.
    await wrapper.get('[data-testid="image-lightbox-img"]').trigger('click')
    expect(wrapper.find('[data-testid="image-lightbox"]').exists()).toBe(true)

    await wrapper.get('[data-testid="image-lightbox-close"]').trigger('click')
    expect(wrapper.find('[data-testid="image-lightbox"]').exists()).toBe(false)

    await thumb.trigger('click')
    await wrapper.get('[data-testid="image-lightbox"]').trigger('cancel')
    expect(wrapper.find('[data-testid="image-lightbox"]').exists()).toBe(false)

    await thumb.trigger('click')
    await wrapper.get('[data-testid="image-lightbox"] .frame').trigger('click')
    expect(wrapper.find('[data-testid="image-lightbox"]').exists()).toBe(false)

    // Entfernen schließt eine offene Vorschau.
    await thumb.trigger('click')
    pool.remove(pool.items[0].key)
    await flushPromises()
    expect(wrapper.find('[data-testid="image-lightbox"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('„+ Timeline“ legt ein Bild als Bild-Clip an; verwendet = nicht entfernbar', async () => {
    const pool = useMediaPoolStore()
    const timeline = useTimelineStore()
    pool.add([png('logo.png')])
    uploads[0].resolve(imageView())
    await flushPromises()
    const wrapper = mount(MediaPool, { global: { plugins: [i18n] } })
    expect(wrapper.find('[data-testid="media-pool-image-thumb"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('1920×1080')
    await wrapper.find('.to-timeline').trigger('click')
    const clips = timeline.doc.tracks.flatMap((t): Clip[] => [...t.clips])
    expect(clips).toHaveLength(1)
    expect(clips[0]).toMatchObject({ kind: 'graphic', data: { kind: 'image', image: 'b1' } })
    expect(timeline.playhead).toBe(clips[0].start + clips[0].duration)

    expect(pool.remove(pool.items[0].key)).toBe('in-use')
    expect(images.has('b1')).toBe(true)
    timeline.removeSelection()
    expect(pool.remove(pool.items[0].key)).toBe('removed')
    expect(images.has('b1')).toBe(false)
    expect(deleteMedia).toHaveBeenCalledWith('b1')
    wrapper.unmount()
  })

  it('älteres Backend: still entfernen (Ausweichen auf „nur im Browser“) oder Hinweis zeigen', async () => {
    const pool = useMediaPoolStore()
    const quiet = pool.addImage(png('a.png'), { quietUnsupported: true })
    await flushPromises()
    uploads[0].reject(new Error('MEDIA_IMAGE_UNSUPPORTED'))
    await expect(quiet).rejects.toThrow('MEDIA_IMAGE_UNSUPPORTED')
    expect(pool.items).toEqual([])

    pool.add([png('b.png')])
    await flushPromises()
    uploads[1].reject(new Error('MEDIA_IMAGE_UNSUPPORTED'))
    await flushPromises()
    expect(pool.items[0]).toMatchObject({ state: 'error', error: 'MEDIA_IMAGE_UNSUPPORTED' })
  })

  it('unlesbares Bild: Upload abgebrochen, Fehler am Eintrag', async () => {
    const pool = useMediaPoolStore()
    await expect(pool.addImage(png('kaputt.png'))).rejects.toThrow('nicht gelesen')
    expect(uploads[0].abort).toHaveBeenCalled()
    expect(pool.items[0]).toMatchObject({
      state: 'error',
      error: 'Bild kann nicht gelesen werden.',
    })
  })

  it('lädt Bilder geöffneter Projekte vom Server; Fehler zeigt „Erneut versuchen“', async () => {
    const pool = useMediaPoolStore()
    await pool.loadImages([imageView(), media()])
    expect(fetchMediaFile).toHaveBeenCalledTimes(1)
    expect(images.has('b1')).toBe(true)

    fetchMediaFile.mockRejectedValueOnce(new Error('weg'))
    pool.replaceAll([imageView({ id: 'b2', name: 'weg.png' })])
    await flushPromises()
    expect(pool.items[0]).toMatchObject({ prepare: 'failed', error: 'IMAGE_LOAD_FAILED' })
    await pool.prepare(pool.items[0].key)
    expect(pool.items[0].prepare).toBe('done')
    expect(images.has('b2')).toBe(true)
  })
})

describe('Medienliste (Komponente)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    uploads.length = 0
    ensureDerived.mockReset()
    fetchDerivedStatus.mockReset()
    fetchPeaks.mockReset().mockResolvedValue(new Uint8Array([10, 200, 30]))
  })
  afterEach(() => useMediaPoolStore().dispose())

  function mountPool() {
    return mount(MediaPool, { global: { plugins: [i18n] } })
  }

  it('zeigt Leerzustand, Upload, Vorschaubild aus dem Filmstreifen und Stand', async () => {
    ensureDerived.mockResolvedValue(status('ready', 'ready', 'ready'))
    const wrapper = mountPool()
    expect(wrapper.text()).toContain('Noch keine Medien')

    const input = wrapper.get('[data-testid=media-pool-input]')
    Object.defineProperty(input.element, 'files', { value: [video('a.mp4')], configurable: true })
    await input.trigger('change')
    expect(wrapper.text()).toContain('Lädt hoch … 0 %')
    expect(wrapper.find('[role=progressbar]').exists()).toBe(true)

    uploads[0].resolve(media())
    await flushPromises()
    expect(wrapper.text()).toContain('a.mp4')
    expect(wrapper.text()).toContain('0:13 · 1920×1080')
    expect(wrapper.text()).toContain('Bereit')
    expect(wrapper.find('[role=progressbar]').exists()).toBe(false)
    expect(wrapper.find('canvas').exists()).toBe(true)
    // Mittleres Bild (Nr. 6 von 13): Spalte 6, Zeile 0, auf 96 px Breite skaliert.
    const thumb = wrapper.get('.thumb').attributes('style')
    expect(thumb).toContain('/api/media/m1/strip')
    expect(thumb).toContain('background-size: 960px 108px')
    expect(thumb).toContain('background-position: -576px 0px')
  })

  it('zeigt Tondateien mit Note und legt sie auf eine Ton-Spur', async () => {
    ensureDerived.mockResolvedValue(status('ready', 'unavailable', 'unavailable'))
    const wrapper = mountPool()
    const pool = useMediaPoolStore()
    const timeline = useTimelineStore()
    pool.add([new File([new Uint8Array([0])], 'lied.mp3', { type: 'audio/mpeg' })])
    uploads[0].resolve(
      media({ name: 'lied.mp3', width: 0, height: 0, fps: 0, duration: 30, kind: 'audio' }),
    )
    await flushPromises()
    expect(wrapper.get('.item').attributes('data-kind')).toBe('audio')
    expect(wrapper.get('.thumb').text()).toContain('♪')
    expect(wrapper.text()).toContain('0:30 · Tondatei')
    expect(wrapper.text()).toContain('Bereit')
    expect(timeline.doc.assets.m1).toMatchObject({ kind: 'audio', hasAudio: true })

    const add = wrapper.get('.to-timeline')
    expect(add.attributes('title')).toBe('lied.mp3 am Abspielkopf auf eine Ton-Spur legen')
    timeline.seek(2_000_000)
    await add.trigger('click')
    expect(timeline.doc.tracks.map((t) => [t.kind, t.clips.length])).toEqual([['audio', 1]])
    // Genau am Abspielkopf, nicht bei 0 bzw. hinten angehängt.
    expect(timeline.doc.tracks[0].clips[0]).toMatchObject({
      asset: 'm1',
      start: 2_000_000,
      kind: 'audio',
    })
  })

  it('erklärt, warum ein verwendetes Video nicht entfernt wird', async () => {
    ensureDerived.mockResolvedValue(status('unavailable', 'ready', 'ready'))
    const wrapper = mountPool()
    const pool = useMediaPoolStore()
    const timeline = useTimelineStore()
    pool.add([video('a.mp4')])
    uploads[0].resolve(media({ hasAudio: false }))
    await flushPromises()
    timeline.addTrack({ id: 'V1', kind: 'video', name: 'Video' })
    timeline.insertClip('V1', {
      id: 'c',
      kind: 'video',
      asset: 'm1',
      start: 0,
      duration: secondsToTime(2),
      sourceIn: 0,
      speed: 1,
    })
    await wrapper.get('button.icon').trigger('click')
    expect(wrapper.text()).toContain('wird in der Timeline verwendet')
    expect(wrapper.find('canvas').exists()).toBe(false)

    timeline.removeClip('c')
    await wrapper.get('button.icon').trigger('click')
    expect(wrapper.text()).toContain('Noch keine Medien')
  })

  it('zeigt Fortschritt der Vorbereitung und den Hinweis bei veraltetem Backend', async () => {
    ensureDerived.mockResolvedValueOnce(status('ready', 'ready', 'running', 42))
    fetchDerivedStatus.mockReturnValue(new Promise(() => {}))
    const wrapper = mountPool()
    const pool = useMediaPoolStore()
    pool.add([video('a.mp4'), new File(['x'], 'b.txt', { type: 'text/plain' })])
    uploads[0].resolve(media())
    await flushPromises()
    expect(wrapper.text()).toContain('Vorschau wird vorbereitet … 42 %')
    expect(wrapper.text()).toContain(
      'Weder Video, Ton noch Bild (JPEG, PNG, WebP), übersprungen: b.txt',
    )

    pool.remove(pool.items[0].key)
    ensureDerived.mockRejectedValueOnce(new Error('DERIVED_UNSUPPORTED'))
    pool.add([video('c.mp4')])
    uploads[1].resolve(media({ id: 'm3' }))
    await flushPromises()
    expect(wrapper.text()).toContain('Backend ist veraltet')
  })
  it('spielt das Vorschaubild beim Überfahren stumm und per Klick mit Ton ab', async () => {
    ensureDerived.mockResolvedValueOnce(status('ready', 'ready', 'running', 10))
    fetchDerivedStatus.mockResolvedValue(status('ready', 'ready', 'ready'))
    const wrapper = mountPool()
    const pool = useMediaPoolStore()
    pool.add([video('a.mp4')])
    uploads[0].resolve(media())
    await flushPromises()
    // Vorschau-Kopie noch nicht fertig: kein Abspielen.
    expect(wrapper.find('[data-testid=media-pool-thumb]').exists()).toBe(false)

    // Echte Zeit: Vue verwirft Ereignisse, die älter wirken als der Listener (Fake-Uhr).
    await new Promise((resolve) => setTimeout(resolve, DERIVED_POLL_MS + 50))
    await flushPromises()
    const thumb = wrapper.get('[data-testid=media-pool-thumb]')
    expect(thumb.attributes('aria-label')).toBe('Vorschau von a.mp4 mit Ton abspielen')
    expect(thumb.attributes('style')).toContain('/api/media/m1/strip')
    expect(wrapper.find('video').exists()).toBe(false)

    await thumb.trigger('mouseenter')
    let el = wrapper.get('video').element as HTMLVideoElement
    expect(el.getAttribute('src')).toContain('/api/media/m1/proxy')
    expect(el.muted).toBe(true)
    expect(el.loop).toBe(true)
    await thumb.trigger('mouseleave')
    expect(wrapper.find('video').exists()).toBe(false)

    await thumb.trigger('mouseenter')
    await thumb.trigger('click')
    el = wrapper.get('video').element as HTMLVideoElement
    expect(el.muted).toBe(false)
    expect(el.loop).toBe(false)
    expect(thumb.attributes('aria-pressed')).toBe('true')
    expect(thumb.attributes('aria-label')).toBe('Vorschau von a.mp4 anhalten')
    // Mit Ton läuft es weiter, auch wenn die Maus das Bild verlässt.
    await thumb.trigger('mouseleave')
    expect(wrapper.find('video').exists()).toBe(true)
    await thumb.trigger('click')
    expect(wrapper.find('video').exists()).toBe(false)

    // Mit Ton bis zum Ende: danach aus.
    await thumb.trigger('click')
    await wrapper.get('video').trigger('ended')
    expect(wrapper.find('video').exists()).toBe(false)

    // Fehlt die Vorschau-Kopie, wird das Original geladen.
    await thumb.trigger('mouseenter')
    await wrapper.get('video').trigger('error')
    expect(wrapper.get('video').attributes('src')).toContain('/api/media/m1/file')
  })

  it('spielt Tondateien per Klick ab, nicht beim Überfahren', async () => {
    ensureDerived.mockResolvedValue(status('ready', 'unavailable', 'unavailable'))
    const wrapper = mountPool()
    const pool = useMediaPoolStore()
    pool.add([new File([new Uint8Array([0])], 'lied.mp3', { type: 'audio/mpeg' })])
    uploads[0].resolve(
      media({ name: 'lied.mp3', width: 0, height: 0, fps: 0, duration: 30, kind: 'audio' }),
    )
    await flushPromises()
    const thumb = wrapper.get('[data-testid=media-pool-thumb]')
    expect(thumb.attributes('aria-label')).toBe('lied.mp3 anhören')

    await thumb.trigger('mouseenter')
    expect(wrapper.find('audio').exists()).toBe(false)

    await thumb.trigger('click')
    expect(wrapper.get('audio').attributes('src')).toContain('/api/media/m1/file')
    expect(wrapper.find('video').exists()).toBe(false)
    expect(thumb.attributes('aria-label')).toBe('lied.mp3 anhalten')
    await thumb.trigger('mouseleave')
    expect(wrapper.find('audio').exists()).toBe(true)

    await thumb.trigger('click')
    expect(wrapper.find('audio').exists()).toBe(false)

    await thumb.trigger('click')
    await wrapper.get('audio').trigger('ended')
    expect(wrapper.find('audio').exists()).toBe(false)
  })
})
