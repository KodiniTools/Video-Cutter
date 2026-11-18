import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const jobs = vi.hoisted(() => ({
  calls: [] as { action: string; body: Record<string, unknown> }[],
  results: {} as Record<string, unknown>,
}))
vi.mock('@/lib/aiApi', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/aiApi')>()
  return {
    ...real,
    fetchAiStatus: () => Promise.resolve({ transcribe: true, claude: true, image: true }),
    fetchAiModels: () => Promise.resolve(null),
    runAiJob: (action: string, body: Record<string, unknown>, parse: (d: unknown) => unknown) => {
      jobs.calls.push({ action, body })
      return {
        promise: Promise.resolve().then(() => parse(jobs.results[action])),
        cancel: () => {},
      }
    },
  }
})
// Die Medienliste fragt sonst den Server nach abgeleiteten Dateien.
vi.mock('@/lib/mediaApi', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/mediaApi')>()
  return { ...real, fetchDerivedStatus: () => new Promise(() => {}) }
})

import AiInspector from '@/components/timeline/AiInspector.vue'
import { i18n } from '@/i18n'
import { parseBrollSuggestions } from '@/lib/aiApi'
import { useTimelineStore } from '@/stores/timeline'
import { useTimelineAiStore } from '@/stores/timelineAi'
import { useTimelineBrollStore } from '@/stores/timelineBroll'
import { brollTrack, brollVideoSeconds, insertBrollClip, BROLL_FADE } from '@/timeline/broll'
import {
  appendMedia,
  createDoc,
  putAsset,
  updateTrack,
  type AssetRef,
  type OpResult,
  type TimelineDoc,
} from '@/timeline/model'

const S = 1_000_000
const video = (id: string, seconds = 60, hasAudio = true): AssetRef => ({
  id,
  kind: 'video',
  name: `${id}.mp4`,
  duration: seconds * S,
  width: 1920,
  height: 1080,
  fps: 25,
  hasAudio,
})
const must = (r: OpResult): TimelineDoc => {
  if (!r.ok) throw new Error(r.error)
  return r.doc
}
let n = 0
const ids = () => `b${++n}`

function baseDoc(): TimelineDoc {
  let d = createDoc()
  d = putAsset(d, video('main', 60))
  d = putAsset(d, video('ki', 8, false))
  return must(appendMedia(d, 'main', { ids }))
}

describe('Zwischenbilder: Lage auf der Timeline', () => {
  beforeEach(() => {
    n = 0
  })

  it('legt das Bild ohne Ton auf eine neue Spur direkt über das Video, mit Blende', () => {
    const d = baseDoc()
    const r = insertBrollClip(d, 'ki', 10.01 * S, 4 * S, { ids })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const video = r.doc.tracks.filter((t) => t.kind === 'video')
    expect(video).toHaveLength(2)
    expect(r.doc.tracks[0].clips).toEqual([
      {
        id: r.clipId,
        kind: 'video',
        asset: 'ki',
        start: 10 * S, // aufs Bildraster (25 fps) gerundet
        duration: 4 * S,
        sourceIn: 0,
        speed: 1,
        transitionIn: { preset: 'fade', duration: BROLL_FADE },
        fadeOut: { duration: BROLL_FADE },
      },
    ])
    // Kein Ton-Clip dazu: Das Gesprochene läuft weiter.
    expect(r.doc.tracks.filter((t) => t.kind === 'audio').map((t) => t.clips.length)).toEqual([1])
  })

  it('nutzt eine freie Spur über dem Video wieder und kürzt auf die Länge des Mediums', () => {
    let d = baseDoc()
    const a = insertBrollClip(d, 'ki', 10 * S, 4 * S, { ids })
    d = must(a)
    const b = insertBrollClip(d, 'ki', 20 * S, 12 * S, { ids })
    d = must(b)
    expect(d.tracks.filter((t) => t.kind === 'video')).toHaveLength(2)
    expect(d.tracks[0].clips.map((c) => [c.start, c.duration])).toEqual([
      [10 * S, 4 * S],
      [20 * S, 8 * S],
    ])
    // Überschneidung: neue Spur ganz oben über der belegten.
    const c = insertBrollClip(d, 'ki', 12 * S, 1.5 * S, { ids })
    d = must(c)
    expect(d.tracks.filter((t) => t.kind === 'video')).toHaveLength(3)
    expect(d.tracks[0].clips.map((x) => x.start)).toEqual([12 * S])
    // Kurz: keine Blende.
    expect(d.tracks[0].clips[0]).not.toHaveProperty('transitionIn')
  })

  it('überspringt gesperrte Spuren und lehnt Unpassendes ab', () => {
    let d = baseDoc()
    d = must(insertBrollClip(d, 'ki', 10 * S, 4 * S, { ids }))
    d = must(updateTrack(d, d.tracks[0].id, { locked: true }))
    const place = brollTrack(d, 30 * S, 34 * S)
    expect(place).toEqual({ index: 1 })
    expect(insertBrollClip(d, 'fehlt', 0, S).ok).toBe(false)
    expect(insertBrollClip(d, 'ki', 0, 10_000).ok).toBe(false)
  })

  it('Videolänge: ganze Sekunden, 3–15', () => {
    expect(brollVideoSeconds(4)).toBe(4)
    expect(brollVideoSeconds(4.2)).toBe(5)
    expect(brollVideoSeconds(1)).toBe(3)
    expect(brollVideoSeconds(40)).toBe(15)
  })

  it('liest die Vorschläge des Servers', () => {
    expect(
      parseBrollSuggestions({
        suggestions: [
          { at: 9, end: 12, kind: 'video', title: 'B', reason: '', prompt: ' p2 ' },
          { at: 2, end: 5, kind: 'x', title: 'A', reason: 'r', prompt: 'p1' },
          { at: 4, end: 3, kind: 'image', title: '', reason: '', prompt: 'kaputt' },
          { at: 5, end: 6, kind: 'image', title: '', reason: '', prompt: '' },
        ],
      }),
    ).toEqual([
      { at: 2, end: 5, kind: 'image', title: 'A', reason: 'r', prompt: 'p1' },
      { at: 9, end: 12, kind: 'video', title: 'B', reason: '', prompt: 'p2' },
    ])
    expect(parseBrollSuggestions(null)).toEqual([])
  })
})

describe('Zwischenbilder im KI-Assistenten', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    jobs.calls = []
    n = 0
    jobs.results = {
      transcribe: { language: 'de', words: 3, text: 'a b c' },
      broll: {
        suggestions: [
          { at: 5, end: 9, kind: 'video', title: 'Berg', reason: 'passt', prompt: 'Ein Berg.' },
          { at: 20, end: 24, kind: 'video', title: 'See', reason: '', prompt: 'Ein See.' },
        ],
      },
      video: {
        media: {
          id: 'kivideo',
          name: 'KI-Video_5s.mp4',
          size: 1000,
          duration: 5,
          width: 1920,
          height: 1080,
          fps: 25,
          hasAudio: true,
          hasVideo: true,
          kind: 'video',
        },
        saved: 1,
        galleryError: '',
        model: 'gemini-omni',
      },
    }
    i18n.global.locale.value = 'de'
  })

  it('schlägt vor, erzeugt nur Angehaktes und fügt in einem Schritt ein', async () => {
    const timeline = useTimelineStore()
    timeline.putAsset(video('a', 40))
    timeline.appendMedia('a')
    const wrapper = mount(AiInspector, { global: { plugins: [i18n] } })
    await flushPromises()

    await wrapper.get('[data-testid=timeline-ai-broll-mode]').setValue('video')
    await wrapper.get('[data-testid=timeline-ai-broll-suggest]').trigger('click')
    await flushPromises()
    expect(jobs.calls.map((c) => c.action)).toEqual(['transcribe', 'broll'])
    expect(jobs.calls[1].body).toMatchObject({
      segments: [{ mediaId: 'a', from: 0, to: 40, at: 0, speed: 1 }],
      duration: 40,
      mode: 'video',
      style: 'auto',
      count: 5,
      language: 'de',
      width: 1920,
      height: 1080,
    })
    const items = wrapper.findAll('[data-testid=timeline-ai-broll-item]')
    expect(items).toHaveLength(2)

    // Zweite Stelle abwählen, Prompt der ersten ändern.
    await items[1].get('input[type=checkbox]').setValue(false)
    await items[0].get('[data-testid=timeline-ai-broll-prompt]').setValue('Ein hoher Berg.')
    await wrapper.get('[data-testid=timeline-ai-broll-generate]').trigger('click')
    await flushPromises()
    const gen = jobs.calls.filter((c) => c.action === 'video')
    expect(gen).toHaveLength(1)
    expect(gen[0].body).toEqual({
      prompt: 'Ein hoher Berg.',
      width: 1920,
      height: 1080,
      duration: 4,
    })

    const broll = useTimelineBrollStore()
    expect(broll.items.map((i) => i.state)).toEqual(['ready', 'idle'])
    const before = timeline.doc
    await wrapper.get('[data-testid=timeline-ai-broll-insert]').trigger('click')
    await flushPromises()
    const top = timeline.doc.tracks[0]
    expect(top.kind).toBe('video')
    expect(top.clips.map((c) => [c.asset, c.start, c.duration])).toEqual([
      ['kivideo', 5 * S, 4 * S],
    ])
    expect(wrapper.get('[data-testid=timeline-ai-broll-notice]').text()).toContain('1')
    // Eingefügt: nicht ein zweites Mal; nach Rückgängig wieder einfügbar.
    expect(broll.insertable).toHaveLength(0)
    // Ein einziger Verlaufsschritt: Rückgängig holt genau den Stand davor zurück.
    timeline.undo()
    expect(timeline.doc).toEqual(before)
    expect(broll.insertable).toHaveLength(1)
  })

  it('meldet fehlendes Gesprochenes', async () => {
    const ai = useTimelineAiStore()
    await expect(
      ai.suggestBroll('de', { mode: 'auto', style: 'auto', count: 3, promptLanguage: 'de' }),
    ).rejects.toThrow('NO_SPEECH')
  })
})
