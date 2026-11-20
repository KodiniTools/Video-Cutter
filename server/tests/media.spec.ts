import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, writeFile, readFile, access, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { MediaStore, StorageFullError, isMediaId, mediaView } from '../src/lib/media'
import { displayName } from '../src/routes/media'

const info = { width: 640, height: 360, hasAudio: true, duration: 10 }
const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  )

describe('MediaStore', () => {
  let dir: string
  let store: MediaStore
  const file = async (name: string, bytes = 10) => {
    const p = path.join(dir, name)
    await writeFile(p, Buffer.alloc(bytes))
    return p
  }

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'media-spec-'))
    store = new MediaStore(1000, 100)
  })
  afterEach(async () => {
    await store.shutdown()
    await rm(dir, { recursive: true, force: true })
  })

  it('nimmt auf, liefert Sicht ohne Pfad, löscht Datei', async () => {
    const p = await file('a.mp4')
    const item = await store.add(p, 'a.mp4', info)
    expect(isMediaId(item.id)).toBe(true)
    expect(mediaView(item)).toEqual({
      id: item.id,
      name: 'a.mp4',
      size: 10,
      duration: 10,
      width: 640,
      height: 360,
      hasAudio: true,
      fps: 0,
      kind: 'video',
    })
    expect(
      mediaView({ ...item, info: { ...info, width: 0, height: 0, hasVideo: false } }),
    ).toMatchObject({
      kind: 'audio',
      width: 0,
    })
    expect(store.get(item.id)?.path).toBe(p)
    expect(await store.remove(item.id)).toBe(true)
    expect(store.get(item.id)).toBeUndefined()
    expect(await exists(p)).toBe(false)
    expect(await store.remove(item.id)).toBe(false)
  })

  it('Speicherlimit: wirft StorageFullError, Datei bleibt dem Aufrufer', async () => {
    await store.add(await file('a.mp4', 60), 'a', info)
    const p = await file('b.mp4', 50)
    await expect(store.add(p, 'b', info)).rejects.toBeInstanceOf(StorageFullError)
    expect(await exists(p)).toBe(true)
    expect(store.count).toBe(1)
  })

  it('in Benutzung: Löschen verzögert bis release, sofort unsichtbar', async () => {
    const p = await file('a.mp4')
    const { id } = await store.add(p, 'a', info)
    store.acquire([id])
    expect(await store.remove(id)).toBe(true)
    expect(store.get(id)).toBeUndefined()
    expect(await exists(p)).toBe(true)
    await store.release([id])
    expect(await exists(p)).toBe(false)
  })

  it('Auto-Aufräumen nach TTL, aber nicht während Benutzung', async () => {
    const a = await store.add(await file('a.mp4'), 'a', info)
    const b = await store.add(await file('b.mp4'), 'b', info)
    store.acquire([b.id])
    await store.sweep(Date.now() + 5000)
    expect(store.get(a.id)).toBeUndefined()
    expect(store.get(b.id)).toBeDefined()
    await store.release([b.id])
  })

  it('isMediaId / displayName', () => {
    expect(isMediaId('../etc/passwd')).toBe(false)
    expect(isMediaId('123')).toBe(false)
    expect(displayName('C:\\Users\\x\\Urlaub "2024".mp4')).toBe('Urlaub 2024.mp4')
    expect(displayName('../../a.mp4')).toBe('a.mp4')
    expect(displayName('')).toBe('video')
  })
})

describe('MediaStore mit Verzeichnis auf der Platte', () => {
  let dir: string
  let indexFile: string
  const stores: MediaStore[] = []
  const open = (ttlMs = 60_000, maxBytes = 1000) => {
    const s = new MediaStore(ttlMs, maxBytes, { indexFile, baseDir: dir })
    stores.push(s)
    return s
  }
  const file = async (name: string, bytes = 10) => {
    const p = path.join(dir, name)
    await writeFile(p, Buffer.alloc(bytes))
    return p
  }

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'media-persist-'))
    indexFile = path.join(dir, 'media-index.json')
  })
  afterEach(async () => {
    for (const s of stores.splice(0)) await s.shutdown()
    await rm(dir, { recursive: true, force: true })
  })

  it('Tondateien bleiben nach einem Neustart Tondateien', async () => {
    const a = open()
    await a.init()
    const p = await file('musik.mp3', 5)
    const item = await a.add(p, 'musik.mp3', { ...info, width: 0, height: 0, hasVideo: false })
    await a.shutdown()
    const b = open()
    expect(await b.init()).toBe(1)
    expect(mediaView(b.get(item.id)!).kind).toBe('audio')
  })

  it('Bilder bleiben nach einem Neustart Bilder', async () => {
    const a = open()
    await a.init()
    const p = await file('logo.png', 5)
    const item = await a.add(p, 'logo.png', {
      width: 40,
      height: 30,
      hasAudio: false,
      duration: 0,
      fps: 0,
      hasVideo: true,
      image: true,
    })
    expect(mediaView(item).kind).toBe('image')
    await a.shutdown()
    const b = open()
    expect(await b.init()).toBe(1)
    expect(mediaView(b.get(item.id)!)).toMatchObject({ kind: 'image', width: 40, height: 30 })
  })

  it('erster Start ohne Verzeichnis: leer, kein Fehler', async () => {
    expect(await open().init()).toBe(0)
  })

  it('Videos überstehen einen Neustart unter derselben ID', async () => {
    const a = open()
    await a.init()
    const p = await file('a.mp4', 25)
    const item = await a.add(p, 'a.mp4', { ...info, fps: 25 })
    await a.shutdown()
    // Beenden löscht die Datei nicht mehr.
    expect(await exists(p)).toBe(true)

    const b = open()
    expect(await b.init()).toBe(1)
    const again = b.get(item.id)
    expect(again).toMatchObject({ id: item.id, path: p, name: 'a.mp4', size: 25 })
    expect(mediaView(again!)).toMatchObject({ duration: 10, fps: 25, hasAudio: true })
    expect(mediaView(again!).kind).toBe('video')
    expect(b.totalBytes).toBe(25)
  })

  it('gelöschte Videos kommen nach dem Neustart nicht wieder', async () => {
    const a = open()
    const keep = await a.add(await file('keep.mp4'), 'keep.mp4', info)
    const gone = await a.add(await file('gone.mp4'), 'gone.mp4', info)
    await a.remove(gone.id)
    await a.shutdown()

    const b = open()
    expect(await b.init()).toBe(1)
    expect(b.has(keep.id)).toBe(true)
    expect(b.has(gone.id)).toBe(false)
  })

  it('übergeht Einträge ohne Datei, außerhalb des Ordners und kaputte Einträge', async () => {
    const a = open()
    const ok = await a.add(await file('ok.mp4'), 'ok.mp4', info)
    const lost = await a.add(await file('lost.mp4'), 'lost.mp4', info)
    await a.shutdown()
    await rm(path.join(dir, 'lost.mp4'))

    const outside = path.join(os.tmpdir(), `media-outside-${Date.now()}.mp4`)
    await writeFile(outside, 'x')
    try {
      const index = JSON.parse(await readFile(indexFile, 'utf8')) as { items: unknown[] }
      const entry = index.items[0] as Record<string, unknown>
      index.items.push(
        { ...entry, id: '11111111-1111-4111-8111-111111111111', path: outside },
        { ...entry, id: 'keine-uuid' },
        { ...entry, id: '22222222-2222-4222-8222-222222222222', info: null },
        'quatsch',
        entry, // doppelt
      )
      await writeFile(indexFile, JSON.stringify(index))

      const b = open()
      expect(await b.init()).toBe(1)
      expect(b.count).toBe(1)
      expect(b.has(ok.id)).toBe(true)
      expect(b.has(lost.id)).toBe(false)
      await b.shutdown()
      // Fremde Datei bleibt unangetastet.
      expect(await exists(outside)).toBe(true)
      // Das Verzeichnis wurde bereinigt.
      const cleaned = JSON.parse(await readFile(indexFile, 'utf8')) as { items: { id: string }[] }
      expect(cleaned.items.map((i) => i.id)).toEqual([ok.id])
    } finally {
      await rm(outside, { force: true })
    }
  })

  it('kaputtes Verzeichnis: beginnt leer und arbeitet weiter', async () => {
    await writeFile(indexFile, '{ kaputt')
    const a = open()
    expect(await a.init()).toBe(0)
    const item = await a.add(await file('a.mp4'), 'a.mp4', info)
    await a.flush()
    const index = JSON.parse(await readFile(indexFile, 'utf8')) as { items: { id: string }[] }
    expect(index.items.map((i) => i.id)).toEqual([item.id])
  })

  it('die Frist läuft über den Neustart weiter', async () => {
    const a = open(1000)
    const p = await file('alt.mp4')
    const item = await a.add(p, 'alt.mp4', info)
    await a.shutdown()

    const b = open(1000)
    await b.init()
    await b.sweep(Date.now() + 500)
    expect(b.has(item.id)).toBe(true)
    await b.sweep(Date.now() + 5000)
    expect(b.has(item.id)).toBe(false)
    expect(await exists(p)).toBe(false)
    await b.flush()
    expect(await open().init()).toBe(0)
  })
})
