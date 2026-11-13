import { describe, it, expect, vi, afterEach } from 'vitest'
import { parseMediaView, fetchMediaInfo, deleteMedia, MEDIA_UNSUPPORTED } from '@/lib/mediaApi'

afterEach(() => vi.unstubAllGlobals())

describe('mediaApi', () => {
  it('parseMediaView prüft die ID und normalisiert Zahlen', () => {
    expect(parseMediaView({ id: 'x', name: '', duration: -1, hasAudio: 1 })).toEqual({
      id: 'x',
      name: 'video',
      size: 0,
      duration: 0,
      width: 0,
      height: 0,
      hasAudio: false,
      fps: 0,
    })
    expect(parseMediaView({ id: 'x', fps: 29.97 }).fps).toBe(29.97)
    expect(() => parseMediaView({})).toThrow()
  })

  it('altes Backend (Route unbekannt) -> MEDIA_UNSUPPORTED; eigene Meldungen bleiben', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('{"error":"Nicht gefunden."}', { status: 404 }))
      .mockResolvedValueOnce(new Response('{"error":"Video nicht gefunden."}', { status: 404 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(fetchMediaInfo('a')).rejects.toThrow(MEDIA_UNSUPPORTED)
    await expect(fetchMediaInfo('a')).rejects.toThrow('Video nicht gefunden.')
  })

  it('deleteMedia: 404 gilt als gelöscht, Serverfehler wirft', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('{"deleted":false}', { status: 404 }))
      .mockResolvedValueOnce(new Response('{"error":"kaputt"}', { status: 500 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(deleteMedia('a')).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledWith('/api/media/a', { method: 'DELETE' })
    await expect(deleteMedia('a')).rejects.toThrow('kaputt')
  })
})
