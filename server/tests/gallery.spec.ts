import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Gallery, GalleryFullError, isGalleryId, parseGalleryMeta } from '../src/lib/gallery'
import { storeImage } from '../src/lib/gemini'
import { saveToGallery } from '../src/routes/ai'

let dir: string
const noThumb = async () => {
  throw new Error('kein ffmpeg')
}
const fakeThumb = async (_src: string, out: string) => writeFile(out, 'thumb')

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'gallery-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('Gallery', () => {
  it('speichert Bild, Vorschau und Metadaten; listet neueste zuerst', async () => {
    const g = new Gallery(dir, 1000, fakeThumb)
    const a = await g.add(Buffer.from('aaa'), 'image/png', 'Berg')
    await new Promise((r) => setTimeout(r, 5))
    const b = await g.add(Buffer.from('bbbb'), 'image/jpeg', 'See')
    expect(g.list().map((i) => i.id)).toEqual([b.id, a.id])
    expect(g.totalBytes).toBe(7)
    expect((await readdir(dir)).sort()).toEqual(
      [
        `${a.id}.json`,
        `${a.id}.png`,
        `${a.id}.thumb.jpg`,
        `${b.id}.jpg`,
        `${b.id}.json`,
        `${b.id}.thumb.jpg`,
      ].sort(),
    )
    expect(await g.pathOf(a.id, true)).toEqual({
      path: path.join(dir, `${a.id}.thumb.jpg`),
      mime: 'image/jpeg',
    })
    expect((await g.pathOf(a.id, false))?.mime).toBe('image/png')
  })

  it('übersteht einen Neustart (liest den Ordner neu ein), ignoriert Kaputtes', async () => {
    const g1 = new Gallery(dir, 1000, noThumb)
    const a = await g1.add(Buffer.from('aaa'), 'image/webp', 'Prompt A')
    await writeFile(path.join(dir, 'kaputt.json'), '{')
    await writeFile(
      path.join(dir, 'verwaist.json'),
      JSON.stringify({ id: '11111111-1111-4111-8111-111111111111', mime: 'image/png' }),
    )
    const g2 = new Gallery(dir, 1000, noThumb)
    await g2.init()
    expect(g2.list()).toEqual([a])
    // Ohne Vorschau liefert thumb das Original.
    expect((await g2.pathOf(a.id, true))?.path).toBe(path.join(dir, `${a.id}.webp`))
  })

  it('löscht alle Dateien eines Bildes', async () => {
    const g = new Gallery(dir, 1000, fakeThumb)
    const a = await g.add(Buffer.from('aaa'), 'image/png', '')
    expect(await g.remove(a.id)).toBe(true)
    expect(await g.remove(a.id)).toBe(false)
    expect(await readdir(dir)).toEqual([])
    expect(g.list()).toEqual([])
    expect(await g.pathOf(a.id, false)).toBeNull()
  })

  it('Limit: volle Galerie nimmt nichts mehr an', async () => {
    const g = new Gallery(dir, 5, noThumb)
    await g.add(Buffer.from('aaa'), 'image/png', '')
    await expect(g.add(Buffer.from('bbb'), 'image/png', '')).rejects.toBeInstanceOf(
      GalleryFullError,
    )
    await expect(g.add(Buffer.from('x'), 'image/svg+xml', '')).rejects.toThrow(/Bildformat/)
    expect(g.list()).toHaveLength(1)
  })

  it('IDs: nur UUIDs (kein Pfad-Ausbruch)', () => {
    expect(isGalleryId('../../etc/passwd')).toBe(false)
    expect(isGalleryId('11111111-1111-4111-8111-111111111111')).toBe(true)
    expect(parseGalleryMeta({ id: '../x', mime: 'image/png' })).toBeNull()
  })
})

describe('saveToGallery', () => {
  it('legt erzeugte Bilder ab; volle Galerie meldet sich, ohne zu scheitern', async () => {
    const g = new Gallery(dir, 4, noThumb)
    const ids = [
      storeImage(Buffer.from('aaa'), 'image/png'),
      storeImage(Buffer.from('bbb'), 'image/png'),
    ]
    const r = await saveToGallery(
      ids.map((id) => ({ id })),
      'Berg',
      g,
    )
    expect(r.saved).toBe(1)
    expect(r.galleryError).toMatch(/voll/)
    expect(g.list()[0].prompt).toBe('Berg')
  })
})
