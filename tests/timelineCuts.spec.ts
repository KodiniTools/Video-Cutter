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
    fetchAiStatus: () => Promise.resolve({ transcribe: true, claude: true, image: false }),
    runAiJob: (action: string, body: Record<string, unknown>, parse: (d: unknown) => unknown) => {
      jobs.calls.push({ action, body })
      return {
        promise: Promise.resolve().then(() => parse(jobs.results[action])),
        cancel: () => {},
      }
    },
  }
})

import AiInspector from '@/components/timeline/AiInspector.vue'
import { i18n } from '@/i18n'
import { useTimelineStore } from '@/stores/timeline'
import { useTimelineAiStore } from '@/stores/timelineAi'
import { sourceRangeOnTimeline } from '@/timeline/cutSuggestions'
import {
  appendMedia,
  createDoc,
  cutClipRanges,
  putAsset,
  setClipSpeed,
  trimClip,
  updateTrack,
  validateDoc,
  type AssetRef,
  type AudioClip,
  type Clip,
  type OpResult,
  type TimelineDoc,
} from '@/timeline/model'

const S = 1_000_000
const asset = (id: string, seconds = 10): AssetRef => ({
  id,
  kind: 'video',
  name: `${id}.mp4`,
  duration: seconds * S,
  width: 1280,
  height: 720,
  fps: 25,
  hasAudio: true,
})
const must = (r: OpResult): TimelineDoc => {
  if (!r.ok) throw new Error(r.error)
  return r.doc
}
const error = (r: OpResult) => (r.ok ? null : r.error)
const lane = (doc: TimelineDoc, kind: string): Clip[] => [
  ...(doc.tracks.find((t) => t.kind === kind)?.clips ?? []),
]
/** [Beginn, Länge, Quell-Beginn] in Sekunden. */
const brief = (list: Clip[]) =>
  list.map((c) => [c.start / S, c.duration / S, 'sourceIn' in c ? c.sourceIn / S : null])
function twoClips(): TimelineDoc {
  let doc = putAsset(putAsset(createDoc(), asset('a')), asset('b'))
  doc = must(appendMedia(doc, 'a'))
  return must(appendMedia(doc, 'b'))
}
let n = 0
const ids = () => `c${++n}`

describe('cutClipRanges', () => {
  it('schneidet Bereiche heraus, schließt die Lücken, Bild und Ton gemeinsam', () => {
    const doc = twoClips()
    const first = lane(doc, 'video')[0]
    const next = must(
      cutClipRanges(
        doc,
        first.id,
        [
          { start: 6 * S, end: 7 * S },
          { start: 2 * S, end: 3 * S },
        ],
        { ids },
      ),
    )
    expect(validateDoc(next)).toEqual([])
    expect(brief(lane(next, 'video'))).toEqual([
      [0, 2, 0],
      [2, 3, 3],
      [5, 3, 7],
      [8, 10, 0],
    ])
    expect(brief(lane(next, 'audio'))).toEqual(brief(lane(next, 'video')))
    // Der vordere Teil behält die ID; Teile sind paarweise verknüpft.
    expect(lane(next, 'video')[0].id).toBe(first.id)
    const groups = lane(next, 'video').map((c) => c.linkGroup)
    expect(new Set(groups).size).toBe(4)
    expect(lane(next, 'audio').map((c) => c.linkGroup)).toEqual(groups)
  })

  it('fasst Überlappungen zusammen, beschneidet auf den Clip, übergeht zu Kurzes', () => {
    const doc = twoClips()
    const second = lane(doc, 'video')[1]
    const next = must(
      cutClipRanges(doc, second.id, [
        { start: 8 * S, end: 11 * S }, // ragt links hinaus -> ab 10 s
        { start: 10.5 * S, end: 12 * S }, // überlappt -> 10–12 s
        { start: 15 * S, end: 15 * S + 10 }, // zu kurz
        { start: 19.98 * S, end: 30 * S }, // Rest kürzer als ein Clip -> zählt nicht
      ]),
    )
    expect(brief(lane(next, 'video'))).toEqual([
      [0, 10, 0],
      [10, 8, 2],
    ])
    // Nichts zu tun: dasselbe Dokument.
    expect(must(cutClipRanges(doc, second.id, []))).toBe(doc)
  })

  it('Bereich bis zum Clip-Ende bzw. über den ganzen Clip', () => {
    const doc = twoClips()
    const first = lane(doc, 'video')[0]
    const tail = must(cutClipRanges(doc, first.id, [{ start: 9.99 * S, end: 10 * S }]))
    expect(brief(lane(tail, 'video'))).toEqual(brief(lane(doc, 'video')))
    const end = must(cutClipRanges(doc, first.id, [{ start: 4 * S, end: 10 * S }]))
    expect(brief(lane(end, 'video'))).toEqual([
      [0, 4, 0],
      [4, 10, 0],
    ])
    const all = must(cutClipRanges(doc, first.id, [{ start: 0, end: 10 * S }]))
    expect(brief(lane(all, 'video'))).toEqual([[0, 10, 0]])
    expect(lane(all, 'video')[0].asset).toBe('b')
  })

  it('lehnt Unbekanntes und gesperrte Spuren ab', () => {
    const doc = twoClips()
    expect(error(cutClipRanges(doc, 'nope', []))).toBe('clip-not-found')
    const locked = must(updateTrack(doc, doc.tracks[0].id, { locked: true }))
    expect(
      error(cutClipRanges(locked, lane(locked, 'video')[0].id, [{ start: S, end: 2 * S }])),
    ).toBe('track-locked')
  })
})

describe('sourceRangeOnTimeline', () => {
  const clip = (over: Partial<AudioClip> = {}): AudioClip => ({
    id: 'a',
    kind: 'audio',
    asset: 'm',
    start: 10 * S,
    duration: 4 * S,
    sourceIn: 2 * S,
    speed: 1,
    gain: 1,
    ...over,
  })

  it('rechnet Quellzeiten um, begrenzt auf den Clip, beachtet das Tempo', () => {
    expect(sourceRangeOnTimeline(clip(), { start: 3, end: 4 }, 25)).toEqual({
      start: 11 * S,
      end: 12 * S,
    })
    // Ragt vorn und hinten hinaus.
    expect(sourceRangeOnTimeline(clip(), { start: 0, end: 2.5 }, 25)).toEqual({
      start: 10 * S,
      end: 10.52 * S,
    })
    expect(sourceRangeOnTimeline(clip(), { start: 5.5, end: 9 }, 25)).toEqual({
      start: 13.52 * S,
      end: 14 * S,
    })
    // Außerhalb oder kürzer als ein Clip: nichts.
    expect(sourceRangeOnTimeline(clip(), { start: 7, end: 8 }, 25)).toBeNull()
    expect(sourceRangeOnTimeline(clip(), { start: 3, end: 3.01 }, 25)).toBeNull()
    expect(sourceRangeOnTimeline(clip(), { start: Number.NaN, end: 3 }, 25)).toBeNull()
    // Doppeltes Tempo: halbe Länge auf der Timeline.
    expect(
      sourceRangeOnTimeline(clip({ speed: 2, duration: 2 * S }), { start: 4, end: 6 }, 25),
    ).toEqual({ start: 11 * S, end: 12 * S })
  })
})

describe('Schnittvorschläge im Timeline-Editor', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    jobs.calls.length = 0
    jobs.results = {
      transcribe: { text: 'x', words: [], language: 'de' },
      cuts: {
        suggestions: [
          { start: 2, end: 3, kind: 'filler', text: 'ähm', reason: 'Füllwort' },
          { start: 6, end: 7, kind: 'pause', text: '', reason: 'Pause' },
          { start: 9.5, end: 9.9, kind: 'slip', text: 'oh', reason: 'Versprecher' },
        ],
      },
    }
  })

  function setup(): { clipId: string } {
    const timeline = useTimelineStore()
    timeline.putAsset(asset('a'))
    timeline.appendMedia('a')
    // Der Clip verwendet nur 0–8 s der Quelle.
    const audio = lane(timeline.doc, 'audio')[0]
    timeline.trimClip(audio.id, 'end', 8 * S)
    timeline.trimClip(lane(timeline.doc, 'video')[0].id, 'end', 8 * S)
    return { clipId: audio.id }
  }

  it('holt Vorschläge (erkennt vorher die Sprache) und behält nur die im Clip', async () => {
    const { clipId } = setup()
    const ai = useTimelineAiStore()
    expect(await ai.suggestCuts(clipId, 'de', 1.5)).toBe(2)
    expect(jobs.calls.map((c) => c.action)).toEqual(['transcribe', 'cuts'])
    expect(jobs.calls[1].body).toEqual({ mediaId: 'a', minPause: 1.5 })
    expect(ai.suggestions?.items.map((s) => [s.kind, s.checked])).toEqual([
      ['filler', true],
      ['pause', true],
    ])
    // Zweiter Lauf: Das Transkript ist schon da.
    await ai.suggestCuts(clipId, 'de', 1.5)
    expect(jobs.calls.map((c) => c.action)).toEqual(['transcribe', 'cuts', 'cuts'])
  })

  it('schneidet die angehakten Bereiche in einem Schritt heraus', async () => {
    const { clipId } = setup()
    const timeline = useTimelineStore()
    const ai = useTimelineAiStore()
    await ai.suggestCuts(clipId, 'de', 1.2)
    const pause = ai.suggestions!.items[1]
    ai.setSuggestionChecked(pause.id, false)
    expect(ai.applyCuts()).toEqual({ cut: 1, dropped: 0 })
    expect(brief(lane(timeline.doc, 'video'))).toEqual([
      [0, 2, 0],
      [2, 5, 3],
    ])
    expect(brief(lane(timeline.doc, 'audio'))).toEqual(brief(lane(timeline.doc, 'video')))
    expect(ai.suggestions).toBeNull()
    timeline.undo()
    expect(brief(lane(timeline.doc, 'video'))).toEqual([[0, 8, 0]])
  })

  it('rechnet mit dem Stand des Clips beim Anwenden (inzwischen gekürzt)', async () => {
    const { clipId } = setup()
    const timeline = useTimelineStore()
    const ai = useTimelineAiStore()
    await ai.suggestCuts(clipId, 'de', 1.2)
    timeline.apply((d) => trimClip(d, clipId, 'end', 5 * S))
    timeline.apply((d) => trimClip(d, lane(d, 'video')[0].id, 'end', 5 * S))
    expect(ai.applyCuts()).toEqual({ cut: 1, dropped: 1 })
    expect(brief(lane(timeline.doc, 'audio'))).toEqual([
      [0, 2, 0],
      [2, 2, 3],
    ])
  })

  it('Bedienung: Liste mit Zeiten der Timeline, Sprung zum Vorschlag, Anwenden', async () => {
    const { clipId } = setup()
    const timeline = useTimelineStore()
    // Doppeltes Tempo: Die Zeiten in der Liste sind die der Timeline.
    timeline.apply((d) => setClipSpeed(d, clipId, 2))
    timeline.select([clipId])
    const wrapper = mount(AiInspector, { global: { plugins: [i18n] } })
    await flushPromises()
    expect(wrapper.find('[data-testid=timeline-ai-cut-list]').exists()).toBe(false)
    await wrapper.get('[data-testid=timeline-ai-suggest]').trigger('click')
    await flushPromises()
    const rows = wrapper.findAll('[data-testid=timeline-ai-cut-list] li')
    expect(rows).toHaveLength(2)
    expect(rows[0].text()).toContain('Füllwort')
    expect(rows[0].text()).toContain('00:01.000 – 00:01.520')
    expect(rows[0].text()).toContain('„ähm“')
    await rows[1].get('button.cut').trigger('click')
    expect(timeline.playhead).toBe(3 * S)
    expect(wrapper.get('[data-testid=timeline-ai-apply-cuts]').text()).toContain('(2)')

    await wrapper.get('[data-testid=timeline-ai-apply-cuts]').trigger('click')
    expect(brief(lane(timeline.doc, 'audio'))).toEqual([
      [0, 1, 0],
      // Bei 25 Bildern/s rastet 1,5 s auf 1,52 s (halbes Bild bei doppeltem Tempo).
      [1, 1.48, 3.04],
      [2.48, 0.48, 7.04],
    ])
    expect(wrapper.get('[data-testid=timeline-ai-notice]').text()).toBe(
      '2 Bereiche herausgeschnitten.',
    )
    expect(wrapper.find('[data-testid=timeline-ai-cut-list]').exists()).toBe(false)
  })
})
