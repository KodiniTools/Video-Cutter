import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const api = vi.hoisted(() => ({
  result: null as unknown,
  error: null as Error | null,
  calls: [] as string[],
}))
vi.mock('@/lib/beatsApi', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/beatsApi')>()
  return {
    ...real,
    fetchBeats: (id: string) => {
      api.calls.push(id)
      return api.error ? Promise.reject(api.error) : Promise.resolve(api.result)
    },
  }
})
vi.mock('@/lib/mediaApi', () => ({
  UPLOAD_ABORTED: 'UPLOAD_ABORTED',
  uploadMedia: vi.fn(),
  deleteMedia: vi.fn(() => Promise.resolve()),
}))

import BeatPanel from '@/components/timeline/BeatPanel.vue'
import TimelineView from '@/components/timeline/TimelineView.vue'
import { i18n } from '@/i18n'
import { BEATS_UNSUPPORTED, parseBeatAnalysis, type BeatAnalysis } from '@/lib/beatsApi'
import { useTimelineStore } from '@/stores/timeline'
import { useTimelineBeatsStore } from '@/stores/timelineBeats'
import {
  addBeatMarkers,
  beatGridTimes,
  beatMarkerCount,
  fitClipsToBeats,
  removeBeatMarkers,
  splitClipsAtBeats,
} from '@/timeline/beats'
import { chapterList } from '@/timeline/markers'
import { buildTimelineProject, parseTimelineProject } from '@/timeline/projectFile'
import {
  addMarker,
  appendMedia,
  createDoc,
  MAX_MARKERS,
  putAsset,
  setMarkerEffect,
  trimClip,
  validateDoc,
  type AssetRef,
  type Clip,
  type OpResult,
  type TimelineDoc,
} from '@/timeline/model'

const S = 1_000_000
const ms = (n: number) => n * 1000
const must = (r: OpResult): TimelineDoc => {
  if (!r.ok) throw new Error(r.error)
  return r.doc
}
const video = (id: string, seconds: number): AssetRef => ({
  id,
  kind: 'video',
  name: `${id}.mp4`,
  duration: seconds * S,
  width: 1280,
  height: 720,
  fps: 25,
  hasAudio: true,
})
const music = (id: string, seconds: number): AssetRef => ({
  id,
  kind: 'audio',
  name: `${id}.mp3`,
  duration: seconds * S,
  hasAudio: true,
})
const lane = (doc: TimelineDoc, name: string): Clip[] => [
  ...(doc.tracks.find((t) => t.name === name)?.clips ?? []),
]
/** 120 BPM ab 0,5 s, Takt beginnt beim 2. erkannten Schlag (Index 1). */
const analysis: BeatAnalysis = {
  bpm: 120,
  beats: Array.from({ length: 20 }, (_, i) => 0.5 + i * 0.5),
  downbeat: 1,
}
const clip = { start: 0, duration: 20 * S, sourceIn: 0, speed: 1 }

describe('beatGridTimes', () => {
  it('jeder Schlag: Quellzeiten auf der Timeline', () => {
    const t = beatGridTimes(analysis, clip, { grid: 'beat', shift: 0, offset: 0 })
    expect(t.slice(0, 3)).toEqual([0.5 * S, 1 * S, 1.5 * S])
    expect(t).toHaveLength(20)
  })

  it('Takt und 2er-Raster richten sich nach dem Takt-Anfang, „Beginnt bei“ verschiebt', () => {
    expect(beatGridTimes(analysis, clip, { grid: 'bar', shift: 0, offset: 0 })).toEqual([
      1 * S,
      3 * S,
      5 * S,
      7 * S,
      9 * S,
    ])
    expect(beatGridTimes(analysis, clip, { grid: 'bar', shift: 2, offset: 0 })[0]).toBe(2 * S)
    expect(beatGridTimes(analysis, clip, { grid: 'two', shift: 0, offset: 0 })[0]).toBe(1 * S)
    expect(beatGridTimes(analysis, clip, { grid: 'twoBars', shift: 0, offset: 0 })).toEqual([
      1 * S,
      5 * S,
      9 * S,
    ])
    // Zu große Verschiebung wird begrenzt.
    expect(beatGridTimes(analysis, clip, { grid: 'bar', shift: 9, offset: 0 })[0]).toBe(0.5 * S)
  })

  it('halbe Schläge: Punkte dazwischen', () => {
    const t = beatGridTimes(analysis, clip, { grid: 'half', shift: 0, offset: 0 })
    expect(t.slice(0, 4)).toEqual([0.5 * S, 0.75 * S, 1 * S, 1.25 * S])
    expect(t).toHaveLength(39)
  })

  it('rechnet Beginn, Quell-Anfang und Tempo des Clips um, nur innerhalb des Clips', () => {
    // Clip ab 10 s auf der Timeline, Quelle ab 2 s, doppelt so schnell, 3 s lang.
    const t = beatGridTimes(
      analysis,
      { start: 10 * S, duration: 3 * S, sourceIn: 2 * S, speed: 2 },
      { grid: 'beat', shift: 0, offset: 0 },
    )
    // Quelle 2 s … 8 s -> Schläge 2,0 … 7,5 s -> Timeline 10 + (b − 2) / 2.
    expect(t[0]).toBe(10 * S)
    expect(t[1]).toBe(10.25 * S)
    expect(t[t.length - 1]).toBe(12.75 * S)
  })

  it('Verschiebung in µs (begrenzt) und Runden auf Bilder', () => {
    const t = beatGridTimes(analysis, clip, { grid: 'beat', shift: 0, offset: ms(-30) })
    expect(t[0]).toBe(0.47 * S)
    const f = beatGridTimes(analysis, clip, { grid: 'beat', shift: 0, offset: ms(13) }, 25)
    expect(f[0]).toBe(0.52 * S)
    const capped = beatGridTimes(analysis, clip, { grid: 'beat', shift: 0, offset: -S })
    expect(capped[0]).toBe(0.25 * S)
  })

  it('ohne Schläge leer', () => {
    expect(
      beatGridTimes({ bpm: 0, beats: [], downbeat: 0 }, clip, {
        grid: 'beat',
        shift: 0,
        offset: 0,
      }),
    ).toEqual([])
  })
})

describe('parseBeatAnalysis', () => {
  it('verwirft Unbrauchbares', () => {
    expect(parseBeatAnalysis({ bpm: 128, beats: [1, 0.5, 2, 'x', 3], downbeat: 2 })).toEqual({
      bpm: 128,
      beats: [1, 2, 3],
      downbeat: 2,
    })
    expect(parseBeatAnalysis(null)).toEqual({ bpm: 0, beats: [], downbeat: 0 })
    expect(parseBeatAnalysis({ bpm: -1, beats: [], downbeat: 7 })).toEqual({
      bpm: 0,
      beats: [],
      downbeat: 0,
    })
  })
})

describe('Takt-Marker', () => {
  it('setzt Marker ohne Namen mit Kennzeichen, optional mit Drop-Effekt', () => {
    let doc = must(addMarker(createDoc(), { id: 'k', at: 2 * S, label: 'Refrain' }))
    const r = addBeatMarkers(doc, [1 * S, 2 * S, 3 * S], { effect: 'flash' })
    if (!r.ok) throw new Error(r.error)
    expect(r.info).toEqual({ added: 2, dropped: 0 })
    doc = r.doc
    const beats = doc.markers.filter((m) => m.beat)
    expect(beats.map((m) => m.at)).toEqual([1 * S, 3 * S])
    expect(beats.every((m) => m.label === '' && m.effect?.kind === 'flash')).toBe(true)
    // Der vorhandene Marker bleibt, wie er ist.
    expect(doc.markers.find((m) => m.id === 'k')).toEqual({ id: 'k', at: 2 * S, label: 'Refrain' })
    expect(beatMarkerCount(doc)).toBe(2)
    // Kapitel: nur der echte Marker.
    expect(chapterList(doc.markers)).toBe('0:02 Refrain')
    // Effekt ändern behält das Kennzeichen; Speichern und Laden auch.
    doc = must(setMarkerEffect(doc, beats[0].id, { kind: 'burst' }))
    expect(doc.markers.find((m) => m.id === beats[0].id)?.beat).toBe(true)
    const loaded = parseTimelineProject(
      JSON.parse(JSON.stringify(buildTimelineProject(doc, {}))),
    ).doc
    expect(loaded.markers.filter((m) => m.beat)).toHaveLength(2)
    expect(validateDoc(loaded)).toEqual([])
  })

  it('höchstens MAX_MARKERS, der Rest zählt als nicht gesetzt', () => {
    const times = Array.from({ length: MAX_MARKERS + 5 }, (_, i) => (i + 1) * S)
    const r = addBeatMarkers(createDoc(), times)
    if (!r.ok) throw new Error(r.error)
    expect(r.info).toEqual({ added: MAX_MARKERS, dropped: 5 })
  })

  it('entfernt nur Takt-Marker', () => {
    let doc = must(addMarker(createDoc(), { id: 'k', at: 2 * S, label: 'Refrain' }))
    const r = addBeatMarkers(doc, [1 * S, 3 * S])
    if (!r.ok) throw new Error(r.error)
    const removed = removeBeatMarkers(r.doc)
    if (!removed.ok) throw new Error(removed.error)
    expect(removed.info.removed).toBe(2)
    doc = removed.doc
    expect(doc.markers.map((m) => m.id)).toEqual(['k'])
  })
})

/** Drei Videos (je 10 s Quelle) hintereinander auf V1 (mit Ton A1), gekürzt auf 1,3 / 2,2 / 0,9 s. */
function threeClips(): TimelineDoc {
  let n = 0
  const ids = () => `id${++n}`
  let doc = createDoc()
  for (const id of ['a', 'b', 'c']) {
    doc = putAsset(doc, video(id, 10))
    doc = must(appendMedia(doc, id, { ids }))
  }
  // Längen 1,3 / 2,2 / 0,9 s, lückenlos.
  const lengths = [1.3, 2.2, 0.9]
  let at = 0
  for (const [i, c] of lane(doc, 'V1').entries()) {
    const linked = doc.tracks
      .flatMap((t) => t.clips as Clip[])
      .filter((x) => x.linkGroup === c.linkGroup)
    for (const x of linked) doc = must(trimClip(doc, x.id, 'end', x.start + lengths[i] * S))
    at += lengths[i]
    void at
  }
  // Nachrücken: zweiter und dritter Clip schließen an.
  const v = lane(doc, 'V1')
  const shiftTo = (clipStart: number, to: number) => {
    const ids = doc.tracks
      .flatMap((t) => t.clips as Clip[])
      .filter((x) => x.start === clipStart)
      .map((x) => x.id)
    doc = {
      ...doc,
      tracks: doc.tracks.map((t) => ({
        ...t,
        clips: (t.clips as Clip[]).map((x) => (ids.includes(x.id) ? { ...x, start: to } : x)),
      })) as TimelineDoc['tracks'],
    }
  }
  shiftTo(v[1].start, 1.3 * S)
  shiftTo(v[2].start, 3.5 * S)
  expect(validateDoc(doc)).toEqual([])
  return doc
}

describe('fitClipsToBeats', () => {
  it('legt jedes Clip-Ende auf den nächsten Rasterpunkt, Ton folgt, Folgeclips rücken nach', () => {
    const doc = threeClips()
    const grid = [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5].map((x) => x * S)
    const r = fitClipsToBeats(doc, doc.tracks.find((t) => t.name === 'V1')!.id, grid)
    if (!r.ok) throw new Error(r.error)
    expect(r.info).toEqual({ fitted: 3, unchanged: 0 })
    const v = lane(r.doc, 'V1').map((c) => [c.start / S, (c.start + c.duration) / S])
    // 1,3 -> 1,5; 2,2 lang ab 1,5 = 3,7 -> 3,5; 0,9 lang ab 3,5 = 4,4 -> 4,5.
    expect(v).toEqual([
      [0, 1.5],
      [1.5, 3.5],
      [3.5, 4.5],
    ])
    const a = lane(r.doc, 'A1').map((c) => [c.start / S, (c.start + c.duration) / S])
    expect(a).toEqual(v)
    expect(validateDoc(r.doc)).toEqual([])
  })

  it('Musik und Marker bleiben stehen, Lücken bleiben gleich lang', () => {
    let doc = threeClips()
    doc = putAsset(doc, music('m', 30))
    doc = must(appendMedia(doc, 'm'))
    doc = must(addMarker(doc, { id: 'mk', at: 4 * S }))
    // Lücke von 0,5 s vor dem dritten Clip.
    const third = lane(doc, 'V1')[2]
    doc = {
      ...doc,
      tracks: doc.tracks.map((t) => ({
        ...t,
        clips: (t.clips as Clip[]).map((x) =>
          x.linkGroup === third.linkGroup ? { ...x, start: x.start + 0.5 * S } : x,
        ),
      })) as TimelineDoc['tracks'],
    }
    const musicBefore = doc.tracks.find((t) => t.kind === 'audio' && t.name !== 'A1')!
    const grid = Array.from({ length: 20 }, (_, i) => (i + 1) * 0.5 * S)
    const r = fitClipsToBeats(doc, doc.tracks.find((t) => t.name === 'V1')!.id, grid)
    if (!r.ok) throw new Error(r.error)
    const v = lane(r.doc, 'V1')
    // Zweiter Clip endet bei 3,5; Lücke 0,5 -> dritter beginnt bei 4,0.
    expect(v[2].start).toBe(4 * S)
    expect(r.doc.tracks.find((t) => t.id === musicBefore.id)).toBe(musicBefore)
    expect(r.doc.markers).toEqual(doc.markers)
  })

  it('verlängert nur, soweit die Quelle reicht; sonst kürzer', () => {
    let doc = createDoc()
    doc = putAsset(doc, video('a', 1.2))
    doc = must(appendMedia(doc, 'a'))
    const v1 = doc.tracks.find((t) => t.name === 'V1')!.id
    // Nächster Punkt wäre 1,5 (Quelle nur 1,2 s) -> 1,0.
    const r = fitClipsToBeats(doc, v1, [1 * S, 1.5 * S])
    if (!r.ok) throw new Error(r.error)
    expect(lane(r.doc, 'V1')[0].duration).toBe(1 * S)
  })

  it('ohne passende Punkte bleibt alles, gesperrte Spur wird abgelehnt', () => {
    const doc = threeClips()
    const v1 = doc.tracks.find((t) => t.name === 'V1')!
    const same = fitClipsToBeats(doc, v1.id, [])
    expect(same.ok && same.doc).toBe(doc)
    const locked = {
      ...doc,
      tracks: doc.tracks.map((t) => (t.id === v1.id ? { ...t, locked: true } : t)),
    } as TimelineDoc
    expect(fitClipsToBeats(locked, v1.id, [1 * S])).toEqual({ ok: false, error: 'track-locked' })
  })
})

describe('splitClipsAtBeats', () => {
  it('teilt an jedem Punkt innerhalb eines Clips, Ton wird mitgeteilt', () => {
    const doc = threeClips()
    const v1 = doc.tracks.find((t) => t.name === 'V1')!.id
    const r = splitClipsAtBeats(
      doc,
      v1,
      [0.5, 1, 1.3, 2, 9].map((x) => x * S),
    )
    if (!r.ok) throw new Error(r.error)
    // 1,3 ist schon ein Schnitt, 9 liegt hinter allen Clips.
    expect(r.info.cuts).toBe(3)
    expect(lane(r.doc, 'V1')).toHaveLength(6)
    expect(lane(r.doc, 'A1')).toHaveLength(6)
    expect(validateDoc(r.doc)).toEqual([])
  })
})

describe('BeatPanel', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    api.result = analysis
    api.error = null
    api.calls = []
  })

  function setup() {
    const store = useTimelineStore()
    let doc = threeClips()
    doc = putAsset(doc, music('m', 30))
    doc = must(appendMedia(doc, 'm'))
    store.load(doc)
    const musicClip = doc.tracks.find((t) => t.kind === 'audio' && t.name !== 'A1')!.clips[0]
    const wrapper = mount(BeatPanel, { global: { plugins: [i18n] } })
    return { store, wrapper, musicClip }
  }

  it('ohne passenden markierten Clip unsichtbar', () => {
    const { wrapper } = setup()
    expect(wrapper.find('[data-testid="beat-panel"]').exists()).toBe(false)
  })

  it('erkennt den Takt, zeigt Raster und übernimmt als Marker und Schnitte', async () => {
    const { store, wrapper, musicClip } = setup()
    const beats = useTimelineBeatsStore()
    store.select([musicClip.id])
    await flushPromises()
    await wrapper.get('[data-testid="beat-detect"]').trigger('click')
    await flushPromises()
    expect(api.calls).toEqual(['m'])
    expect(wrapper.get('[data-testid="beat-result"]').text()).toContain('120')
    expect(beats.times).toHaveLength(20)
    // Raster wird Einrastpunkt.
    expect(store.snapGuides).toHaveLength(20)

    await wrapper.get('[data-testid="beat-grid"]').setValue('bar')
    expect(beats.times).toEqual([1, 3, 5, 7, 9].map((x) => x * S))

    await wrapper.get('[data-testid="beat-effect"]').setValue('flash')
    await wrapper.get('[data-testid="beat-apply-markers"]').trigger('click')
    expect(store.doc.markers.filter((m) => m.beat)).toHaveLength(5)
    expect(store.doc.markers.every((m) => m.effect?.kind === 'flash')).toBe(true)
    expect(wrapper.get('[data-testid="beat-note"]').text()).toContain('5')

    await wrapper.get('[data-testid="beat-grid"]').setValue('two')
    await wrapper.get('[data-testid="beat-fit"]').trigger('click')
    const v = store.doc.tracks.find((t) => t.name === 'V1')!.clips
    // Raster 1, 2, 3 … s: 1,3 -> 1; 2,2 lang ab 1 = 3,2 -> 3; 0,9 lang ab 3 = 3,9 -> 4.
    expect(v.map((c) => (c.start + c.duration) / S)).toEqual([1, 3, 4])
    // Ein Rückgängig-Schritt je Übernahme.
    store.undo()
    expect(store.doc.tracks.find((t) => t.name === 'V1')!.clips[0].duration).toBe(1.3 * S)

    await wrapper.get('[data-testid="beat-remove-markers"]').trigger('click')
    expect(store.doc.markers).toHaveLength(0)

    await wrapper.get('[data-testid="beat-show"]').setValue(false)
    expect(store.snapGuides).toEqual([])
    await wrapper.get('[data-testid="beat-clear"]').trigger('click')
    expect(beats.analysis).toBeNull()
  })

  it('veraltetes Backend: verständliche Meldung', async () => {
    api.error = new Error(BEATS_UNSUPPORTED)
    const { store, wrapper, musicClip } = setup()
    store.select([musicClip.id])
    await flushPromises()
    await wrapper.get('[data-testid="beat-detect"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="beat-error"]').text()).toContain('Backend')
  })

  it('kein Takt gefunden', async () => {
    api.result = { bpm: 0, beats: [], downbeat: 0 }
    const { store, wrapper, musicClip } = setup()
    store.select([musicClip.id])
    await flushPromises()
    await wrapper.get('[data-testid="beat-detect"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="beat-none"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="beat-apply-markers"]').exists()).toBe(false)
  })
})

describe('TimelineView: Takt-Raster', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('zeichnet Linien für die sichtbaren Rasterpunkte', async () => {
    const store = useTimelineStore()
    let doc = putAsset(createDoc(), music('m', 30))
    doc = must(appendMedia(doc, 'm'))
    store.load(doc)
    const wrapper = mount(TimelineView, { global: { plugins: [i18n] }, attachTo: document.body })
    const beats = useTimelineBeatsStore()
    beats.clipId = doc.tracks[0].clips[0].id
    beats.analysis = analysis
    await flushPromises()
    expect(wrapper.findAll('[data-testid="timeline-beat-line"]').length).toBeGreaterThan(0)
    beats.showGrid = false
    await flushPromises()
    expect(wrapper.findAll('[data-testid="timeline-beat-line"]')).toHaveLength(0)
    wrapper.unmount()
  })
})
