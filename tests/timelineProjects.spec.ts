import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import type { MediaView } from '@/lib/mediaApi'
import type { ProjectSummary, SaveRequest } from '@/lib/projectApi'

// --- Server mocken -----------------------------------------------------------
class MissingMediaError extends Error {
  constructor(public readonly missing: string[]) {
    super('missing')
  }
}
const saveProject = vi.fn()
const uploadAsset = vi.fn((_id: string, _hash: string, _f: Blob) => Promise.resolve())
const fetchProject = vi.fn()
const openProjectMedia = vi.fn()
const deleteProject = vi.fn((_id: string) => Promise.resolve())
const listProjects = vi.fn((): Promise<ProjectSummary[]> => Promise.resolve([]))
const fetchAsset = vi.fn((_id: string, hash: string) =>
  Promise.resolve(new Blob([`asset:${hash}`], { type: 'image/png' })),
)
const hashOfName = (name: string) =>
  Array.from(name)
    .map((c) => c.charCodeAt(0).toString(16).padStart(2, '0'))
    .join('')
    .padEnd(64, '0')
    .slice(0, 64)

vi.mock('@/lib/projectApi', () => ({
  PROJECTS_UNSUPPORTED: 'PROJECTS_UNSUPPORTED',
  MissingMediaError,
  listProjects: () => listProjects(),
  saveProject: (r: SaveRequest) => saveProject(r),
  uploadAsset: (id: string, h: string, f: Blob) => uploadAsset(id, h, f),
  fetchProject: (id: string) => fetchProject(id),
  openProjectMedia: (id: string) => openProjectMedia(id),
  fetchAsset: (id: string, h: string) => fetchAsset(id, h),
  deleteProject: (id: string) => deleteProject(id),
  // Kennung = Dateiname (eindeutig genug für den Test), 64 Hex-Zeichen.
  sha256Hex: async (b: Blob) => hashOfName((b as File).name ?? 'x'),
}))

const uploadMedia = vi.fn((_file: File): Promise<MediaView> => Promise.reject(new Error('nein')))
const fetchMediaFile = vi.fn((_id: string): Promise<Blob> => Promise.reject(new Error('nein')))
vi.mock('@/lib/mediaApi', async (original) => ({
  ...(await original<typeof import('@/lib/mediaApi')>()),
  uploadMedia: (file: File) => ({ promise: uploadMedia(file), abort: () => {} }),
  fetchMediaFile: (id: string) => fetchMediaFile(id),
}))

const ensureDerived = vi.fn((_id: string) => new Promise<never>(() => {}))
vi.mock('@/lib/derivedApi', async (original) => ({
  ...(await original<typeof import('@/lib/derivedApi')>()),
  ensureDerived: (id: string) => ensureDerived(id),
}))

let imageSeq = 0
const imageFiles = new Map<string, File>()
interface FakeDecoded {
  name: string
  file: File
}
const registerImage = (id: string, image: FakeDecoded) => {
  imageFiles.set(id, image.file)
  return { id, name: image.name, file: image.file }
}
vi.mock('@/lib/imageAssets', () => ({
  getImageAsset: (id: string) =>
    imageFiles.has(id) ? { id, file: imageFiles.get(id) } : undefined,
  hasImageAsset: (id: string) => imageFiles.has(id),
  loadImageFile: async (file: File): Promise<FakeDecoded> => {
    if (file.name === 'kaputt.png') throw new Error('decode')
    return { name: file.name, file }
  },
  registerImage: (id: string, image: FakeDecoded) => registerImage(id, image),
  registerBrowserImage: (image: FakeDecoded) => registerImage(`img${++imageSeq}`, image),
  removeImageAsset: (id: string) => imageFiles.delete(id),
  releaseDecodedImage: () => {},
  addImageAsset: async (file: File) => {
    if (file.name === 'kaputt.png') throw new Error('decode')
    return registerImage(`img${++imageSeq}`, { name: file.name, file })
  },
}))

const {
  useTimelineProjectStore,
  TIMELINE_PROJECT_EMPTY,
  TIMELINE_PROJECT_INVALID,
  TIMELINE_PROJECT_MEDIA_GONE,
  TIMELINE_PROJECT_UPLOADS_PENDING,
  AUTOSAVE_DELAY_MS,
} = await import('@/stores/timelineProjects')
const { useTimelineStore } = await import('@/stores/timeline')
const { useMediaPoolStore } = await import('@/stores/mediaPool')
const { assetFromMedia } = await import('@/timeline/assets')
const { newImageData, newGraphicData } = await import('@/timeline/graphics')
const { secondsToTime } = await import('@/timeline/model')
const {
  TimelineProjectError,
  buildTimelineProject,
  isTimelineProject,
  parseTimelineProject,
  rebindProject,
  usedImageIds,
  browserImageIds,
} = await import('@/timeline/projectFile')

const media = (id: string, name = `${id}.mp4`): MediaView => ({
  id,
  name,
  size: 1000,
  duration: 4,
  width: 640,
  height: 360,
  hasAudio: true,
  fps: 25,
})
const summary = (over: Partial<ProjectSummary> = {}): ProjectSummary => ({
  id: 'p1',
  kind: 'timeline',
  name: 'Film',
  createdAt: 1,
  updatedAt: 2,
  videoCount: 1,
  size: 1000,
  ...over,
})
const png = (name: string) => new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' })

/** Editor mit einem Video (Bild + Ton), einem Text, einer Form und einem Bild. */
function fill(): { imageId: string } {
  const timeline = useTimelineStore()
  const pool = useMediaPoolStore()
  pool.replaceAll([media('m1')])
  timeline.putAsset(assetFromMedia(media('m1')))
  expect(timeline.appendMedia('m1')).toBe(true)
  timeline.addText({ text: 'Hallo' }, secondsToTime(2))
  timeline.addGraphic(newGraphicData('rect'), secondsToTime(2))
  const imageId = `img${++imageSeq}`
  imageFiles.set(imageId, png('foto.png'))
  timeline.addGraphic(newImageData(imageId), secondsToTime(2))
  return { imageId }
}

beforeEach(() => {
  // Das automatische Speichern arbeitet mit einer Frist: Zeit von Hand stellen.
  vi.useFakeTimers()
  localStorage.clear()
  setActivePinia(createPinia())
  vi.clearAllMocks()
  imageFiles.clear()
  listProjects.mockResolvedValue([])
})

afterEach(() => {
  vi.useRealTimers()
})

describe('projectFile', () => {
  it('erkennt und liest nur Stände des Timeline-Editors', () => {
    const { imageId } = fill()
    const doc = useTimelineStore().doc
    const ref = { asset: 'a'.repeat(64), name: 'foto.png', type: 'image/png' }
    const raw = JSON.parse(JSON.stringify(buildTimelineProject(doc, { [imageId]: ref })))
    expect(isTimelineProject(raw)).toBe(true)
    expect(isTimelineProject({ version: 1, items: [] })).toBe(false)
    const state = parseTimelineProject(raw)
    expect(state.doc).toEqual(doc)
    expect(state.images).toEqual({ [imageId]: ref })

    const code = (v: unknown) => {
      try {
        parseTimelineProject(v)
      } catch (e) {
        return e instanceof TimelineProjectError ? e.code : 'other'
      }
      return 'ok'
    }
    expect(code({ version: 1, items: [] })).toBe('format')
    expect(code({ ...raw, version: 3 })).toBe('version')
    expect(code({ ...raw, doc: { ...raw.doc, version: 1 } })).toBe('version')
    expect(code({ ...raw, doc: { ...raw.doc, tracks: 'x' } })).toBe('invalid')
    expect(code({ ...raw, doc: { ...raw.doc, tracks: [{ id: 't', kind: 'video' }] } })).toBe(
      'invalid',
    )
    const broken = JSON.parse(JSON.stringify(raw))
    broken.doc.tracks[0].clips[0].start = 'gleich'
    expect(code(broken)).toBe('invalid')
    // Verweis ohne gültige Prüfsumme wird ausgelassen, nicht übernommen.
    expect(parseTimelineProject({ ...raw, images: { x: { asset: 'nein' } } }).images).toEqual({})
  })

  it('schreibt Videos und Bilder auf die neuen IDs um', () => {
    const { imageId } = fill()
    const doc = useTimelineStore().doc
    expect(usedImageIds(doc)).toEqual([imageId])

    const ok = rebindProject(doc, { m1: media('neu') }, new Map([[imageId, 'img900']]))
    expect(ok.missing).toBe(0)
    expect(ok.media.map((m) => m.id)).toEqual(['neu'])
    expect(Object.keys(ok.doc.assets)).toEqual(['neu'])
    const clips = ok.doc.tracks.flatMap((t) => [...t.clips])
    expect(clips.filter((c) => 'asset' in c).map((c) => ('asset' in c ? c.asset : ''))).toEqual([
      'neu',
      'neu',
    ])
    expect(usedImageIds(ok.doc)).toEqual(['img900'])
    expect(useTimelineStore().load(ok.doc)).toEqual([])
    // Die Eingabe bleibt unverändert.
    expect(Object.keys(doc.assets)).toEqual(['m1'])

    // Video und Bild fehlen: Video-Clips entfallen, der Bild-Clip bleibt ohne Bild.
    const gone = rebindProject(doc, {}, new Map())
    expect(gone.missing).toBe(2)
    expect(gone.media).toEqual([])
    const left = gone.doc.tracks.flatMap((t) => [...t.clips])
    expect(left.map((c) => c.kind)).toEqual(['graphic', 'graphic', 'text'].sort())
    expect(usedImageIds(gone.doc)).toEqual([])
    expect(useTimelineStore().load(gone.doc)).toEqual([])
  })
})

const imageMedia = (id: string, name = 'logo.png'): MediaView => ({
  id,
  name,
  size: 300,
  duration: 0,
  width: 40,
  height: 30,
  hasAudio: false,
  fps: 0,
  kind: 'image',
})

describe('projectFile: Bilder der Medienliste', () => {
  it('Bild-Medium: Clip folgt der neuen Medien-ID; altes Bild als Medium übernommen', () => {
    const { imageId } = fill()
    const timeline = useTimelineStore()
    timeline.putAsset(assetFromMedia(imageMedia('b1')))
    timeline.addGraphic(newImageData('b1'), secondsToTime(1))
    const doc = timeline.doc
    // Nur das Bild ohne Medium gehört als Original in den Projektstand.
    expect(browserImageIds(doc)).toEqual([imageId])

    const r = rebindProject(
      doc,
      { m1: media('neu'), b1: imageMedia('b9') },
      new Map([[imageId, imageMedia('b10', 'foto.png')]]),
    )
    expect(r.missing).toBe(0)
    expect(r.media.map((m) => m.id).sort()).toEqual(['b10', 'b9', 'neu'])
    expect(r.doc.assets.b9).toMatchObject({ kind: 'image', duration: null })
    expect(r.doc.assets.b10).toMatchObject({ kind: 'image', name: 'foto.png' })
    expect(usedImageIds(r.doc).sort()).toEqual(['b10', 'b9'])
    expect(browserImageIds(r.doc)).toEqual([])
    expect(timeline.load(r.doc)).toEqual([])

    // Bild-Medium fehlt im Projekt: zählt als fehlend, Clip bleibt mit leerem Verweis.
    const gone = rebindProject(doc, { m1: media('neu') }, new Map([[imageId, 'img7']]))
    expect(gone.missing).toBe(1)
    expect(usedImageIds(gone.doc)).toEqual(['img7'])
  })
})

describe('timelineProjects-Store', () => {
  it('speichert Bilder der Medienliste als Medien, öffnet sie und lädt alte Bilder hoch', async () => {
    const { imageId } = fill()
    const timeline = useTimelineStore()
    timeline.putAsset(assetFromMedia(imageMedia('b1')))
    imageFiles.set('b1', png('logo.png'))
    timeline.addGraphic(newImageData('b1'), secondsToTime(1))
    const store = useTimelineProjectStore()
    saveProject.mockResolvedValue({ project: summary(), missingAssets: [] })
    await store.save('Film')
    const req = saveProject.mock.calls[0][0] as SaveRequest
    expect([...req.media].sort()).toEqual(['b1', 'm1'])
    // Nur das alte Bild (nur im Browser) als Zusatzdatei.
    expect(req.assets.map((a) => a.name)).toEqual(['foto.png'])
    expect(Object.keys((req.state as { images: object }).images)).toEqual([imageId])

    // Öffnen in frischer Sitzung: Bild-Medium vom Server laden, altes Bild hochladen.
    const saved = JSON.parse(JSON.stringify(req.state))
    setActivePinia(createPinia())
    imageFiles.clear()
    fetchProject.mockResolvedValue({ project: summary(), state: saved })
    openProjectMedia.mockResolvedValue({ m1: media('live'), b1: imageMedia('b5') })
    uploadMedia.mockResolvedValueOnce(imageMedia('b6', 'foto.png'))
    fetchMediaFile.mockResolvedValue(new Blob(['x'], { type: 'image/png' }))
    const opened = useTimelineProjectStore()
    const r = await opened.open('p1')
    expect(r.missing).toBe(0)
    expect(fetchMediaFile).toHaveBeenCalledWith('b5')
    const t2 = useTimelineStore()
    expect(Object.keys(t2.doc.assets).sort()).toEqual(['b5', 'b6', 'live'])
    expect(usedImageIds(t2.doc).sort()).toEqual(['b5', 'b6'])
    expect(imageFiles.has('b5') && imageFiles.has('b6')).toBe(true)
    const pool = useMediaPoolStore()
    expect(pool.items.map((i) => i.media?.kind ?? 'video').sort()).toEqual([
      'image',
      'image',
      'video',
    ])
  })

  it('speichert Dokument, Videos und Bild-Originale; lädt fehlende Dateien hoch', async () => {
    const store = useTimelineProjectStore()
    const timeline = useTimelineStore()
    await expect(store.save('Film')).rejects.toThrow(TIMELINE_PROJECT_EMPTY)
    const { imageId } = fill()
    expect(store.dirty).toBe(true)
    const hash = hashOfName('foto.png')
    saveProject.mockResolvedValue({ project: summary(), missingAssets: [hash] })

    const p = await store.save('Film')
    expect(p.id).toBe('p1')
    const req = saveProject.mock.calls[0][0] as SaveRequest
    expect(req.id).toBeUndefined()
    expect(req.media).toEqual(['m1'])
    expect(req.assets).toEqual([{ hash, size: 3, type: 'image/png', name: 'foto.png' }])
    const state = parseTimelineProject(JSON.parse(JSON.stringify(req.state)))
    expect(state.doc).toEqual(timeline.doc)
    expect(state.images[imageId]).toEqual({ asset: hash, name: 'foto.png', type: 'image/png' })
    expect(uploadAsset).toHaveBeenCalledTimes(1)
    expect(uploadAsset.mock.calls[0].slice(0, 2)).toEqual(['p1', hash])
    expect(store.current).toMatchObject({ id: 'p1', name: 'Film' })
    expect(store.dirty).toBe(false)

    // Änderung -> ungespeichert; erneut speichern überschreibt dasselbe Projekt.
    timeline.addText({ text: 'Neu' }, secondsToTime(1))
    expect(store.dirty).toBe(true)
    saveProject.mockResolvedValue({ project: summary(), missingAssets: [] })
    await store.save('Film')
    expect((saveProject.mock.calls[1][0] as SaveRequest).id).toBe('p1')
    await store.save('Kopie', true)
    expect((saveProject.mock.calls[2][0] as SaveRequest).id).toBeUndefined()
  })

  it('meldet laufende Uploads, verfallene Videos und ein veraltetes Backend', async () => {
    const store = useTimelineProjectStore()
    const pool = useMediaPoolStore()
    fill()
    pool.items[0].state = 'uploading'
    await expect(store.save('Film')).rejects.toThrow(TIMELINE_PROJECT_UPLOADS_PENDING)
    pool.items[0].state = 'ready'

    saveProject.mockRejectedValueOnce(new MissingMediaError(['m1']))
    await expect(store.save('Film')).rejects.toThrow(TIMELINE_PROJECT_MEDIA_GONE)

    // Altes Backend nennt keine Art -> neu angelegtes Projekt wieder entfernen.
    saveProject.mockResolvedValueOnce({
      project: summary({ id: 'alt', kind: 'classic' }),
      missingAssets: [],
    })
    await expect(store.save('Film')).rejects.toThrow('PROJECTS_UNSUPPORTED')
    expect(deleteProject).toHaveBeenCalledWith('alt')
    expect(store.current).toBeNull()
    expect(store.busy).toBeNull()
  })

  it('öffnet ein Projekt: neue Video-IDs, Bilder, Medienliste, Verlauf neu', async () => {
    const { imageId } = fill()
    const hash = hashOfName('foto.png')
    const saved = JSON.parse(
      JSON.stringify(
        buildTimelineProject(useTimelineStore().doc, {
          [imageId]: { asset: hash, name: 'foto.png', type: 'image/png' },
        }),
      ),
    )
    // Frische Sitzung.
    setActivePinia(createPinia())
    imageFiles.clear()
    const store = useTimelineProjectStore()
    const timeline = useTimelineStore()
    const pool = useMediaPoolStore()
    fetchProject.mockResolvedValue({ project: summary({ updatedAt: 77 }), state: saved })
    openProjectMedia.mockResolvedValue({ m1: media('live', 'm1.mp4') })

    const r = await store.open('p1')
    expect(r.missing).toBe(0)
    expect(fetchAsset).toHaveBeenCalledWith('p1', hash)
    expect(Object.keys(timeline.doc.assets)).toEqual(['live'])
    expect(pool.items.map((i) => [i.media?.id, i.state])).toEqual([['live', 'ready']])
    expect(ensureDerived).toHaveBeenCalledWith('live')
    const [newImage] = usedImageIds(timeline.doc)
    expect(imageFiles.get(newImage)?.name).toBe('foto.png')
    expect(timeline.canUndo).toBe(false)
    expect(store.current).toEqual({ id: 'p1', name: 'Film', savedAt: 77 })
    expect(store.dirty).toBe(false)

    // Direkt wieder speichern: neue Video-ID, Prüfsumme ohne erneutes Lesen.
    saveProject.mockResolvedValue({ project: summary(), missingAssets: [] })
    await store.save('Film')
    const req = saveProject.mock.calls[0][0] as SaveRequest
    expect(req).toMatchObject({ id: 'p1', media: ['live'] })
    expect(req.assets.map((a) => a.hash)).toEqual([hash])

    // Neues Projekt: alles leer.
    store.startNew()
    expect(timeline.doc.tracks).toEqual([])
    expect(pool.items).toEqual([])
    expect(store.current).toBeNull()
    expect(store.dirty).toBe(false)
  })

  it('fehlende Dateien: zählt sie, lässt die Bearbeitung bei Fehlern unberührt', async () => {
    const { imageId } = fill()
    const before = useTimelineStore().doc
    const saved = JSON.parse(
      JSON.stringify(
        buildTimelineProject(before, {
          [imageId]: { asset: hashOfName('kaputt.png'), name: 'kaputt.png', type: 'image/png' },
        }),
      ),
    )
    const store = useTimelineProjectStore()
    const timeline = useTimelineStore()

    // Kein Projektstand bzw. kaputtes Dokument: nichts ändert sich.
    for (const state of [{ nope: true }, { ...saved, doc: { ...saved.doc, tracks: 'x' } }]) {
      fetchProject.mockResolvedValueOnce({ project: summary(), state })
      await expect(store.open('p1')).rejects.toThrow(TIMELINE_PROJECT_INVALID)
    }
    expect(timeline.doc).toBe(before)
    expect(store.busy).toBeNull()

    fetchProject.mockResolvedValue({ project: summary(), state: saved })
    openProjectMedia.mockResolvedValue({})
    const r = await store.open('p1')
    expect(r.missing).toBe(2)
    expect(Object.keys(timeline.doc.assets)).toEqual([])
    expect(usedImageIds(timeline.doc)).toEqual([])
    // Weicht vom gespeicherten Stand ab -> gilt als ungespeichert.
    expect(store.dirty).toBe(true)
  })

  it('listet auch Projekte der bisherigen App und löscht', async () => {
    const store = useTimelineProjectStore()
    listProjects.mockResolvedValue([
      summary({ id: 'a' }),
      summary({ id: 'b', kind: 'classic' }),
      summary({ id: 'c' }),
    ])
    await store.refresh()
    expect(store.projects.map((p) => [p.id, p.kind])).toEqual([
      ['a', 'timeline'],
      ['b', 'classic'],
      ['c', 'timeline'],
    ])
    await store.remove('a')
    expect(deleteProject).toHaveBeenCalledWith('a')
    expect(store.projects.map((p) => p.id)).toEqual(['b', 'c'])
  })

  it('öffnet ein Projekt der bisherigen App umgewandelt, als neues Projekt', async () => {
    const store = useTimelineProjectStore()
    const timeline = useTimelineStore()
    const pool = useMediaPoolStore()
    const hash = hashOfName('foto.png')
    fetchProject.mockResolvedValue({
      project: summary({ id: 'alt', kind: 'classic', name: 'Urlaub' }),
      state: {
        version: 1,
        items: [
          {
            media: 'm1',
            name: 'a.mp4',
            start: 1,
            end: 3,
            include: true,
            texts: [{ text: 'Hallo', start: 1, end: 2 }],
            graphics: [{ kind: 'image', image: 'img1', start: 1, end: 3 }],
          },
          { media: 'weg', name: 'b.mp4', start: 0, end: null, include: true },
        ],
        music: { asset: 'c'.repeat(64), name: 'musik.mp3', type: 'audio/mpeg' },
        anim: { animation: 'none' },
        images: { img1: { asset: hash, name: 'foto.png', type: 'image/png' } },
      },
    })
    openProjectMedia.mockResolvedValue({ m1: media('live', 'a.mp4') })

    const r = await store.open('alt')
    expect(r).toEqual({ missing: 1, converted: true, skipped: ['music'], name: 'Urlaub' })
    expect(Object.keys(timeline.doc.assets)).toEqual(['live'])
    expect(timeline.doc.tracks.map((t) => t.kind).sort()).toEqual([
      'audio',
      'overlay',
      'overlay',
      'video',
    ])
    expect(pool.items.map((i) => i.media?.id)).toEqual(['live'])
    expect(imageFiles.get(usedImageIds(timeline.doc)[0])?.name).toBe('foto.png')
    // Kein geöffnetes Projekt: Speichern legt ein neues an, das alte bleibt.
    expect(store.current).toBeNull()
    expect(store.suggestedName).toBe('Urlaub')
    expect(store.dirty).toBe(true)
    saveProject.mockResolvedValue({ project: summary({ id: 'neu' }), missingAssets: [] })
    await store.save('Urlaub')
    const req = saveProject.mock.calls[0][0] as SaveRequest
    expect(req.id).toBeUndefined()
    expect(req.media).toEqual(['live'])
    expect(req.assets.map((a) => a.hash)).toEqual([hash])
    expect(store.current?.id).toBe('neu')
    expect(store.suggestedName).toBe('')
  })

  it('lädt die Musik eines Projekts der bisherigen App als Medium hoch', async () => {
    const store = useTimelineProjectStore()
    const timeline = useTimelineStore()
    const pool = useMediaPoolStore()
    const hash = 'c'.repeat(64)
    fetchProject.mockResolvedValue({
      project: summary({ id: 'alt', kind: 'classic', name: 'Urlaub' }),
      state: {
        version: 1,
        items: [{ media: 'm1', name: 'a.mp4', start: 0, end: null, include: true }],
        music: { asset: hash, name: 'musik.mp3', type: 'audio/mpeg', volume: 0.5 },
        anim: { animation: 'none' },
      },
    })
    openProjectMedia.mockResolvedValue({ m1: media('live', 'a.mp4') })
    uploadMedia.mockResolvedValueOnce({
      ...media('song', 'musik.mp3'),
      duration: 1.5,
      width: 0,
      height: 0,
      kind: 'audio',
    })

    const r = await store.open('alt')
    expect(r).toEqual({ missing: 0, converted: true, skipped: [], name: 'Urlaub' })
    expect(fetchAsset).toHaveBeenCalledWith('alt', hash)
    const sent = uploadMedia.mock.calls[0][0]
    expect([sent.name, sent.type]).toEqual(['musik.mp3', 'audio/mpeg'])
    expect(Object.keys(timeline.doc.assets).sort()).toEqual(['live', 'song'])
    expect(pool.items.map((i) => i.media?.id).sort()).toEqual(['live', 'song'])
    // 4 s Video, 1,5 s Musik in Schleife.
    const lane = timeline.doc.tracks.filter((t) => t.kind === 'audio')[1]
    expect(lane.clips.map((c) => [c.asset, c.start, c.duration])).toEqual([
      ['song', 0, 1_500_000],
      ['song', 1_500_000, 1_500_000],
      ['song', 3_000_000, 1_000_000],
    ])
  })
})

describe('automatisches Speichern', () => {
  /** Geöffnetes, gespeichertes Projekt mit einem Video. */
  async function opened() {
    const store = useTimelineProjectStore()
    fill()
    saveProject.mockResolvedValue({ project: summary(), missingAssets: [] })
    await store.save('Film')
    saveProject.mockClear()
    return { store, timeline: useTimelineStore(), pool: useMediaPoolStore() }
  }
  const tick = (ms = AUTOSAVE_DELAY_MS) => vi.advanceTimersByTimeAsync(ms)

  it('speichert ein geöffnetes Projekt kurz nach der letzten Änderung', async () => {
    const { store, timeline } = await opened()
    expect(store.autosaveState).toBe('idle')
    timeline.addText({ text: 'eins' }, secondsToTime(1))
    expect(store.autosaveState).toBe('pending')
    await tick(AUTOSAVE_DELAY_MS - 500)
    // Weitere Änderung: Die Frist beginnt neu.
    timeline.addText({ text: 'zwei' }, secondsToTime(1))
    await tick(AUTOSAVE_DELAY_MS - 500)
    expect(saveProject).not.toHaveBeenCalled()
    await tick(500)
    expect(saveProject).toHaveBeenCalledTimes(1)
    const req = saveProject.mock.calls[0][0] as SaveRequest
    expect(req).toMatchObject({ id: 'p1', name: 'Film' })
    expect(parseTimelineProject(JSON.parse(JSON.stringify(req.state))).doc).toEqual(timeline.doc)
    expect(store.dirty).toBe(false)
    expect(store.autosaveState).toBe('idle')
    // Ohne weitere Änderung passiert nichts mehr.
    await tick(3 * AUTOSAVE_DELAY_MS)
    expect(saveProject).toHaveBeenCalledTimes(1)
  })

  it('neues Projekt, abgeschaltet oder beim Öffnen unvollständig: speichert nicht von selbst', async () => {
    const store = useTimelineProjectStore()
    const timeline = useTimelineStore()
    fill() // noch nie gespeichert
    await tick(3 * AUTOSAVE_DELAY_MS)
    expect(saveProject).not.toHaveBeenCalled()
    expect(store.autosaveState).toBe('idle')

    saveProject.mockResolvedValue({ project: summary(), missingAssets: [] })
    await store.save('Film')
    saveProject.mockClear()
    store.setAutosave(false)
    expect(localStorage.getItem('vc-timeline-autosave')).toBe('off')
    timeline.addText({ text: 'x' }, secondsToTime(1))
    await tick(3 * AUTOSAVE_DELAY_MS)
    expect(saveProject).not.toHaveBeenCalled()
    // Wieder an: die offene Änderung wird nachgeholt.
    store.setAutosave(true)
    await tick()
    expect(saveProject).toHaveBeenCalledTimes(1)
    saveProject.mockClear()

    // Projekt, bei dem ein Video fehlt: erst nach bewusstem Speichern wieder.
    const state = JSON.parse(JSON.stringify(buildTimelineProject(timeline.doc, {})))
    fetchProject.mockResolvedValue({ project: summary(), state })
    openProjectMedia.mockResolvedValue({})
    expect((await store.open('p1')).missing).toBeGreaterThan(0)
    expect(store.incomplete).toBe(true)
    timeline.addText({ text: 'y' }, secondsToTime(1))
    await tick(3 * AUTOSAVE_DELAY_MS)
    expect(saveProject).not.toHaveBeenCalled()
    await store.save('Film')
    expect(store.incomplete).toBe(false)
    saveProject.mockClear()
    timeline.addText({ text: 'z' }, secondsToTime(1))
    await tick()
    expect(saveProject).toHaveBeenCalledTimes(1)
  })

  it('wartet auf laufende Uploads und meldet Fehler ohne Dauerversuch', async () => {
    const { store, timeline, pool } = await opened()
    pool.items[0].state = 'uploading'
    timeline.addText({ text: 'x' }, secondsToTime(1))
    await tick()
    expect(saveProject).not.toHaveBeenCalled()
    expect(store.autosaveState).toBe('pending')
    pool.items[0].state = 'ready'
    saveProject.mockRejectedValueOnce(new Error('Server nicht erreichbar'))
    await tick()
    expect(saveProject).toHaveBeenCalledTimes(1)
    expect(store.autosaveState).toBe('error')
    expect(store.autosaveError).toBe('Server nicht erreichbar')
    expect(store.dirty).toBe(true)
    await tick(3 * AUTOSAVE_DELAY_MS)
    expect(saveProject).toHaveBeenCalledTimes(1)
    // Nächste Änderung versucht es erneut.
    timeline.addText({ text: 'y' }, secondsToTime(1))
    await tick()
    expect(saveProject).toHaveBeenCalledTimes(2)
    expect(store.autosaveState).toBe('idle')
    expect(store.autosaveError).toBe('')
  })

  it('Änderung während des Speicherns wird danach gespeichert', async () => {
    const { store, timeline } = await opened()
    let finish!: () => void
    saveProject.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ project: summary(), missingAssets: [] })
        }),
    )
    timeline.addText({ text: 'eins' }, secondsToTime(1))
    await tick()
    expect(store.autosaveState).toBe('saving')
    timeline.addText({ text: 'zwei' }, secondsToTime(1))
    finish()
    await tick(0)
    expect(store.dirty).toBe(true)
    await tick()
    expect(saveProject).toHaveBeenCalledTimes(2)
    expect(store.dirty).toBe(false)
    expect(store.autosaveState).toBe('idle')
  })
})
