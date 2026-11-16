import { describe, it, expect, beforeEach, vi } from 'vitest'
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

const ensureDerived = vi.fn((_id: string) => new Promise<never>(() => {}))
vi.mock('@/lib/derivedApi', async (original) => ({
  ...(await original<typeof import('@/lib/derivedApi')>()),
  ensureDerived: (id: string) => ensureDerived(id),
}))

let imageSeq = 0
const imageFiles = new Map<string, File>()
vi.mock('@/lib/imageAssets', () => ({
  getImageAsset: (id: string) =>
    imageFiles.has(id) ? { id, file: imageFiles.get(id) } : undefined,
  hasImageAsset: (id: string) => imageFiles.has(id),
  addImageAsset: async (file: File) => {
    if (file.name === 'kaputt.png') throw new Error('decode')
    const id = `img${++imageSeq}`
    imageFiles.set(id, file)
    return { id, name: file.name, file }
  },
}))

const {
  useTimelineProjectStore,
  TIMELINE_PROJECT_EMPTY,
  TIMELINE_PROJECT_INVALID,
  TIMELINE_PROJECT_MEDIA_GONE,
  TIMELINE_PROJECT_UPLOADS_PENDING,
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
  setActivePinia(createPinia())
  vi.clearAllMocks()
  imageFiles.clear()
  listProjects.mockResolvedValue([])
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

describe('timelineProjects-Store', () => {
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

    // Stand der bisherigen App bzw. kaputtes Dokument: nichts ändert sich.
    fetchProject.mockResolvedValueOnce({ project: summary(), state: { version: 1, items: [] } })
    await expect(store.open('p1')).rejects.toThrow(TIMELINE_PROJECT_INVALID)
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

  it('listet nur Timeline-Projekte und löscht', async () => {
    const store = useTimelineProjectStore()
    listProjects.mockResolvedValue([
      summary({ id: 'a' }),
      summary({ id: 'b', kind: 'classic' }),
      summary({ id: 'c' }),
    ])
    await store.refresh()
    expect(store.projects.map((p) => p.id)).toEqual(['a', 'c'])
    await store.remove('a')
    expect(deleteProject).toHaveBeenCalledWith('a')
    expect(store.projects.map((p) => p.id)).toEqual(['c'])
  })
})
