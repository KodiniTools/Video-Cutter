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
import { parsePublishTexts } from '@/lib/aiApi'
import { useTimelineStore } from '@/stores/timeline'
import { useTimelineAiStore } from '@/stores/timelineAi'
import {
  applyChapterMarkers,
  chapterLines,
  descriptionText,
  speechSegments,
} from '@/timeline/publish'
import {
  addMarker,
  appendMedia,
  createDoc,
  putAsset,
  setClipSpeed,
  setMarkerEffect,
  updateTrack,
  type AssetRef,
  type OpResult,
  type TimelineDoc,
} from '@/timeline/model'

const S = 1_000_000
const video = (id: string, seconds = 60): AssetRef => ({
  id,
  kind: 'video',
  name: `${id}.mp4`,
  duration: seconds * S,
  width: 1920,
  height: 1080,
  fps: 25,
  hasAudio: true,
})
const music = (id: string): AssetRef => ({
  id,
  kind: 'audio',
  name: `${id}.mp3`,
  duration: 90 * S,
  hasAudio: true,
})
const must = (r: OpResult): TimelineDoc => {
  if (!r.ok) throw new Error(r.error)
  return r.doc
}
let n = 0
const ids = () => `p${++n}`

const RESULT = {
  titles: ['Schnitt leicht gemacht', 'Zweiter Titel'],
  description: 'Erster Absatz.\n\nZweiter Absatz.',
  hashtags: ['#Video', '#Schnitt'],
  chapters: [
    { at: 0, title: 'Einstieg' },
    { at: 20.5, title: 'Teil zwei' },
    { at: 70, title: 'Schluss' },
  ],
}

describe('Titel und Kapitel: reine Funktionen', () => {
  it('nimmt den Ton der Videos, Musik nur ohne Videos, stumme Spuren nie', () => {
    let doc = createDoc()
    doc = putAsset(putAsset(putAsset(doc, video('a')), video('b', 30)), music('m'))
    doc = must(appendMedia(doc, 'a', { ids }))
    doc = must(appendMedia(doc, 'b', { ids }))
    doc = must(appendMedia(doc, 'm', { ids }))
    const audioB = doc.tracks.find((t) => t.kind === 'audio')!.clips[1]
    doc = must(setClipSpeed(doc, audioB.id, 2))
    expect(speechSegments(doc)).toEqual([
      { mediaId: 'a', from: 0, to: 60, at: 0, speed: 1 },
      { mediaId: 'b', from: 0, to: 30, at: 60, speed: 2 },
    ])

    // Nur Musik (die Video-Spur ist stumm): dann zählt die Tondatei.
    const speech = doc.tracks.find((t) => t.kind === 'audio')!
    const muted = must(updateTrack(doc, speech.id, { muted: true }))
    expect(speechSegments(muted).map((s) => s.mediaId)).toEqual(['m'])
  })

  it('setzt Kapitel als Marker, ersetzt nur einfache Kapitel-Marker', () => {
    let doc = putAsset(createDoc({ fps: 25 }), video('a', 120))
    doc = must(appendMedia(doc, 'a', { ids }))
    doc = must(addMarker(doc, { id: 'alt', at: 5 * S, label: 'Alt' }))
    doc = must(addMarker(doc, { id: 'fx', at: 50 * S, label: 'Drop' }))
    doc = must(setMarkerEffect(doc, 'fx', { kind: 'flash' }))
    doc = must(addMarker(doc, { id: 'beat', at: 70 * S, beat: true }))
    doc = must(addMarker(doc, { id: 'same', at: 0, label: 'Start' }))

    const r = applyChapterMarkers(doc, RESULT.chapters, true)
    if (!r.ok) throw new Error(r.error)
    // „Alt“ und „Start“ weichen; Effekt- und Takt-Marker bleiben.
    expect(r.info).toEqual({ added: 3, renamed: 0, removed: 2 })
    expect(r.doc.markers.map((m) => [m.at / S, m.label, m.beat ?? false])).toEqual([
      [0, 'Einstieg', false],
      [20.52, 'Teil zwei', false], // aufs Bildraster (25 fps) gerundet
      [50, 'Drop', false],
      [70, '', true],
      [70.04, 'Schluss', false], // neben dem Takt-Marker, damit es ein Kapitel ist
    ])

    // Ohne Ersetzen bekommt ein Marker an derselben Stelle den Namen.
    const keep = applyChapterMarkers(doc, RESULT.chapters, false)
    if (!keep.ok) throw new Error(keep.error)
    expect(keep.info).toEqual({ added: 2, renamed: 1, removed: 0 })
    expect(keep.doc.markers.find((m) => m.id === 'same')?.label).toBe('Einstieg')
    expect(keep.doc.markers.find((m) => m.id === 'alt')?.label).toBe('Alt')
  })

  it('baut Kapitelliste und Text für die Beschreibung', () => {
    expect(chapterLines(RESULT.chapters)).toBe('0:00 Einstieg\n0:20 Teil zwei\n1:10 Schluss')
    expect(descriptionText(' Text. ', RESULT.chapters.slice(0, 1), ['#a', '#b'])).toBe(
      'Text.\n\n0:00 Einstieg\n\n#a #b',
    )
    expect(descriptionText('', [], [])).toBe('')
  })

  it('prüft die Serverantwort', () => {
    expect(
      parsePublishTexts({
        titles: ['A', '', 3],
        description: 'D',
        hashtags: ['x', '#y'],
        chapters: [{ at: 30, title: 'b' }, { at: -1 }, { at: 0, title: 'a' }],
      }),
    ).toEqual({
      titles: ['A'],
      description: 'D',
      hashtags: ['#x', '#y'],
      chapters: [
        { at: 0, title: 'a' },
        { at: 30, title: 'b' },
      ],
    })
    expect(parsePublishTexts(null)).toEqual({
      titles: [],
      description: '',
      hashtags: [],
      chapters: [],
    })
  })
})

describe('Titel und Kapitel im KI-Assistenten', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    jobs.calls = []
    jobs.results = { transcribe: { language: 'de', words: 3, text: 'a b c' }, publish: RESULT }
    n = 0
    i18n.global.locale.value = 'de'
  })

  it('transkribiert jedes Video einmal und schickt die Abschnitte der Timeline', async () => {
    const timeline = useTimelineStore()
    timeline.putAsset(video('a', 40))
    timeline.putAsset(video('b', 20))
    timeline.appendMedia('a')
    timeline.appendMedia('b')
    const ai = useTimelineAiStore()
    await ai.suggestPublish('de', 'en')
    expect(jobs.calls.map((c) => c.action)).toEqual(['transcribe', 'transcribe', 'publish'])
    expect(jobs.calls[2].body).toEqual({
      segments: [
        { mediaId: 'a', from: 0, to: 40, at: 0, speed: 1 },
        { mediaId: 'b', from: 0, to: 20, at: 40, speed: 1 },
      ],
      target: 'en',
      duration: 60,
    })
    expect(ai.publish?.titles[0]).toBe('Schnitt leicht gemacht')

    // Zweiter Durchlauf: Transkripte sind schon da.
    jobs.calls = []
    await ai.suggestPublish('de', 'original')
    expect(jobs.calls.map((c) => c.action)).toEqual(['publish'])
  })

  it('Ansicht: bearbeiten, kopieren und Kapitel als Marker übernehmen (ein Schritt)', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const timeline = useTimelineStore()
    timeline.putAsset(video('a', 90))
    timeline.appendMedia('a')
    const wrapper = mount(AiInspector, { global: { plugins: [i18n] } })
    await flushPromises()

    await wrapper.get('[data-testid=timeline-ai-publish-create]').trigger('click')
    await flushPromises()
    const titles = wrapper.findAll('[data-testid=timeline-ai-publish-titles] input')
    expect(titles.map((i) => (i.element as HTMLInputElement).value)).toEqual(RESULT.titles)
    await titles[0].setValue('Mein Titel')
    await wrapper.findAll('[data-testid=timeline-ai-publish-copy-title]')[0].trigger('click')
    await flushPromises()
    expect(writeText).toHaveBeenLastCalledWith('Mein Titel')

    const rows = wrapper.findAll('[data-testid=timeline-ai-publish-chapters] li')
    expect(rows.map((r) => r.get('button').text())).toEqual(['0:00', '0:20', '1:10'])
    await rows[1].get('input[type=text]').setValue('Hauptteil')
    await rows[2].get('input[type=checkbox]').setValue(false)
    // Nur zwei Kapitel angehakt: Hinweis auf die Regel bei YouTube.
    expect(wrapper.find('[data-testid=timeline-ai-publish-chapter-warn]').exists()).toBe(true)

    await wrapper.get('[data-testid=timeline-ai-publish-hashtags]').setValue('#Video tipps')
    await wrapper.get('[data-testid=timeline-ai-publish-copy-all]').trigger('click')
    await flushPromises()
    expect(writeText).toHaveBeenLastCalledWith(
      'Erster Absatz.\n\nZweiter Absatz.\n\n0:00 Einstieg\n0:20 Hauptteil\n\n#Video #tipps',
    )

    const before = timeline.doc
    await wrapper.get('[data-testid=timeline-ai-publish-apply]').trigger('click')
    expect(timeline.doc.markers.map((m) => m.label)).toEqual(['Einstieg', 'Hauptteil'])
    expect(wrapper.get('[data-testid=timeline-ai-publish-notice]').text()).toContain('2')
    timeline.undo()
    expect(timeline.doc).toEqual(before)
  })

  it('meldet eine Timeline ohne hörbaren Ton', async () => {
    const timeline = useTimelineStore()
    timeline.putAsset({ ...video('a'), hasAudio: false })
    timeline.appendMedia('a')
    const wrapper = mount(AiInspector, { global: { plugins: [i18n] } })
    await flushPromises()
    expect(wrapper.find('[data-testid=timeline-ai-publish-no-speech]').exists()).toBe(true)
    expect(wrapper.find('[data-testid=timeline-ai-publish-create]').exists()).toBe(false)
  })
})
