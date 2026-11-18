import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('@/lib/derivedApi', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/derivedApi')>()
  return {
    ...real,
    ensureDerived: () => new Promise(() => {}),
    fetchDerivedStatus: () => new Promise(() => {}),
  }
})

import type { MediaView } from '@/lib/mediaApi'
import { generatedAtRisk, useMediaPoolStore } from '@/stores/mediaPool'
import { useTimelineStore } from '@/stores/timeline'

const media = (id: string, over: Partial<MediaView> = {}): MediaView => ({
  id,
  name: `${id}.mp4`,
  size: 1000,
  duration: 5,
  width: 1280,
  height: 720,
  fps: 25,
  hasAudio: false,
  ...over,
})

describe('Medienliste: vorhandenes Server-Medium aufnehmen', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('legt Bild-Clip bzw. KI-Video als fertiges Medium an und meldet es im Dokument an', () => {
    const pool = useMediaPoolStore()
    const timeline = useTimelineStore()
    pool.addMedia(media('a'))
    expect(pool.items.map((i) => [i.name, i.state, i.media?.id])).toEqual([['a.mp4', 'ready', 'a']])
    expect(timeline.doc.assets.a).toMatchObject({ kind: 'video', hasAudio: false, name: 'a.mp4' })
    // Dasselbe Medium noch einmal (z. B. zweimal aus der Galerie): kein Duplikat.
    pool.addMedia(media('a'))
    expect(pool.items).toHaveLength(1)
    // Ohne Ton entsteht beim Einfügen nur ein Bild-Clip.
    expect(timeline.appendMedia('a')).toBe(true)
    expect(timeline.doc.tracks.map((t) => [t.kind, t.clips.length])).toEqual([['video', 1]])
    pool.dispose()
  })
})

describe('Medienliste: Hinweis auf ungespeicherte Server-Medien', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('kennzeichnet Bild-Clips/KI-Videos als erzeugt, Uploads und geöffnete Projekte nicht', () => {
    const pool = useMediaPoolStore()
    pool.addMedia(media('a'))
    expect(pool.items[0].generated).toBe(true)
    expect(generatedAtRisk(pool.items, true)).toBe(true)
    // Gespeichert: kein Hinweis.
    expect(generatedAtRisk(pool.items, false)).toBe(false)
    // Projekt geöffnet: Die Medien liegen im Projekt, also nicht mehr gefährdet.
    pool.replaceAll([media('a')])
    expect(pool.items[0].generated).toBeUndefined()
    expect(generatedAtRisk(pool.items, true)).toBe(false)
    pool.dispose()
  })

  it('leere Liste: kein Hinweis', () => {
    expect(generatedAtRisk([], true)).toBe(false)
  })
})
