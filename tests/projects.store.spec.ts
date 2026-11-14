import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import type { MediaView } from '@/lib/mediaApi'
import type { SaveRequest } from '@/lib/projectApi'

// --- Server mocken -----------------------------------------------------------
const uploads: { file: File; resolve: (m: MediaView) => void }[] = []
const deleteMedia = vi.fn((_id: string) => Promise.resolve())

vi.mock('@/lib/mediaApi', () => ({
  UPLOAD_ABORTED: 'UPLOAD_ABORTED',
  MEDIA_UNSUPPORTED: 'MEDIA_UNSUPPORTED',
  uploadMedia: (file: File) => {
    let resolve!: (m: MediaView) => void
    const promise = new Promise<MediaView>((res) => (resolve = res))
    uploads.push({ file, resolve })
    return { promise, abort: vi.fn() }
  },
  deleteMedia: (id: string) => deleteMedia(id),
  fetchMediaInfo: () => Promise.resolve({}),
  fetchMediaFile: (id: string) => Promise.resolve(new Blob([`video:${id}`], { type: 'video/mp4' })),
}))

class MissingMediaError extends Error {
  constructor(public readonly missing: string[]) {
    super('missing')
  }
}
const saved: SaveRequest[] = []
const saveProject = vi.fn()
const uploadAsset = vi.fn((_id: string, _hash: string, _f: Blob) => Promise.resolve())
const fetchProject = vi.fn()
const openProjectMedia = vi.fn()
const fetchAsset = vi.fn((_id: string, hash: string) =>
  Promise.resolve(new Blob([`asset:${hash}`], { type: 'image/png' })),
)

vi.mock('@/lib/projectApi', () => ({
  PROJECTS_UNSUPPORTED: 'PROJECTS_UNSUPPORTED',
  MissingMediaError,
  listProjects: () => Promise.resolve([]),
  saveProject: (r: SaveRequest) => saveProject(r),
  uploadAsset: (id: string, h: string, f: Blob) => uploadAsset(id, h, f),
  fetchProject: (id: string) => fetchProject(id),
  openProjectMedia: (id: string) => openProjectMedia(id),
  fetchAsset: (id: string, h: string) => fetchAsset(id, h),
  deleteProject: () => Promise.resolve(),
  // Kennung = Dateiname (eindeutig genug für den Test), 64 Hex-Zeichen.
  sha256Hex: async (b: Blob) =>
    Array.from((b as File).name ?? 'x')
      .map((c) => c.charCodeAt(0).toString(16))
      .join('')
      .padEnd(64, '0')
      .slice(0, 64),
}))

let imgN = 0
vi.mock('@/lib/imageAssets', async (orig) => {
  const real = await orig<typeof import('@/lib/imageAssets')>()
  return {
    ...real,
    addImageAsset: async (file: File) => {
      const a = {
        id: `loaded${++imgN}`,
        name: file.name,
        source: {} as never,
        width: 10,
        height: 10,
        file,
      }
      real.registerImageAssetForTest(a)
      return a
    },
  }
})

const { useProjectStore, PROJECT_UPLOADS_PENDING } = await import('@/stores/projects')
const { useLibraryStore } = await import('@/stores/library')
const { useVideoEditorStore } = await import('@/stores/videoEditor')
const { useTextOverlayStore } = await import('@/stores/textOverlays')
const { useGraphicOverlayStore } = await import('@/stores/graphicOverlays')
const { useHistoryStore } = await import('@/stores/history')
const { registerImageAssetForTest, getImageAsset } = await import('@/lib/imageAssets')
const { defaultGraphic } = await import('@/lib/graphicOverlay')
const { parseProjectState } = await import('@/lib/projectState')

let idN = 0
const media = (over: Partial<MediaView> = {}): MediaView => ({
  id: `00000000-0000-4000-8000-${String(++idN).padStart(12, '0')}`,
  name: 'x.mp4',
  size: 100,
  duration: 30,
  width: 640,
  height: 360,
  hasAudio: true,
  fps: 25,
  ...over,
})
const vid = (name: string) => new File([new Uint8Array([0])], name, { type: 'video/mp4' })
const tick = () => new Promise((r) => setTimeout(r, 0))

/** Zwei fertig hochgeladene Videos in der Bibliothek. */
async function twoVideos() {
  const library = useLibraryStore()
  library.addFiles([vid('a.mp4'), vid('b.mp4')])
  const ms = [media({ name: 'a.mp4' }), media({ name: 'b.mp4' })]
  for (let i = 0; i < 2; i++) {
    await tick()
    uploads[i].resolve(ms[i])
  }
  await tick()
  return { library, ms }
}

beforeEach(() => {
  setActivePinia(createPinia())
  uploads.length = 0
  saved.length = 0
  deleteMedia.mockClear()
  uploadAsset.mockClear()
  saveProject.mockReset()
  saveProject.mockImplementation(async (r: SaveRequest) => {
    saved.push(JSON.parse(JSON.stringify(r)))
    return {
      project: { id: 'p1', name: r.name, createdAt: 1, updatedAt: 2, videoCount: 2, size: 1 },
      missingAssets: r.assets.map((a) => a.hash),
    }
  })
  localStorage.clear()
  vi.stubGlobal('URL', { ...URL, createObjectURL: () => 'blob:mock', revokeObjectURL: () => {} })
})

describe('Projekt speichern', () => {
  it('verlangt fertige Uploads', async () => {
    const library = useLibraryStore()
    library.addFiles([vid('a.mp4')])
    await expect(useProjectStore().save('P')).rejects.toThrow(PROJECT_UPLOADS_PENDING)
  })

  it('speichert Videos, Bereiche, Texte, Bilder, Musik und Übergänge', async () => {
    const { library, ms } = await twoVideos()
    const editor = useVideoEditorStore()
    const texts = useTextOverlayStore()
    const graphics = useGraphicOverlayStore()
    const [a, b] = library.items
    library.setStart(b.id, 2)
    library.setSeamTransition(`${a.id}>${b.id}`, 'slide')
    texts.setItem(a.id)
    texts.add(1, 30, 'Hallo')
    registerImageAssetForTest({
      id: 'imgA',
      name: 'foto.png',
      source: {} as never,
      width: 10,
      height: 10,
      file: new File(['png'], 'foto.png', { type: 'image/png' }),
    })
    graphics.setItem(b.id)
    graphics.add('image', 0, 30, { image: 'imgA' })
    editor.setMusicFile(new File(['mp3'], 'musik.mp3', { type: 'audio/mpeg' }))
    editor.setOutputAspect('9:16')

    const store = useProjectStore()
    const p = await store.save('Mein Projekt')
    expect(p.id).toBe('p1')
    expect(store.current?.id).toBe('p1')
    const req = saved[0]
    expect(req.id).toBeUndefined()
    expect(req.media).toEqual([ms[0].id, ms[1].id])
    const st = parseProjectState(req.state)
    expect(st.items.map((i) => [i.media, i.start])).toEqual([
      [ms[0].id, 0],
      [ms[1].id, 2],
    ])
    expect(st.items[0].texts.map((t) => t.text)).toEqual(['Hallo'])
    expect(st.items[1].graphics[0].image).toBe('imgA')
    expect(st.images.imgA.name).toBe('foto.png')
    expect(st.music?.name).toBe('musik.mp3')
    expect(st.seams).toEqual([{ from: 0, to: 1, preset: 'slide' }])
    expect(st.output.aspect).toBe('9:16')
    // Fehlende Zusatzdateien hochgeladen (Bild + Musik).
    expect(uploadAsset).toHaveBeenCalledTimes(2)

    // Erneut speichern überschreibt das aktuelle Projekt, „als neu“ nicht.
    await store.save('Mein Projekt')
    expect(saved[1].id).toBe('p1')
    await store.save('Kopie', true)
    expect(saved[2].id).toBeUndefined()
  })

  it('lädt verschwundene Videos neu hoch und versucht es noch einmal', async () => {
    const { library, ms } = await twoVideos()
    saveProject.mockImplementationOnce(async () => {
      throw new MissingMediaError([ms[1].id])
    })
    const store = useProjectStore()
    const pending = store.save('P')
    await tick()
    await tick()
    expect(uploads).toHaveLength(3) // b erneut hochgeladen
    const fresh = media({ name: 'b.mp4' })
    uploads[2].resolve(fresh)
    await pending
    expect(saved[0].media).toEqual([ms[0].id, fresh.id])
    expect(library.items[1].mediaId).toBe(fresh.id)
  })
})

describe('Projekt öffnen', () => {
  it('ersetzt die Bearbeitung und stellt alles wieder her', async () => {
    const { library, ms } = await twoVideos()
    const texts = useTextOverlayStore()
    const graphics = useGraphicOverlayStore()
    const editor = useVideoEditorStore()
    const history = useHistoryStore()
    texts.setItem(library.items[0].id)
    texts.add(0, 30, 'alt')
    const oldIds = library.items.map((it) => it.id)

    const img = 'b'.repeat(64)
    const mus = 'c'.repeat(64)
    const state = {
      version: 1,
      items: [
        {
          media: 'tok-1',
          name: 'eins.mp4',
          start: 1,
          end: 5,
          include: true,
          texts: [{ id: 7, text: 'Neu', start: 0, end: 2, x: 0.5, y: 0.5 }],
          graphics: [
            {
              ...defaultGraphic('image'),
              id: 3,
              image: 'imgOld',
              start: 0,
              end: 2,
              x: 0.5,
              y: 0.5,
            },
          ],
        },
        {
          media: 'tok-gone',
          name: 'weg.mp4',
          start: 0,
          end: null,
          include: true,
          texts: [],
          graphics: [],
        },
        {
          media: 'tok-2',
          name: 'zwei.mp4',
          start: 0,
          end: null,
          include: false,
          texts: [],
          graphics: [],
        },
      ],
      selected: 2,
      seams: [{ from: 0, to: 2, preset: 'flip' }],
      normalizeAudio: true,
      editor: {
        startTime: 3,
        endTime: 4,
        mode: 'reencode',
        operation: 'remove',
        segments: [],
        crop: null,
      },
      output: { aspect: '1:1', fill: 'blur' },
      music: {
        asset: mus,
        name: 'm.mp3',
        type: 'audio/mpeg',
        volume: 0.5,
        originalVolume: 0.8,
        fade: false,
        loop: true,
      },
      audioFade: { fadeIn: { enabled: true, duration: 3, curve: 'tri' } },
      anim: { animation: 'scale', duration: 4 },
      images: { imgOld: { asset: img, name: 'foto.png', type: 'image/png' } },
    }
    fetchProject.mockResolvedValue({
      project: {
        id: 'p9',
        name: 'Gespeichert',
        createdAt: 1,
        updatedAt: 5,
        videoCount: 3,
        size: 1,
      },
      state,
    })
    // tok-1 = gerade noch angemeldetes Video a (wiederverwendet), tok-2 neu.
    const neu = media({ name: 'zwei.mp4', duration: 20 })
    openProjectMedia.mockResolvedValue({ 'tok-1': ms[0], 'tok-2': neu })

    const r = await useProjectStore().open('p9')
    expect(r.missing).toBe(1)
    expect(library.items.map((it) => [it.name, it.mediaId, it.start, it.end, it.include])).toEqual([
      ['eins.mp4', ms[0].id, 1, 5, true],
      ['zwei.mp4', neu.id, 0, null, false],
    ])
    const [x, y] = library.items
    expect(oldIds).not.toContain(x.id)
    expect(library.selectedId).toBe(y.id)
    expect(library.seamTransitions).toEqual({ [`${x.id}>${y.id}`]: 'flip' })
    expect(library.normalizeAudio).toBe(true)
    // Altes b gelöscht, a (wiederverwendet) nicht.
    expect(deleteMedia).toHaveBeenCalledWith(ms[1].id)
    expect(deleteMedia).not.toHaveBeenCalledWith(ms[0].id)
    // Texte/Grafiken neu zugeordnet, Bild neu registriert.
    expect(texts.listFor(x.id).map((t) => t.text)).toEqual(['Neu'])
    for (const id of oldIds) expect(texts.listFor(id)).toEqual([])
    const g = graphics.listFor(x.id)[0]
    expect(g.image).not.toBe('imgOld')
    expect(getImageAsset(g.image)?.name).toBe('foto.png')
    expect(editor.music?.file.name).toBe('m.mp3')
    expect(editor.music?.volume).toBe(0.5)
    expect(editor.outputAspect).toBe('1:1')
    expect(editor.outputFill).toBe('blur')
    expect(useProjectStore().current?.name).toBe('Gespeichert')
    expect(history.canUndo).toBe(false)

    // Auswahl wird hergestellt, sobald das markierte Video geladen ist.
    editor.setFile(y.file)
    editor.setDuration(20)
    await tick()
    expect(editor.startTime).toBe(3)
    expect(editor.endTime).toBe(4)
    expect(editor.operation).toBe('remove')
    expect(editor.mode).toBe('reencode')
    await new Promise((res) => setTimeout(res, 500))
    expect(history.canUndo).toBe(false)
  })
})

describe('parseProjectState', () => {
  it('liefert Standardwerte für kaputte Felder', () => {
    const s = parseProjectState({
      items: [
        { media: 'm', texts: [{ nope: 1 }, { text: 'ok', size: 99 }], graphics: [{ kind: 'x' }] },
      ],
      selected: 5,
      seams: [{ from: 0, to: 9, preset: 'fade' }],
      output: { aspect: 'quatsch' },
      music: { asset: 'kein-hash' },
    })
    expect(s.items[0].texts).toHaveLength(1)
    expect(s.items[0].texts[0].size).toBeLessThanOrEqual(0.3)
    expect(s.items[0].graphics).toEqual([])
    expect(s.selected).toBeNull()
    expect(s.seams).toEqual([])
    expect(s.output).toEqual({ aspect: 'auto', fill: 'pad' })
    expect(s.music).toBeNull()
    expect(() => parseProjectState(null)).toThrow()
  })

  it('Von im Gesamtvideo: Zahl ≥ 0 übernommen, sonst direkt nach dem vorigen', () => {
    const s = parseProjectState({
      items: [
        { media: 'a', at: 6 },
        { media: 'b', at: -1 },
        { media: 'c', at: 'x' },
        { media: 'd' },
      ],
    })
    expect(s.items.map((it) => it.at)).toEqual([6, null, null, null])
  })
})
