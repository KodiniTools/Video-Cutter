import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, writeFile, readFile, readdir, rm, access } from 'node:fs/promises'
import { Readable } from 'node:stream'
import os from 'node:os'
import path from 'node:path'
import { MediaStore } from '../src/lib/media'
import {
  MissingMediaError,
  ProjectNotFoundError,
  ProjectStorageFullError,
  ProjectStore,
  parseSaveInput,
  projectName,
} from '../src/lib/projects'
import { ValidationError } from '../src/lib/validate'

const info = { width: 640, height: 360, hasAudio: true, duration: 10, fps: 25 }
const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  )
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')

describe('parseSaveInput / projectName', () => {
  it('prüft Name, Stand, Videos und Dateien', () => {
    expect(projectName('  Mein\nProjekt ')).toBe('Mein Projekt')
    expect(() => projectName('   ')).toThrow(ValidationError)
    const h = 'a'.repeat(64)
    const ok = parseSaveInput({
      name: 'X',
      state: { v: 1 },
      media: ['0b0f8a52-3c3e-4c0e-9f00-000000000001', '0b0f8a52-3c3e-4c0e-9f00-000000000001'],
      assets: [{ hash: h, size: 3, type: 'image/png', name: 'a"b.png' }],
    })
    expect(ok.media).toHaveLength(1) // doppelte entfernt
    expect(ok.assets[0]).toEqual({ hash: h, size: 3, type: 'image/png', name: 'ab.png' })
    expect(() => parseSaveInput({ name: 'X', state: null, media: [], assets: [] })).toThrow()
    expect(() => parseSaveInput({ name: 'X', state: {}, media: ['../x'], assets: [] })).toThrow()
    expect(() =>
      parseSaveInput({ name: 'X', state: {}, media: [], assets: [{ hash: 'zz', size: 1 }] }),
    ).toThrow()
    expect(() =>
      parseSaveInput({ id: '../../etc', name: 'X', state: {}, media: [], assets: [] }),
    ).toThrow()
  })
})

describe('ProjectStore', () => {
  let root: string
  let tmp: string
  let media: MediaStore
  let store: ProjectStore

  const video = async (name: string, bytes = 10) => {
    const p = path.join(tmp, `${name}-${Math.random()}.mp4`)
    await writeFile(p, Buffer.alloc(bytes, 7))
    return media.add(p, name, info)
  }

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'projects-spec-'))
    tmp = path.join(root, 'tmp')
    await mkdir(tmp, { recursive: true })
    media = new MediaStore(60_000, 100_000)
    store = new ProjectStore(path.join(root, 'projects'), media, 10_000, tmp)
  })
  afterEach(async () => {
    await media.shutdown()
    await rm(root, { recursive: true, force: true })
  })

  it('speichert, listet, öffnet und überlebt das Löschen des Bibliotheks-Videos', async () => {
    const v = await video('a.mp4')
    const r = await store.save({
      name: 'Projekt A',
      state: { items: [{ media: v.id }] },
      media: [v.id],
      assets: [],
    })
    expect(r.missingAssets).toEqual([])
    expect(r.project).toMatchObject({ name: 'Projekt A', videoCount: 1, size: 10 })
    expect((await store.list()).map((p) => p.id)).toEqual([r.project.id])

    // Bibliothek räumt auf (TTL/Neustart) -> Projekt hat eine eigene Kopie.
    await media.remove(v.id)
    const opened = await store.open(r.project.id)
    const mv = opened[v.id]
    expect(mv.id).not.toBe(v.id)
    expect(mv).toMatchObject({ name: 'a.mp4', size: 10, duration: 10, fps: 25 })
    expect(media.has(mv.id)).toBe(true)
    expect((await readFile(media.get(mv.id)!.path)).length).toBe(10)

    const got = await store.get(r.project.id)
    expect(got.state).toEqual({ items: [{ media: v.id }] })
  })

  it('erneutes Speichern mit der neuen Bibliotheks-ID kopiert nicht noch einmal', async () => {
    const v = await video('a.mp4')
    const r = await store.save({ name: 'P', state: {}, media: [v.id], assets: [] })
    const opened = await store.open(r.project.id)
    const live = opened[v.id].id
    const dir = path.join(root, 'projects', r.project.id, 'media')
    const before = await readdir(dir)
    const r2 = await store.save({
      id: r.project.id,
      name: 'P2',
      state: {},
      media: [live],
      assets: [],
    })
    expect(r2.project.name).toBe('P2')
    expect(await readdir(dir)).toEqual(before)
  })

  it('entfernt nicht mehr benutzte Videos, meldet fehlende Videos', async () => {
    const a = await video('a.mp4')
    const b = await video('b.mp4')
    const r = await store.save({ name: 'P', state: {}, media: [a.id, b.id], assets: [] })
    const dir = path.join(root, 'projects', r.project.id, 'media')
    expect(await readdir(dir)).toHaveLength(2)
    await store.save({ id: r.project.id, name: 'P', state: {}, media: [a.id], assets: [] })
    expect(await readdir(dir)).toHaveLength(1)

    const gone = '0b0f8a52-3c3e-4c0e-9f00-0000000000ff'
    await expect(
      store.save({ id: r.project.id, name: 'P', state: {}, media: [gone], assets: [] }),
    ).rejects.toBeInstanceOf(MissingMediaError)
    // Fehlgeschlagenes Speichern lässt den alten Stand stehen.
    expect(await readdir(dir)).toHaveLength(1)
    // Neues Projekt mit fehlendem Video -> kein Ordner bleibt zurück.
    await expect(
      store.save({ name: 'Q', state: {}, media: [gone], assets: [] }),
    ).rejects.toBeInstanceOf(MissingMediaError)
    expect(await store.list()).toHaveLength(1)
  })

  it('Zusatzdateien: fehlende melden, Prüfsumme prüfen, ausliefern', async () => {
    const data = Buffer.from('hallo bild')
    const hash = sha(data)
    const r = await store.save({
      name: 'P',
      state: {},
      media: [],
      assets: [{ hash, size: data.length, type: 'image/png', name: 'a.png' }],
    })
    expect(r.missingAssets).toEqual([hash])
    await expect(
      store.putAsset(r.project.id, hash, Readable.from([Buffer.from('falsch!!!!')])),
    ).rejects.toBeInstanceOf(ValidationError)
    await expect(
      store.putAsset(r.project.id, hash, Readable.from([Buffer.from('viel zu lang: hallo bild')])),
    ).rejects.toBeInstanceOf(ValidationError)
    await store.putAsset(r.project.id, hash, Readable.from([data]))
    const a = await store.asset(r.project.id, hash)
    expect(await readFile(a.path)).toEqual(data)
    expect(a.type).toBe('image/png')
    const again = await store.save({
      id: r.project.id,
      name: 'P',
      state: {},
      media: [],
      assets: [{ hash, size: data.length, type: 'image/png', name: 'a.png' }],
    })
    expect(again.missingAssets).toEqual([])
    // Nicht mehr verwendete Datei wird gelöscht.
    await store.save({ id: r.project.id, name: 'P', state: {}, media: [], assets: [] })
    await expect(store.asset(r.project.id, hash)).rejects.toBeInstanceOf(ProjectNotFoundError)
  })

  it('Speicherlimit und Löschen', async () => {
    const big = await video('big.mp4', 9_000)
    const r = await store.save({ name: 'P', state: {}, media: [big.id], assets: [] })
    const other = await video('o.mp4', 2_000)
    await expect(
      store.save({ name: 'Q', state: {}, media: [other.id], assets: [] }),
    ).rejects.toBeInstanceOf(ProjectStorageFullError)
    expect(await store.remove(r.project.id)).toBe(true)
    expect(await store.remove(r.project.id)).toBe(false)
    expect(await exists(path.join(root, 'projects', r.project.id))).toBe(false)
    await expect(store.get(r.project.id)).rejects.toBeInstanceOf(ProjectNotFoundError)
    await expect(store.get('../../etc')).rejects.toBeInstanceOf(ProjectNotFoundError)
    // Bibliotheks-Video bleibt vom Projekt-Löschen unberührt.
    expect(media.has(big.id)).toBe(true)
  })
})
