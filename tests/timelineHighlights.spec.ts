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
import TimelineClip from '@/components/timeline/TimelineClip.vue'
import { i18n } from '@/i18n'
import { parseHighlights } from '@/lib/aiApi'
import { useTimelineStore } from '@/stores/timeline'
import { ALL_HIGHLIGHTS, useTimelineAiStore } from '@/stores/timelineAi'
import { useTimelineProjectStore } from '@/stores/timelineProjects'
import { buildShortDoc, gapsBetween, shortCrop } from '@/timeline/highlights'
import {
  appendMedia,
  createDoc,
  putAsset,
  setClipCrop,
  setClipSpeed,
  trimClip,
  validateDoc,
  type AssetRef,
  type Clip,
  type OpResult,
  type TimelineDoc,
  type VideoClip,
} from '@/timeline/model'

const S = 1_000_000
const asset = (id: string, seconds = 60): AssetRef => ({
  id,
  kind: 'video',
  name: `${id}.mp4`,
  duration: seconds * S,
  width: 1920,
  height: 1080,
  fps: 25,
  hasAudio: true,
})
const must = (r: OpResult): TimelineDoc => {
  if (!r.ok) throw new Error(r.error)
  return r.doc
}
const lane = (doc: TimelineDoc, kind: string): Clip[] => [
  ...(doc.tracks.find((t) => t.kind === kind)?.clips ?? []),
]
/** [Beginn, Länge, Quell-Beginn] in Sekunden. */
const brief = (list: Clip[]) =>
  list.map((c) => [c.start / S, c.duration / S, 'sourceIn' in c ? c.sourceIn / S : null])
let n = 0
const ids = () => `h${++n}`

describe('Highlights: reine Funktionen', () => {
  it('shortCrop schneidet mittig auf das Zielformat, auch in einem vorhandenen Zuschnitt', () => {
    const wide = { width: 1920, height: 1080 }
    // 16:9 -> 9:16: Breite = 1080·9/16 / 1920 = 0,3164
    expect(shortCrop(wide, null, 1080, 1920)).toEqual({
      x: 0.3418,
      y: 0,
      width: 0.3164,
      height: 1,
    })
    expect(shortCrop(wide, null, 1080, 1080)).toEqual({ x: 0.2188, y: 0, width: 0.5625, height: 1 })
    // Hochkant-Quelle in Querformat: oben und unten abschneiden.
    expect(shortCrop({ width: 1080, height: 1920 }, null, 1920, 1080)).toEqual({
      x: 0,
      y: 0.3418,
      width: 1,
      height: 0.3164,
    })
    // Vorhandener Zuschnitt (linke Hälfte) bleibt die Grundlage.
    const left = { x: 0, y: 0, width: 0.5, height: 1 }
    expect(shortCrop(wide, left, 1080, 1920)).toEqual({ x: 0.0918, y: 0, width: 0.3164, height: 1 })
    // Passt schon bzw. Größe unbekannt: nichts Neues.
    expect(shortCrop(wide, null, 1920, 1080)).toBeNull()
    expect(shortCrop({}, left, 1080, 1920)).toEqual(left)
  })

  it('gapsBetween liefert die Lücken zwischen sortierten Bereichen', () => {
    expect(
      gapsBetween([
        { start: 5, end: 8 },
        { start: 1, end: 2 },
        { start: 8, end: 9 },
      ]),
    ).toEqual([{ start: 2, end: 5 }])
    expect(gapsBetween([])).toEqual([])
  })

  it('buildShortDoc legt die Stellen hintereinander, im Hochformat und zugeschnitten', () => {
    let doc = putAsset(createDoc(), asset('a'))
    doc = must(appendMedia(doc, 'a'))
    const video = lane(doc, 'video')[0] as VideoClip
    // Clip nutzt 10–50 s der Quelle bei doppeltem Tempo.
    doc = must(trimClip(doc, video.id, 'start', 10 * S))
    doc = must(trimClip(doc, video.id, 'end', 50 * S))
    doc = must(setClipSpeed(doc, video.id, 2))
    const short = must(
      buildShortDoc(
        doc,
        video.id,
        [
          { start: 30, end: 34 },
          { start: 5, end: 12.5 }, // beginnt vor dem Clip: beschnitten auf 10 s
          { start: 70, end: 80 }, // ganz außerhalb: entfällt
        ],
        '9:16',
        { ids },
      ),
    )
    expect(validateDoc(short)).toEqual([])
    expect(short.settings).toMatchObject({ width: 1080, height: 1920, fps: 25 })
    expect(short.markers).toEqual([])
    expect(short.tracks.map((t) => [t.kind, t.name])).toEqual([
      ['video', 'V1'],
      ['audio', 'A1'],
    ])
    expect(brief(lane(short, 'video'))).toEqual([
      [0, 1.24, 10],
      [1.24, 2, 30],
    ])
    expect(brief(lane(short, 'audio'))).toEqual(brief(lane(short, 'video')))
    const v = lane(short, 'video') as VideoClip[]
    expect(v.every((c) => c.speed === 2 && c.crop?.width === 0.3164)).toBe(true)
    // Bild und Ton jeder Stelle sind verknüpft.
    const a = lane(short, 'audio')
    expect(v.map((c) => c.linkGroup)).toEqual(a.map((c) => c.linkGroup))
    expect(new Set(v.map((c) => c.linkGroup)).size).toBe(2)
    // Medien bleiben angemeldet.
    expect(Object.keys(short.assets)).toEqual(['a'])
  })

  it('buildShortDoc: Format beibehalten, vorhandener Zuschnitt bleibt; ohne Video abgelehnt', () => {
    let doc = putAsset(createDoc(), asset('a'))
    doc = must(appendMedia(doc, 'a'))
    const video = lane(doc, 'video')[0]
    const crop = { x: 0.1, y: 0.1, width: 0.5, height: 0.5 }
    doc = must(setClipCrop(doc, video.id, crop))
    const kept = must(buildShortDoc(doc, video.id, [{ start: 1, end: 3 }], 'keep', { ids }))
    expect(kept.settings).toEqual(doc.settings)
    expect((lane(kept, 'video')[0] as VideoClip).crop).toEqual(crop)

    let music = putAsset(createDoc(), { ...asset('m'), kind: 'audio', width: undefined })
    music = must(appendMedia(music, 'm'))
    const audio = lane(music, 'audio')[0]
    expect(buildShortDoc(music, audio.id, [{ start: 1, end: 3 }], '9:16')).toEqual({
      ok: false,
      error: 'kind-mismatch',
    })
    expect(buildShortDoc(doc, video.id, [{ start: 70, end: 80 }], '9:16')).toEqual({
      ok: false,
      error: 'too-short',
    })
  })

  it('parseHighlights prüft und sortiert', () => {
    expect(
      parseHighlights({
        highlights: [
          { start: 5, end: 9, title: 'B', reason: 'r', score: 12 },
          { start: 1, end: 2, title: 'A' },
          { start: 3, end: 3, title: 'leer' },
          'x',
        ],
      }),
    ).toEqual([
      { start: 1, end: 2, title: 'A', reason: '', score: 5 },
      { start: 5, end: 9, title: 'B', reason: 'r', score: 10 },
    ])
    expect(parseHighlights(null)).toEqual([])
  })
})

describe('Highlights im KI-Assistenten', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    jobs.calls = []
    jobs.results = {
      transcribe: { language: 'de', words: 100, text: '…' },
      highlights: {
        highlights: [
          { start: 2, end: 6, title: 'Der Einstieg', reason: 'Starker Satz', score: 8 },
          { start: 20, end: 30, title: 'Der Tipp', reason: 'Klarer Nutzen', score: 9 },
          { start: 55, end: 58, title: 'Außerhalb', reason: '', score: 7 },
        ],
      },
    }
  })

  function setup(): { videoId: string; audioId: string } {
    const timeline = useTimelineStore()
    timeline.putAsset(asset('a'))
    timeline.appendMedia('a')
    // Der Clip verwendet nur 0–40 s der Quelle.
    const audio = lane(timeline.doc, 'audio')[0]
    const video = lane(timeline.doc, 'video')[0]
    timeline.trimClip(audio.id, 'end', 40 * S)
    return { videoId: video.id, audioId: audio.id }
  }

  it('holt Highlights für den verwendeten Teil und spielt sie hintereinander ab', async () => {
    const { audioId, videoId } = setup()
    const timeline = useTimelineStore()
    const ai = useTimelineAiStore()
    expect(await ai.suggestHighlights(audioId, 'de', 45)).toBe(2)
    expect(jobs.calls.map((c) => c.action)).toEqual(['transcribe', 'highlights'])
    expect(jobs.calls[1].body).toEqual({ mediaId: 'a', target: 45, from: 0, to: 40 })
    expect([...ai.highlightMarks.clipIds].sort()).toEqual([audioId, videoId].sort())

    expect(ai.playHighlight(ai.highlights!.items[1].id)).toBe(true)
    expect(timeline.playhead).toBe(20 * S)
    expect(ai.audition?.stopAt).toBe(30 * S)
    expect(ai.skipRanges).toEqual([])

    ai.playAllHighlights()
    expect(ai.audition?.id).toBe(ALL_HIGHLIGHTS)
    expect(timeline.playhead).toBe(2 * S)
    expect(ai.skipRanges.map((r) => [r.start / S, r.end / S])).toEqual([[6, 20]])
    expect(ai.audition?.stopAt).toBe(30 * S)

    ai.setHighlightChecked(ai.highlights!.items[0].id, false)
    ai.playAllHighlights()
    expect(timeline.playhead).toBe(20 * S)
    expect(ai.skipRanges).toEqual([])
  })

  it('Ansicht: prüfen, Format wählen, übernehmen; Rückgängig holt die Timeline zurück', async () => {
    const { audioId } = setup()
    const timeline = useTimelineStore()
    const projects = useTimelineProjectStore()
    projects.current = { id: 'p1', name: 'Vortrag', savedAt: 1 }
    const before = timeline.doc
    timeline.select([audioId])
    const wrapper = mount(AiInspector, { global: { plugins: [i18n] } })
    await flushPromises()

    await wrapper.get('[data-testid=timeline-ai-highlights-find]').trigger('click')
    await flushPromises()
    const rows = wrapper.findAll('[data-testid=timeline-ai-highlights-list] li')
    expect(rows).toHaveLength(2)
    expect(rows[0].text()).toContain('Der Einstieg')
    expect(rows[0].text()).toContain('8/10')
    expect(rows[1].text()).toContain('00:20.000 – 00:30.000')
    expect(wrapper.get('[data-testid=timeline-ai-highlights-total]').text()).toContain(
      'Angehakt: 2, zusammen 00:14.000',
    )
    // Unter 30 s: Hinweis auf das Ziel.
    expect(wrapper.get('[data-testid=timeline-ai-highlights-total]').text()).toContain('30–60 s')

    await rows[0].get('input[type=checkbox]').setValue(false)
    expect(wrapper.get('[data-testid=timeline-ai-highlights-apply]').text()).toContain('(1)')
    await wrapper.get('[data-testid=timeline-ai-highlights-format]').setValue('1:1')
    await wrapper.get('[data-testid=timeline-ai-highlights-apply]').trigger('click')

    expect(timeline.doc.settings).toMatchObject({ width: 1080, height: 1080 })
    expect(brief(lane(timeline.doc, 'video'))).toEqual([[0, 10, 20]])
    expect(timeline.playhead).toBe(0)
    expect(projects.current).toBeNull()
    expect(projects.suggestedName).toBe('Vortrag – Short')
    expect(wrapper.get('[data-testid=timeline-ai-highlights-notice]').text()).toContain(
      'Kurzer Clip erstellt: 00:10.000, Stellen: 1.',
    )
    expect(timeline.undo()).toBe(true)
    expect(timeline.doc.tracks).toBe(before.tracks)
    expect(timeline.doc.settings).toEqual(before.settings)
  })

  it('Klick auf die grüne Markierung hakt an bzw. ab', async () => {
    const { audioId } = setup()
    const ai = useTimelineAiStore()
    await ai.suggestHighlights(audioId, 'de', 45)
    const timeline = useTimelineStore()
    const clip = lane(timeline.doc, 'video')[0]
    const wrapper = mount(TimelineClip, {
      props: { clip, zoom: 100, height: 40, selected: false },
      global: { plugins: [i18n] },
    })
    const marks = wrapper.findAll('[data-testid=clip-highlight-mark]')
    expect(marks).toHaveLength(2)
    await marks[1].trigger('click')
    expect(ai.highlights!.items.map((h) => h.checked)).toEqual([true, false])
  })
})
