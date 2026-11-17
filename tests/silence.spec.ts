import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('@/lib/aiApi', async (original) => ({
  ...(await original<typeof import('@/lib/aiApi')>()),
  fetchAiStatus: () => Promise.resolve({ transcribe: false, claude: false, image: false }),
}))
vi.mock('@/lib/derivedApi', async (original) => ({
  ...(await original<typeof import('@/lib/derivedApi')>()),
  ensureDerived: () => new Promise<never>(() => {}),
}))

import AiInspector from '@/components/timeline/AiInspector.vue'
import { i18n } from '@/i18n'
import type { MediaView } from '@/lib/mediaApi'
import { useMediaPoolStore } from '@/stores/mediaPool'
import { useTimelineStore } from '@/stores/timeline'
import { useTimelineAiStore } from '@/stores/timelineAi'
import { findSilences, SILENCE_KEEP } from '@/timeline/silence'
import type { Clip, TimelineDoc } from '@/timeline/model'

const RATE = 50
/** Wellenform aus Stücken [Sekunden, Pegel]. */
const wave = (...parts: [number, number][]) =>
  Uint8Array.from(
    parts.flatMap(([sec, level]) => new Array<number>(Math.round(sec * RATE)).fill(level)),
  )
const round = (list: { start: number; end: number }[]) =>
  list.map((r) => [Math.round(r.start * 100) / 100, Math.round(r.end * 100) / 100])

describe('findSilences', () => {
  it('meldet Pausen ab der Mindestlänge, mit einem Rest an beiden Rändern', () => {
    // laut 2 s, still 1,5 s, laut 1 s, still 0,5 s (zu kurz), laut 1 s
    const peaks = wave([2, 200], [1.5, 2], [1, 180], [0.5, 0], [1, 200])
    expect(round(findSilences(peaks, RATE, { minLength: 1 }))).toEqual([
      [2 + SILENCE_KEEP, 3.5 - SILENCE_KEEP],
    ])
    expect(round(findSilences(peaks, RATE, { minLength: 0.4, keep: 0 }))).toEqual([
      [2, 3.5],
      [4.5, 5],
    ])
  })

  it('Stille am Anfang und Ende der Datei reicht bis an den Rand', () => {
    const peaks = wave([1, 0], [2, 200], [1.2, 1])
    expect(round(findSilences(peaks, RATE, { minLength: 0.8 }))).toEqual([
      [0, 1 - SILENCE_KEEP],
      [3 + SILENCE_KEEP, 4.2],
    ])
  })

  it('die Schwelle richtet sich nach der Lautstärke der Aufnahme', () => {
    // Rauschen bei 20 unter Sprache bei 200: „normal“ (6 %) hört es als Ton, „auch Rauschen“ nicht.
    const noisy = wave([2, 200], [1.5, 20], [2, 200])
    expect(findSilences(noisy, RATE, { minLength: 1 })).toEqual([])
    expect(findSilences(noisy, RATE, { minLength: 1, level: 'high' })).toHaveLength(1)
    // Leise Aufnahme: dieselbe Pause wird gefunden.
    const quiet = wave([2, 40], [1.5, 1], [2, 40])
    expect(findSilences(quiet, RATE, { minLength: 1 })).toHaveLength(1)
  })

  it('ohne Wellenform oder ganz ohne Ton: nichts', () => {
    expect(findSilences(null, RATE, { minLength: 1 })).toEqual([])
    expect(findSilences(wave([3, 0]), RATE, { minLength: 1 })).toEqual([])
    expect(findSilences(wave([3, 200]), 0, { minLength: 1 })).toEqual([])
  })
})

describe('Stille finden im Timeline-Editor', () => {
  const S = 1_000_000
  const media: MediaView = {
    id: 'a',
    name: 'a.mp4',
    size: 1000,
    duration: 8,
    width: 1280,
    height: 720,
    hasAudio: true,
    fps: 25,
  }
  const lane = (doc: TimelineDoc, kind: string): Clip[] => [
    ...(doc.tracks.find((t) => t.kind === kind)?.clips ?? []),
  ]
  const brief = (list: Clip[]) =>
    list.map((c) => [c.start / S, c.duration / S, 'sourceIn' in c ? c.sourceIn / S : null])
  // laut 2 s, still 2 s, laut 4 s
  const peaks = wave([2, 200], [2, 0], [4, 200])

  beforeEach(() => setActivePinia(createPinia()))

  function setup(withWave = true) {
    const timeline = useTimelineStore()
    const pool = useMediaPoolStore()
    pool.addMedia(media)
    if (withWave) {
      const item = pool.items[0]
      item.peaks = peaks
      item.derived = {
        peaks: { state: 'ready', rate: RATE, count: peaks.length },
        strip: { state: 'missing' },
        proxy: { state: 'missing' },
      } as never
    }
    timeline.appendMedia('a')
    return { timeline, clipId: lane(timeline.doc, 'audio')[0].id }
  }

  it('trägt Pausen als Vorschläge ein und schneidet sie heraus', () => {
    const { timeline, clipId } = setup()
    const ai = useTimelineAiStore()
    expect(ai.suggestSilence(clipId, peaks, RATE, { minLength: 1 })).toBe(1)
    expect(ai.suggestions?.items.map((s) => [s.kind, s.checked])).toEqual([['pause', true]])
    expect(ai.applyCuts()).toEqual({ cut: 1, dropped: 0 })
    // 2,15–3,85 s auf dem Bildraster (25 Bilder/s): 2,16–3,84 s.
    expect(brief(lane(timeline.doc, 'video'))).toEqual([
      [0, 2.16, 0],
      [2.16, 4.16, 3.84],
    ])
    expect(brief(lane(timeline.doc, 'audio'))).toEqual(brief(lane(timeline.doc, 'video')))
    expect(ai.suggestSilence(clipId, peaks, RATE, { minLength: 5 })).toBe(0)
    expect(ai.suggestions).toBeNull()
  })

  it('Knopf arbeitet ohne KI; ohne Wellenform ist er gesperrt', async () => {
    const { timeline, clipId } = setup()
    timeline.select([clipId])
    const wrapper = mount(AiInspector, { global: { plugins: [i18n] } })
    await flushPromises()
    // Ohne Whisper/Claude sind die KI-Knöpfe gesperrt, „Stille finden“ nicht.
    expect(wrapper.get('[data-testid=timeline-ai-suggest]').attributes('disabled')).toBeDefined()
    const button = wrapper.get('[data-testid=timeline-ai-silence]')
    expect(button.attributes('disabled')).toBeUndefined()
    await button.trigger('click')
    const rows = wrapper.findAll('[data-testid=timeline-ai-cut-list] li')
    expect(rows).toHaveLength(1)
    expect(rows[0].text()).toContain('Pause')
    expect(rows[0].text()).toContain('00:02.160 – 00:03.840')

    // Längere Mindestpause: nichts gefunden, Hinweis.
    const min = wrapper.get('[data-testid=timeline-ai-min-pause]')
    await min.setValue(5)
    await button.trigger('click')
    expect(wrapper.find('[data-testid=timeline-ai-cut-list]').exists()).toBe(false)
    expect(wrapper.get('[data-testid=timeline-ai-notice]').text()).toBe(
      'Keine Stille in dieser Länge gefunden.',
    )

    setActivePinia(createPinia())
    const bare = setup(false)
    bare.timeline.select([bare.clipId])
    const second = mount(AiInspector, { global: { plugins: [i18n] } })
    await flushPromises()
    expect(second.get('[data-testid=timeline-ai-silence]').attributes('disabled')).toBeDefined()
  })
})
