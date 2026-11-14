import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import type { MediaView } from '@/lib/mediaApi'

// Server-Zugriffe mocken: Uploads bleiben offen, bis der Test sie auflöst.
type Pending = {
  file: File
  resolve: (m: MediaView) => void
  reject: (e: Error) => void
  abort: ReturnType<typeof vi.fn>
}
const pending: Pending[] = []
const deleteMedia = vi.fn((_id: string) => Promise.resolve())

vi.mock('@/lib/mediaApi', () => ({
  UPLOAD_ABORTED: 'UPLOAD_ABORTED',
  MEDIA_UNSUPPORTED: 'MEDIA_UNSUPPORTED',
  uploadMedia: (file: File, onProgress?: (r: number) => void) => {
    let resolve!: (m: MediaView) => void
    let reject!: (e: Error) => void
    const promise = new Promise<MediaView>((res, rej) => {
      resolve = res
      reject = rej
    })
    const abort = vi.fn(() => reject(new Error('UPLOAD_ABORTED')))
    pending.push({ file, resolve, reject, abort })
    onProgress?.(0.5)
    return { promise, abort }
  },
  deleteMedia: (id: string) => deleteMedia(id),
}))

const { useLibraryStore, seamKey, itemLength, isItemTrimmed, MAX_MERGE_ITEMS } =
  await import('@/stores/library')

const vid = (name: string) => new File([new Uint8Array([0])], name, { type: 'video/mp4' })
let idN = 0
const media = (over: Partial<MediaView> = {}): MediaView => ({
  id: `00000000-0000-4000-8000-${String(++idN).padStart(12, '0')}`,
  name: 'x.mp4',
  size: 100,
  duration: 10,
  width: 640,
  height: 360,
  hasAudio: true,
  fps: 25,
  ...over,
})
/** Lässt die Upload-Warteschlange einen Schritt laufen. */
const flush = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  setActivePinia(createPinia())
  pending.length = 0
  deleteMedia.mockClear()
})

describe('library store – Upload und Auswahl', () => {
  it('lädt nacheinander hoch, markiert das erste Video, übernimmt die Server-Daten', async () => {
    const lib = useLibraryStore()
    const [a, b] = lib.addFiles([vid('a.mp4'), vid('b.mp4')])
    expect(lib.selectedId).toBe(a.id)
    expect(lib.items.map((i) => i.status)).toEqual(['uploading', 'uploading'])
    expect(lib.isUploading).toBe(true)

    await flush()
    // Nur EIN Upload gleichzeitig.
    expect(pending).toHaveLength(1)
    expect(lib.items[0].progress).toBe(0.5)
    const ma = media({ duration: 12 })
    pending[0].resolve(ma)
    await flush()
    expect(lib.items[0]).toMatchObject({ status: 'ready', mediaId: ma.id, duration: 12 })
    expect(pending).toHaveLength(2)
    pending[1].reject(new Error('Speicher voll'))
    await flush()
    expect(lib.items[1]).toMatchObject({ id: b.id, status: 'error', error: 'Speicher voll' })
    expect(lib.isUploading).toBe(false)

    // Erneut hochladen.
    lib.retry(b.id)
    await flush()
    pending[2].resolve(media())
    await flush()
    expect(lib.items[1].status).toBe('ready')

    // Weitere Videos ändern die Markierung nicht.
    lib.addFiles([vid('c.mp4')])
    expect(lib.selectedId).toBe(a.id)
    lib.select(b.id)
    expect(lib.selected?.name).toBe('b.mp4')
  })

  it('Löschen: vom Server entfernen, Markierung wandert zum Nachbarn', async () => {
    const lib = useLibraryStore()
    const [a, b, c] = lib.addFiles([vid('a.mp4'), vid('b.mp4'), vid('c.mp4')])
    for (let i = 0; i < 3; i++) {
      await flush()
      pending[i].resolve(media())
    }
    await flush()
    const bMedia = lib.items[1].mediaId
    lib.select(b.id)
    await lib.remove(b.id)
    expect(deleteMedia).toHaveBeenCalledWith(bMedia)
    expect(lib.items.map((i) => i.id)).toEqual([a.id, c.id])
    expect(lib.selectedId).toBe(c.id) // Nachfolger
    await lib.remove(c.id)
    expect(lib.selectedId).toBe(a.id) // Vorgänger
    await lib.remove(a.id)
    expect(lib.selectedId).toBeNull()
    expect(lib.selected).toBeNull()
  })

  it('Löschen während des Uploads bricht ab; fertiger Upload danach wird serverseitig gelöscht', async () => {
    const lib = useLibraryStore()
    const [a, b] = lib.addFiles([vid('a.mp4'), vid('b.mp4')])
    await flush()
    await lib.remove(a.id)
    expect(pending[0].abort).toHaveBeenCalled()
    expect(deleteMedia).not.toHaveBeenCalled() // noch keine Server-ID
    await flush()
    // b lädt; wird gelöscht, kurz bevor der Server antwortet (Rennen).
    const p = pending[1]
    await lib.remove(b.id)
    p.resolve(media({ id: '00000000-0000-4000-8000-0000000000ff' }))
    await flush()
    expect(lib.items).toEqual([])
  })

  it('Fehler beim Löschen auf dem Server wird gemeldet (Eintrag ist trotzdem weg)', async () => {
    const lib = useLibraryStore()
    lib.addFiles([vid('a.mp4')])
    await flush()
    pending[0].resolve(media())
    await flush()
    deleteMedia.mockRejectedValueOnce(new Error('offline'))
    await expect(lib.remove(lib.items[0].id)).rejects.toThrow('offline')
    expect(lib.items).toEqual([])
  })
})

describe('library store – Ergebnisse', () => {
  it('replaceWithResult ersetzt Datei/ID, setzt Von/Bis zurück, löscht das alte Server-Video', async () => {
    const lib = useLibraryStore()
    const [a] = lib.addFiles([vid('a.mp4')])
    await flush()
    pending[0].resolve(media())
    await flush()
    const old = lib.items[0].mediaId
    lib.setStart(a.id, 2)
    const cutFile = vid('a_cut.mp4')
    const m = media({ duration: 4, name: 'a_cut.mp4' })
    lib.replaceWithResult(a.id, m, cutFile)
    expect(lib.items[0]).toMatchObject({
      id: a.id,
      mediaId: m.id,
      file: cutFile,
      name: 'a_cut.mp4',
      duration: 4,
      start: 0,
      end: null,
    })
    expect(deleteMedia).toHaveBeenCalledWith(old)
  })

  it('addResult hängt an, markiert und ist nicht fürs Zusammenfügen vorgemerkt', () => {
    const lib = useLibraryStore()
    lib.addFiles([vid('a.mp4')])
    const r = lib.addResult(media(), vid('a_merged.mp4'))
    expect(lib.items.at(-1)?.id).toBe(r.id)
    expect(lib.selectedId).toBe(r.id)
    expect(r).toMatchObject({ status: 'ready', include: false })
  })

  it('insertResult fügt an Position ein, merkt vor und markiert', () => {
    const lib = useLibraryStore()
    lib.addFiles([vid('a.mp4'), vid('b.mp4')])
    const r = lib.insertResult(media(), vid('Bild-Clip_5s.mp4'), 1)
    expect(lib.items.map((it) => it.id)).toEqual([lib.items[0].id, r.id, lib.items[2].id])
    expect(lib.items[2].name).toBe('b.mp4')
    expect(lib.selectedId).toBe(r.id)
    expect(r).toMatchObject({ status: 'ready', include: true })
    const front = lib.insertResult(media(), vid('x.mp4'), 0)
    expect(lib.items[0].id).toBe(front.id)
    const end = lib.insertResult(media(), vid('y.mp4'), 99)
    expect(lib.items.at(-1)?.id).toBe(end.id)
  })
})

describe('library store – Zusammenfügen', () => {
  async function readyLib(n: number) {
    const lib = useLibraryStore()
    lib.addFiles(Array.from({ length: n }, (_, i) => vid(`${i}.mp4`)))
    for (let i = 0; i < n; i++) {
      await flush()
      pending[i].resolve(media())
    }
    await flush()
    return lib
  }

  it('canMerge: 2 bis MAX_MERGE_ITEMS vorgemerkte, fertige Videos', async () => {
    const lib = await readyLib(MAX_MERGE_ITEMS + 1)
    expect(lib.canMerge).toBe(false) // zu viele
    lib.setInclude(lib.items[0].id, false)
    expect(lib.canMerge).toBe(true)
    for (const it of lib.items.slice(1, -1)) lib.setInclude(it.id, false)
    expect(lib.mergeItems).toHaveLength(1)
    expect(lib.canMerge).toBe(false) // zu wenige
  })

  it('canMerge wartet auf laufende Uploads', () => {
    const lib = useLibraryStore()
    lib.addFiles([vid('a.mp4'), vid('b.mp4')])
    expect(lib.canMerge).toBe(false)
  })

  it('Von/Bis: begrenzt auf die Dauer, Ende = Dateiende -> ungekürzt', async () => {
    const lib = await readyLib(1)
    const id = lib.items[0].id
    lib.setStart(id, 3)
    lib.setEnd(id, 7)
    expect(itemLength(lib.items[0])).toBe(4)
    expect(isItemTrimmed(lib.items[0])).toBe(true)
    lib.setEnd(id, 99)
    expect(lib.items[0].end).toBeNull()
    lib.setStart(id, 50)
    expect(lib.items[0].start).toBeCloseTo(9.95)
    lib.resetRange(id)
    expect(isItemTrimmed(lib.items[0])).toBe(false)
  })

  it('Von im Gesamtvideo: Zeitleiste mit Standbild in der Lücke, ↺ hebt alles auf', async () => {
    const lib = await readyLib(2) // je 10 s
    const [a, b] = lib.items
    expect(lib.timeline?.total).toBe(20)
    lib.setAt(b.id, 12)
    expect(lib.items[1].at).toBe(12)
    expect(lib.timelineById.get(a.id)).toMatchObject({ used: 10, hold: 2 })
    expect(lib.timeline?.total).toBe(22)
    // Rückgängig/Projekte: in den Zusammenfügen-Einstellungen enthalten
    const st = lib.mergeState()
    expect(st.ranges[b.id].at).toBe(12)
    lib.resetRange(b.id)
    expect(lib.items[1].at).toBeNull()
    lib.applyMergeState(st)
    expect(lib.items[1].at).toBe(12)
    lib.setAt(b.id, Number.NaN)
    expect(lib.items[1].at).toBeNull()
  })

  it('Reihenfolge: move/moveBy (Drag & Drop, ↑↓)', async () => {
    const lib = await readyLib(3)
    const [a, b, c] = lib.items.map((i) => i.id)
    lib.move(a, 2)
    expect(lib.items.map((i) => i.id)).toEqual([b, c, a])
    lib.moveBy(a, -1)
    expect(lib.items.map((i) => i.id)).toEqual([b, a, c])
    lib.moveBy(b, -1) // schon oben -> nichts
    expect(lib.items.map((i) => i.id)).toEqual([b, a, c])
  })

  it('Übergang je Nahtstelle: nur zwischen vorgemerkten Nachbarn, Umsortieren -> Standard', async () => {
    const lib = await readyLib(3)
    const [a, b, c] = lib.items
    expect(lib.seamPresets).toEqual([null, null])
    lib.setSeamTransition(seamKey(b, c), 'slide')
    expect(lib.seamPresets).toEqual([null, 'slide'])
    // b nicht verwenden -> Nahtstelle a>c (Standard).
    lib.setInclude(b.id, false)
    expect(lib.seamPresets).toEqual([null])
    lib.setInclude(b.id, true)
    expect(lib.seamPresets).toEqual([null, 'slide'])
    // c und b tauschen -> neue Paare.
    lib.moveBy(c.id, -1)
    expect(lib.seamPresets).toEqual([null, null])
    lib.setSeamTransition(seamKey(a, c), null)
    expect(lib.seamTransitions).toEqual({ [seamKey(b, c)]: 'slide' })
  })
})
