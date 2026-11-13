import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import type { MediaView } from '@/lib/mediaApi'

// Server-Zugriffe mocken.
const uploads: { file: File; resolve: (m: MediaView) => void }[] = []
const deleteMedia = vi.fn((_id: string) => Promise.resolve())
const fetchMediaInfo = vi.fn((_id: string) => Promise.resolve({} as MediaView))

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
  fetchMediaInfo: (id: string) => fetchMediaInfo(id),
}))

const { useHistoryStore, HISTORY_DEBOUNCE_MS, MAX_VERSION_STEPS } = await import('@/stores/history')
const { useVideoEditorStore } = await import('@/stores/videoEditor')
const { useLibraryStore } = await import('@/stores/library')
const { useTextOverlayStore } = await import('@/stores/textOverlays')
const { useGraphicOverlayStore } = await import('@/stores/graphicOverlays')
const { useAudioFadeStore } = await import('@/stores/audioFade')
const { useAnimationPref } = await import('@/composables/useAnimationPref')
const { registerImageAssetForTest, hasImageAsset } = await import('@/lib/imageAssets')

const vid = (name: string) => new File([new Uint8Array([0])], name, { type: 'video/mp4' })
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
const tick = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  setActivePinia(createPinia())
  uploads.length = 0
  deleteMedia.mockClear()
  fetchMediaInfo.mockReset()
  fetchMediaInfo.mockImplementation(() => Promise.resolve({} as MediaView))
  localStorage.clear()
  vi.stubGlobal('URL', { ...URL, createObjectURL: () => 'blob:mock', revokeObjectURL: () => {} })
})
afterEach(() => {
  vi.useRealTimers()
})

/**
 * Baut den Editor wie VideoTrimmer auf: Bibliothek + markiertes Video im
 * Editor geladen (setFile/setDuration), Verlauf aktiv.
 */
async function setup() {
  const lib = useLibraryStore()
  const editor = useVideoEditorStore()
  const texts = useTextOverlayStore()
  const graphics = useGraphicOverlayStore()
  const history = useHistoryStore()
  const [a] = lib.addFiles([vid('a.mp4')])
  await tick()
  uploads[0].resolve(media())
  await tick()
  /** Was VideoTrimmer bei einem Dateiwechsel des markierten Videos tut. */
  const load = (duration = 30) => {
    const it = lib.selected
    if (!it) return
    texts.setItem(it.id)
    graphics.setItem(it.id)
    if (it.file !== editor.file) editor.setFile(it.file)
    editor.setDuration(duration)
  }
  load()
  return { lib, editor, texts, graphics, history, a, load }
}

describe('history store – Editor-Bearbeitungen', () => {
  it('Auswahl Von/Bis: rückgängig und wiederholen', async () => {
    const { editor, history } = await setup()
    expect(history.canUndo).toBe(false)
    editor.setStart(5)
    editor.setEnd(20)
    history.flush()
    expect(history.canUndo).toBe(true)
    history.undo()
    expect([editor.startTime, editor.endTime]).toEqual([0, 30])
    expect(history.canRedo).toBe(true)
    history.redo()
    expect([editor.startTime, editor.endTime]).toEqual([5, 20])
  })

  it('Laden eines Videos ist kein Schritt', async () => {
    const { history } = await setup()
    history.flush()
    expect(history.canUndo).toBe(false)
  })

  it('fasst eine Änderungsserie per Verzögerung zu einem Schritt zusammen', async () => {
    const { editor, history } = await setup()
    vi.useFakeTimers()
    editor.setStart(1)
    vi.advanceTimersByTime(100)
    editor.setStart(2)
    vi.advanceTimersByTime(100)
    editor.setStart(3)
    vi.advanceTimersByTime(HISTORY_DEBOUNCE_MS + 10)
    expect(history.canUndo).toBe(true)
    history.undo()
    expect(editor.startTime).toBe(0)
    expect(history.canUndo).toBe(false)
  })

  it('eine Geste (Ziehen/Gedrückthalten) ist ein Schritt, auch mit Pausen', async () => {
    const { editor, history } = await setup()
    vi.useFakeTimers()
    history.beginGesture()
    editor.setStart(1)
    vi.advanceTimersByTime(HISTORY_DEBOUNCE_MS * 3)
    editor.setStart(2)
    vi.advanceTimersByTime(HISTORY_DEBOUNCE_MS * 3)
    expect(history.canUndo).toBe(false) // noch nicht festgeschrieben
    history.endGesture()
    vi.advanceTimersByTime(HISTORY_DEBOUNCE_MS + 10)
    history.undo()
    expect(editor.startTime).toBe(0)
    expect(history.canUndo).toBe(false)
  })

  it('Ausschnitte, Modus, Aktion und Zuschneiden', async () => {
    const { editor, history } = await setup()
    editor.setStart(2)
    editor.setEnd(8)
    editor.addSegment()
    history.flush()
    editor.setOperation('remove')
    history.flush()
    editor.enableCrop()
    history.flush()
    history.undo()
    expect(editor.crop).toBeNull()
    history.undo()
    expect(editor.operation).toBe('keep')
    history.undo()
    expect(editor.segments).toHaveLength(0)
  })

  it('eine neue Änderung verwirft den Wiederholen-Zweig', async () => {
    const { editor, history } = await setup()
    editor.setStart(5)
    history.flush()
    history.undo()
    expect(history.canRedo).toBe(true)
    editor.setStart(9)
    history.flush()
    expect(history.canRedo).toBe(false)
  })

  it('Texte: hinzufügen, ändern, löschen schrittweise rückgängig', async () => {
    const { texts, history } = await setup()
    const o = texts.add(1, 30, 'Hallo')!
    history.flush()
    texts.update(o.id, { text: 'Hallo Welt', size: 0.2 })
    history.flush()
    texts.remove(o.id)
    history.flush()
    expect(texts.overlays).toHaveLength(0)
    history.undo()
    expect(texts.overlays[0].text).toBe('Hallo Welt')
    history.undo()
    expect(texts.overlays[0].text).toBe('Hallo')
    history.undo()
    expect(texts.overlays).toHaveLength(0)
    history.redo()
    history.redo()
    expect(texts.overlays[0]).toMatchObject({ text: 'Hallo Welt', size: 0.2 })
  })

  it('Rückgängig ändert nur den betroffenen Bereich', async () => {
    const { editor, texts, history } = await setup()
    texts.add(1, 30, 'A')
    history.flush()
    editor.setStart(7)
    history.flush()
    history.undo() // nur die Auswahl
    expect(editor.startTime).toBe(0)
    expect(texts.overlays).toHaveLength(1)
  })

  it('Bild-Grafik: gelöschtes Bild bleibt für Rückgängig erhalten', async () => {
    const { graphics, history } = await setup()
    registerImageAssetForTest({
      id: 'imgT',
      name: 'x.png',
      source: {} as never,
      width: 10,
      height: 10,
    })
    const g = graphics.add('image', 0, 30, { image: 'imgT' })!
    history.flush()
    graphics.remove(g.id)
    history.flush()
    expect(hasImageAsset('imgT')).toBe(true)
    history.undo()
    expect(graphics.overlays[0]).toMatchObject({ kind: 'image', image: 'imgT' })
  })

  it('Ton-Blende, Ausgabeformat, Übergang', async () => {
    const { editor, history } = await setup()
    const fade = useAudioFadeStore()
    const anim = useAnimationPref()
    const before = fade.settings.fadeIn.enabled
    fade.update('fadeIn', { enabled: !before })
    history.flush()
    editor.setOutputAspect('9:16')
    history.flush()
    const prevAnim = anim.animation.value
    anim.animation.value = prevAnim === 'flip' ? 'none' : 'flip'
    history.flush()
    history.undo()
    expect(anim.animation.value).toBe(prevAnim)
    history.undo()
    expect(editor.outputAspect).toBe('auto')
    history.undo()
    expect(fade.settings.fadeIn.enabled).toBe(before)
  })

  it('Zusammenfügen-Einstellungen; Upload-Fortschritt ist kein Schritt', async () => {
    const { lib, history, a } = await setup()
    const [b] = lib.addFiles([vid('b.mp4')])
    await tick()
    history.flush()
    expect(history.canUndo).toBe(false) // neues Video = keine Bearbeitung
    uploads[1].resolve(media())
    await tick()
    history.flush()
    expect(history.canUndo).toBe(false)
    lib.setInclude(b.id, false)
    history.flush()
    lib.moveBy(b.id, -1)
    history.flush()
    expect(lib.items.map((i) => i.id)).toEqual([b.id, a.id])
    history.undo()
    expect(lib.items.map((i) => i.id)).toEqual([a.id, b.id])
    history.undo()
    expect(lib.items.find((i) => i.id === b.id)?.include).toBe(true)
  })

  it('je Video ein eigener Verlauf', async () => {
    const { lib, editor, history, a, load } = await setup()
    editor.setStart(5)
    history.flush()
    const [b] = lib.addFiles([vid('b.mp4')])
    await tick()
    uploads[1].resolve(media())
    await tick()
    lib.select(b.id)
    load(20)
    expect(history.canUndo).toBe(false)
    lib.select(a.id)
    load(30)
    expect(history.canUndo).toBe(true)
    history.undo()
    expect(editor.startTime).toBe(0)
  })
})

describe('history store – Schneiden/Einbrennen rückgängig', () => {
  it('stellt die vorherige Fassung, Texte und Auswahl wieder her', async () => {
    const { lib, editor, texts, history, a, load } = await setup()
    const oldFile = lib.selected!.file
    const oldMedia = lib.selected!.mediaId!
    texts.add(1, 30, 'Untertitel')
    history.flush()
    editor.setStart(3)
    editor.setEnd(12)
    history.flush()

    // Einbrennen: neue Fassung ersetzt das Video, Texte sind Teil des Bildes.
    const res = media({ duration: 30 })
    lib.replaceWithResult(a.id, res, vid('a_text.mp4'), { keepOld: true })
    texts.clearItem(a.id)
    load(30)
    history.flush()
    expect(deleteMedia).not.toHaveBeenCalled() // alte Fassung bleibt erhalten
    expect(texts.overlays).toHaveLength(0)

    history.undo()
    expect(lib.selected!.file).toBe(oldFile)
    expect(lib.selected!.mediaId).toBe(oldMedia)
    expect(texts.overlays[0].text).toBe('Untertitel')
    load(30) // Editor lädt die alte Datei neu
    expect([editor.startTime, editor.endTime]).toEqual([3, 12])
    expect(fetchMediaInfo).toHaveBeenCalledWith(oldMedia)
    history.flush()
    expect(history.canRedo).toBe(true) // Laden ist kein neuer Schritt

    history.redo()
    expect(lib.selected!.mediaId).toBe(res.id)
    expect(texts.overlays).toHaveLength(0)
  })

  it('fehlt die alte Fassung auf dem Server, wird sie neu hochgeladen', async () => {
    const { lib, history, a, load } = await setup()
    lib.replaceWithResult(a.id, media(), vid('a_cut.mp4'), { keepOld: true })
    load(10)
    history.flush()
    fetchMediaInfo.mockImplementation(() => Promise.reject(new Error('weg')))
    history.undo()
    await tick()
    await tick()
    expect(lib.selected!.status).toBe('uploading')
    expect(uploads.at(-1)?.file.name).toBe('a.mp4')
    history.flush()
    expect(history.canRedo).toBe(true) // Neu-Upload ist kein Schritt
  })

  it('verworfene Fassungen werden vom Server gelöscht', async () => {
    const { lib, editor, history, a, load } = await setup()
    const first = lib.selected!.mediaId!
    lib.replaceWithResult(a.id, media(), vid('a_cut.mp4'), { keepOld: true })
    load(10)
    history.flush()
    const cut = lib.selected!.mediaId!
    history.undo()
    load(30)
    // Neue Bearbeitung verwirft den Wiederholen-Zweig mit dem Schnitt.
    editor.setStart(4)
    history.flush()
    expect(deleteMedia).toHaveBeenCalledWith(cut)
    expect(deleteMedia).not.toHaveBeenCalledWith(first)
  })

  it(`behält höchstens ${MAX_VERSION_STEPS} Fassungen`, async () => {
    const { lib, history, a, load } = await setup()
    const ids: string[] = [lib.selected!.mediaId!]
    for (let i = 0; i <= MAX_VERSION_STEPS; i++) {
      lib.replaceWithResult(a.id, media(), vid(`a_${i}.mp4`), { keepOld: true })
      load(10 + i)
      history.flush()
      ids.push(lib.selected!.mediaId!)
    }
    expect(deleteMedia).toHaveBeenCalledWith(ids[0])
    expect(deleteMedia).toHaveBeenCalledTimes(1)
  })

  it('Löschen eines Videos gibt seine behaltenen Fassungen frei', async () => {
    const { lib, history, a, load } = await setup()
    const first = lib.selected!.mediaId!
    lib.replaceWithResult(a.id, media(), vid('a_cut.mp4'), { keepOld: true })
    load(10)
    history.flush()
    await lib.remove(a.id)
    expect(deleteMedia).toHaveBeenCalledWith(first)
    expect(history.canUndo).toBe(false)
  })
})
