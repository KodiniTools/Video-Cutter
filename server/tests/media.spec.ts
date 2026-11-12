import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, writeFile, access, rm } from 'node:fs/promises'
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
