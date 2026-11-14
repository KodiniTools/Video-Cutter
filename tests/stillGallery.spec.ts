import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { i18n } from '@/i18n'

const fetchGallery = vi.fn()
const fetchGalleryFile = vi.fn()
const deleteGalleryImage = vi.fn()
const galleryVideoToMedia = vi.fn()
const saveFile = vi.fn(async (_f: { blob: Blob; name: string }) => true)

vi.mock('@/lib/aiApi', async (orig) => {
  const real = await orig<typeof import('@/lib/aiApi')>()
  return {
    ...real,
    fetchGallery: () => fetchGallery(),
    fetchGalleryFile: (i: unknown) => fetchGalleryFile(i),
    deleteGalleryImage: (id: string) => deleteGalleryImage(id),
    galleryVideoToMedia: (id: string) => galleryVideoToMedia(id),
  }
})
vi.mock('@/lib/download', () => ({
  saveFile: (f: { blob: Blob; name: string }) => saveFile(f),
}))

import StillGallery from '@/components/StillGallery.vue'
import { galleryFileName, parseGallery, parseGeneratedImages } from '@/lib/aiApi'

const A = { id: 'a', mime: 'image/png', prompt: 'Berg', createdAt: 1_800_000_000_000, size: 2048 }
const B = { id: 'b', mime: 'image/jpeg', prompt: '', createdAt: 1_700_000_000_000, size: 1024 }
const file = new File(['x'], 'ki-bild.png', { type: 'image/png' })

const mountIt = (over: Record<string, unknown> = {}) =>
  mount(StillGallery, {
    props: { disabled: false, refreshKey: 0, ...over },
    global: { plugins: [i18n] },
  })

beforeEach(() => {
  fetchGallery.mockReset().mockResolvedValue({ images: [A, B], totalBytes: 3072 })
  fetchGalleryFile.mockReset().mockResolvedValue(file)
  deleteGalleryImage.mockReset().mockResolvedValue(undefined)
  saveFile.mockClear()
})

describe('StillGallery', () => {
  it('listet Bilder, Klick verwendet eines, ✍ übernimmt den Prompt, ⬇ lädt herunter', async () => {
    const w = mountIt()
    await flushPromises()
    expect(w.findAll('[data-test=gallery-item]')).toHaveLength(2)
    expect(w.find('[data-test=gallery-count]').text()).toContain('2')
    // Nur Bilder mit Prompt haben ✍
    expect(w.findAll('[data-test=gallery-prompt]')).toHaveLength(1)
    await w.findAll('[data-test=gallery-use]')[0].trigger('click')
    await flushPromises()
    expect(fetchGalleryFile).toHaveBeenCalledWith(A)
    expect(w.emitted('pick')).toEqual([[file]])
    await w.find('[data-test=gallery-prompt]').trigger('click')
    expect(w.emitted('prompt')).toEqual([['Berg', 'image']])
    await w.findAll('[data-test=gallery-download]')[1].trigger('click')
    await flushPromises()
    expect(saveFile).toHaveBeenCalledWith({ blob: file, name: 'ki-bild.png' })
    expect(w.emitted('pick')).toHaveLength(1)
  })

  it('Video (▶): Klick legt es in die Bibliothek und meldet das Video; ✍ meldet „video“', async () => {
    const V = { id: 'v', mime: 'video/mp4', prompt: 'Flug', createdAt: 1_800_000_000_000, size: 9 }
    const media = { id: 'm1', name: 'KI-Video_8s.mp4' }
    fetchGallery.mockResolvedValue({ images: [V], totalBytes: 9 })
    galleryVideoToMedia.mockResolvedValue(media)
    const w = mountIt()
    await flushPromises()
    expect(w.find('[data-test=gallery-video]').exists()).toBe(true)
    await w.find('[data-test=gallery-use]').trigger('click')
    await flushPromises()
    expect(galleryVideoToMedia).toHaveBeenCalledWith('v')
    expect(fetchGalleryFile).not.toHaveBeenCalled()
    expect(w.emitted('video')).toEqual([[media]])
    expect(w.emitted('pick')).toBeUndefined()
    await w.find('[data-test=gallery-prompt]').trigger('click')
    expect(w.emitted('prompt')).toEqual([['Flug', 'video']])
    expect(galleryFileName(V)).toMatch(/^ki-video-\d{8}-\d{6}\.mp4$/)
  })

  it('Löschen erst nach zweitem Klick; Bild verschwindet aus der Liste', async () => {
    const w = mountIt()
    await flushPromises()
    const del = w.findAll('[data-test=gallery-delete]')[0]
    await del.trigger('click')
    expect(deleteGalleryImage).not.toHaveBeenCalled()
    expect(del.text()).toContain('Löschen?')
    await del.trigger('click')
    await flushPromises()
    expect(deleteGalleryImage).toHaveBeenCalledWith('a')
    expect(w.findAll('[data-test=gallery-item]')).toHaveLength(1)
  })

  it('lädt neu, wenn neue Bilder erzeugt wurden; zeigt Leerzustand und Fehler', async () => {
    fetchGallery.mockResolvedValueOnce({ images: [], totalBytes: 0 })
    const w = mountIt()
    await flushPromises()
    expect(w.find('[data-test=gallery-empty]').exists()).toBe(true)
    await w.setProps({ refreshKey: 1 })
    await flushPromises()
    expect(fetchGallery).toHaveBeenCalledTimes(2)
    expect(w.findAll('[data-test=gallery-item]')).toHaveLength(2)
    fetchGallery.mockRejectedValueOnce(new Error('kaputt'))
    await w.setProps({ refreshKey: 2 })
    await flushPromises()
    expect(w.find('[role=alert]').text()).toContain('kaputt')
  })
})

describe('aiApi: Galerie', () => {
  it('parseGallery filtert Ungültiges', () => {
    expect(parseGallery({ images: [A, { x: 1 }], totalBytes: 5 })).toEqual({
      images: [A],
      totalBytes: 5,
    })
    expect(parseGallery(null)).toEqual({ images: [], totalBytes: 0 })
  })
  it('Dateiname mit Datum und passender Endung', () => {
    expect(galleryFileName(B)).toMatch(/^ki-bild-\d{8}-\d{6}\.jpg$/)
  })
  it('parseGeneratedImages kennt saved/galleryError (alt: null)', () => {
    expect(parseGeneratedImages({ images: [{ id: 'x' }] }).saved).toBeNull()
    const r = parseGeneratedImages({ images: [{ id: 'x' }], saved: 1, galleryError: 'voll' })
    expect(r.saved).toBe(1)
    expect(r.galleryError).toBe('voll')
  })
})
