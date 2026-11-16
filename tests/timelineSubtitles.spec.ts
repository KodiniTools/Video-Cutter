import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const jobs = vi.hoisted(() => ({
  calls: [] as { action: string; body: Record<string, unknown> }[],
  results: {} as Record<string, unknown>,
  fail: {} as Record<string, string[]>,
}))
vi.mock('@/lib/aiApi', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/aiApi')>()
  return {
    ...real,
    fetchAiStatus: () => Promise.resolve({ transcribe: true, claude: true, image: false }),
    runAiJob: (action: string, body: Record<string, unknown>, parse: (d: unknown) => unknown) => {
      jobs.calls.push({ action, body })
      const error = jobs.fail[action]?.shift()
      return {
        promise: error
          ? Promise.reject(new Error(error))
          : Promise.resolve().then(() => parse(jobs.results[action])),
        cancel: () => {},
      }
    },
  }
})

import { useTimelineStore } from '@/stores/timeline'
import { useTimelineAiStore } from '@/stores/timelineAi'
import {
  createDoc,
  insertOverlayClips,
  updateTrack,
  validateDoc,
  type AssetRef,
  type AudioClip,
  type Clip,
  type OpResult,
  type OverlayClip,
  type TimelineDoc,
} from '@/timeline/model'
import { cuesToClips, subtitleStyle, SUBTITLE_STYLE } from '@/timeline/subtitles'

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
const lane = (doc: TimelineDoc, kind: string): Clip[] =>
  doc.tracks.filter((t) => t.kind === kind).flatMap((t) => t.clips as Clip[])
const texts = (doc: TimelineDoc) =>
  (lane(doc, 'overlay') as OverlayClip[]).map((c) => [c.start / S, c.duration / S, c.data.text])
let n = 0
const ids = () => `t${++n}`
const text = (start: number, duration: number, label = 'x'): OverlayClip => ({
  id: ids(),
  kind: 'text',
  start: start * S,
  duration: duration * S,
  data: { ...SUBTITLE_STYLE, text: label },
})

describe('cuesToClips', () => {
  const clip = (over: Partial<AudioClip> = {}): AudioClip => ({
    id: 'a',
    kind: 'audio',
    asset: 'a',
    start: 4 * S,
    duration: 4 * S,
    sourceIn: 2 * S,
    speed: 1,
    gain: 1,
    ...over,
  })

  it('rechnet Quellzeiten auf die Timeline um und begrenzt auf den Clip', () => {
    const out = cuesToClips(
      clip(),
      [
        { start: 0.5, end: 1.5, text: 'davor' },
        { start: 1.5, end: 3, text: ' Rand vorn ' },
        { start: 3, end: 4, text: 'mitte' },
        { start: 5.5, end: 8, text: 'Rand hinten' },
        { start: 9, end: 10, text: 'danach' },
        { start: 4.2, end: 4.3, text: 'zu kurz' },
        { start: 4.5, end: 5, text: '   ' },
      ],
      25,
      SUBTITLE_STYLE,
      ids,
    )
    expect(out.map((c) => [c.start / S, c.duration / S, c.data.text])).toEqual([
      [4, 1, 'Rand vorn'],
      [5, 1, 'mitte'],
      [7.52, 0.48, 'Rand hinten'],
    ])
    expect(out[0]).toMatchObject({ kind: 'text', data: { animation: 'none', font: 'roboto' } })
  })

  it('beachtet das Tempo und lässt Texte nie überlappen', () => {
    // 2×: 8 s Quelle (2–10 s) liegen auf 4 s Timeline.
    const out = cuesToClips(
      clip({ speed: 2 }),
      [
        { start: 4, end: 6, text: 'eins' },
        { start: 5, end: 8, text: 'zwei' },
      ],
      25,
      SUBTITLE_STYLE,
      ids,
    )
    expect(out.map((c) => [c.start / S, c.duration / S, c.data.text])).toEqual([
      [5, 1, 'eins'],
      [6, 1, 'zwei'],
    ])
  })

  it('subtitleStyle übernimmt das Design des letzten Textes', () => {
    let doc = createDoc()
    expect(subtitleStyle(doc)).toEqual(SUBTITLE_STYLE)
    const styled = text(0, 1)
    styled.data = { ...styled.data, color: '#ff0000', size: 0.1, text: 'alt' }
    doc = must(insertOverlayClips(doc, [styled], 'T1'))
    expect(subtitleStyle(doc)).toMatchObject({ color: '#ff0000', size: 0.1, animation: 'none' })
    expect(subtitleStyle(doc).text).toBeUndefined()
  })
})

describe('insertOverlayClips', () => {
  it('legt alle Clips auf eine Spur: eine freie, sonst eine neue ganz oben', () => {
    let doc = must(insertOverlayClips(createDoc(), [text(0, 1), text(2, 1)], 'T1'))
    expect(doc.tracks.filter((t) => t.kind === 'overlay')).toHaveLength(1)
    // Passt daneben: gleiche Spur.
    doc = must(insertOverlayClips(doc, [text(1, 1), text(4, 1)], 'T2'))
    expect(doc.tracks.filter((t) => t.kind === 'overlay')).toHaveLength(1)
    // Einer überschneidet sich: alle auf eine neue Spur oben.
    doc = must(insertOverlayClips(doc, [text(0.5, 1), text(6, 1)], 'T2'))
    expect(doc.tracks.map((t) => [t.kind, t.name, t.clips.length]).slice(0, 2)).toEqual([
      ['overlay', 'T2', 2],
      ['overlay', 'T1', 4],
    ])
    expect(validateDoc(doc)).toEqual([])
    expect(must(insertOverlayClips(doc, [], 'T3'))).toBe(doc)
    // Überschneiden sich die neuen Clips untereinander, wird nichts eingefügt.
    const r = insertOverlayClips(doc, [text(10, 2), text(11, 2)], 'T3')
    expect(r.ok ? null : r.error).toBe('overlap')
  })
})

describe('KI-Assistent im Timeline-Editor', () => {
  const cues = [
    { start: 0, end: 2, text: 'Hallo' },
    { start: 2, end: 5, text: 'Welt' },
  ]
  beforeEach(() => {
    setActivePinia(createPinia())
    jobs.calls.length = 0
    jobs.fail = {}
    jobs.results = {
      transcribe: { language: 'de', words: 2, text: 'Hallo Welt' },
      subtitles: { cues, truncated: false },
    }
  })
  const setup = () => {
    const store = useTimelineStore()
    store.putAsset(asset('a'))
    store.appendMedia('a')
    const audio = lane(store.doc, 'audio')[0]
    return { store, ai: useTimelineAiStore(), audio }
  }

  it('erkennt die Sprache einmal je Medium und fügt Untertitel als einen Schritt ein', async () => {
    const { store, ai, audio } = setup()
    expect(await ai.makeSubtitles(audio.id, 'auto', 'original')).toEqual({
      added: 2,
      dropped: 0,
      truncated: false,
    })
    expect(jobs.calls.map((c) => c.action)).toEqual(['transcribe', 'subtitles'])
    expect(jobs.calls[0].body).toEqual({ mediaId: 'a', language: 'auto' })
    expect(texts(store.doc)).toEqual([
      [0, 2, 'Hallo'],
      [2, 3, 'Welt'],
    ])
    expect(ai.running).toBe(false)
    // Zweiter Lauf: kein neues Transkript; die Texte kommen auf eine eigene Spur.
    await ai.makeSubtitles(audio.id, 'auto', 'en')
    expect(jobs.calls.map((c) => c.action)).toEqual(['transcribe', 'subtitles', 'subtitles'])
    expect(store.doc.tracks.filter((t) => t.kind === 'overlay')).toHaveLength(2)
    store.undo()
    expect(texts(store.doc)).toHaveLength(2)
    store.undo()
    expect(texts(store.doc)).toHaveLength(0)
    // Andere Sprache: neu erkennen.
    await ai.makeSubtitles(audio.id, 'hr', 'original')
    expect(jobs.calls.slice(3).map((c) => c.action)).toEqual(['transcribe', 'subtitles'])
  })

  it('erkennt neu, wenn der Server das Transkript nicht mehr hat, und meldet Fehler', async () => {
    const { store, ai, audio } = setup()
    await ai.makeSubtitles(audio.id, 'de', 'original')
    jobs.calls.length = 0
    jobs.fail = { subtitles: ['Bitte das Video zuerst transkribieren.'] }
    await ai.makeSubtitles(audio.id, 'de', 'original')
    expect(jobs.calls.map((c) => c.action)).toEqual(['subtitles', 'transcribe', 'subtitles'])
    jobs.fail = { transcribe: ['kaputt'] }
    await expect(ai.makeSubtitles(audio.id, 'en', 'original')).rejects.toThrow('kaputt')
    expect(ai.running).toBe(false)
    await expect(ai.makeSubtitles('nope', 'en', 'original')).rejects.toThrow()
    expect(store.lastError).toBeNull()
  })

  it('rechnet mit dem Stand des Clips nach dem Auftrag (Tempo geändert)', async () => {
    const { store, ai, audio } = setup()
    const pending = ai.makeSubtitles(audio.id, 'de', 'original')
    expect(store.setClipSpeed(audio.id, 2, { ripple: true })).toBe(true)
    await pending
    expect(texts(store.doc)).toEqual([
      [0, 1, 'Hallo'],
      [1, 1.52, 'Welt'],
    ])
  })

  it('übersetzt alle Texte auf nicht gesperrten Spuren in einem Schritt', async () => {
    const { store, ai } = setup()
    store.addOverlayClips([text(0, 1, 'Hallo'), text(2, 1, 'Welt')])
    store.addOverlayClips([text(0, 1, 'gesperrt')])
    const locked = store.doc.tracks[0]
    store.apply((d) => updateTrack(d, locked.id, { locked: true }))
    expect(ai.textClips.map((c) => c.data.text)).toEqual(['Hallo', 'Welt'])
    jobs.results.translate = { texts: ['Hello', 'Welt'], missing: 1 }
    expect(await ai.translateTexts('en')).toEqual({ translated: 1, missing: 1 })
    expect(jobs.calls.at(-1)).toEqual({
      action: 'translate',
      body: { texts: ['Hallo', 'Welt'], target: 'en' },
    })
    expect(
      texts(store.doc)
        .map((r) => r[2])
        .sort(),
    ).toEqual(['Hello', 'Welt', 'gesperrt'])
    store.undo()
    expect(
      texts(store.doc)
        .map((r) => r[2])
        .sort(),
    ).toEqual(['Hallo', 'Welt', 'gesperrt'])
  })
})
