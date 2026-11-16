import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useTimelineStore } from '@/stores/timeline'
import {
  appendMedia,
  createDoc,
  findClip,
  putAsset,
  setClipGain,
  setClipSpeed,
  updateTrack,
  validateDoc,
  type AssetRef,
  type Clip,
  type OpResult,
  type TimelineDoc,
} from '@/timeline/model'

const S = 1_000_000
const asset = (id: string, seconds = 10, hasAudio = true): AssetRef => ({
  id,
  kind: 'video',
  name: `${id}.mp4`,
  duration: seconds * S,
  width: 1280,
  height: 720,
  fps: 25,
  hasAudio,
})
const must = (r: OpResult): TimelineDoc => {
  if (!r.ok) throw new Error(r.error)
  return r.doc
}
/** Zwei Videos (je 10 s) hintereinander, Bild auf V1, Ton auf A1. */
function twoClips(): TimelineDoc {
  let doc = putAsset(putAsset(createDoc(), asset('a')), asset('b'))
  doc = must(appendMedia(doc, 'a'))
  return must(appendMedia(doc, 'b'))
}
const lane = (doc: TimelineDoc, kind: string): Clip[] => [
  ...(doc.tracks.find((t) => t.kind === kind)?.clips ?? []),
]
const brief = (list: Clip[]) =>
  list.map((c) => [c.start / S, c.duration / S, 'speed' in c ? c.speed : null])
const error = (r: OpResult) => (r.ok ? null : r.error)

describe('setClipSpeed', () => {
  it('ändert Bild und verknüpften Ton gemeinsam; die Quelle bleibt', () => {
    const doc = twoClips()
    const [second] = lane(doc, 'video').slice(1)
    const next = must(setClipSpeed(doc, second.id, 2))
    expect(brief(lane(next, 'video'))).toEqual([
      [0, 10, 1],
      [10, 5, 2],
    ])
    expect(brief(lane(next, 'audio'))).toEqual(brief(lane(next, 'video')))
    expect(validateDoc(next)).toEqual([])
    // Eingabe unverändert; gleiches Tempo = gleiches Dokument.
    expect(brief(lane(doc, 'video'))[1]).toEqual([10, 10, 1])
    expect(must(setClipSpeed(next, second.id, 2))).toBe(next)
    // Zurück auf normal: wieder die ganze Länge.
    expect(brief(lane(must(setClipSpeed(next, second.id, 1)), 'video'))[1]).toEqual([10, 10, 1])
  })

  it('nur dieser Clip mit linked: false', () => {
    const doc = twoClips()
    const [first] = lane(doc, 'video')
    const next = must(setClipSpeed(doc, first.id, 2, { linked: false }))
    expect(brief(lane(next, 'video'))[0]).toEqual([0, 5, 2])
    expect(brief(lane(next, 'audio'))[0]).toEqual([0, 10, 1])
  })

  it('langsamer ohne Platz wird abgelehnt, mit ripple rückt Späteres nach hinten', () => {
    const doc = twoClips()
    const [first] = lane(doc, 'video')
    expect(error(setClipSpeed(doc, first.id, 0.5))).toBe('overlap')
    const next = must(setClipSpeed(doc, first.id, 0.5, { ripple: true }))
    expect(brief(lane(next, 'video'))).toEqual([
      [0, 20, 0.5],
      [20, 10, 1],
    ])
    expect(brief(lane(next, 'audio'))).toEqual(brief(lane(next, 'video')))
    expect(validateDoc(next)).toEqual([])
  })

  it('schneller mit ripple schließt die Lücke, ohne bleibt sie', () => {
    const doc = twoClips()
    const [first] = lane(doc, 'video')
    expect(brief(lane(must(setClipSpeed(doc, first.id, 2)), 'video'))).toEqual([
      [0, 5, 2],
      [10, 10, 1],
    ])
    const next = must(setClipSpeed(doc, first.id, 2, { ripple: true }))
    expect(brief(lane(next, 'video'))).toEqual([
      [0, 5, 2],
      [5, 10, 1],
    ])
    expect(brief(lane(next, 'audio'))).toEqual(brief(lane(next, 'video')))
  })

  it('gesperrte Spur, falsche Art, Grenzen', () => {
    const doc = twoClips()
    const [first] = lane(doc, 'video')
    expect(error(setClipSpeed(doc, 'gibt-es-nicht', 2))).toBe('clip-not-found')
    expect(error(setClipSpeed(doc, first.id, 0.1))).toBe('invalid-time')
    expect(error(setClipSpeed(doc, first.id, 5))).toBe('invalid-time')
    const audioTrack = doc.tracks.find((t) => t.kind === 'audio')!
    const locked = must(updateTrack(doc, audioTrack.id, { locked: true }))
    expect(error(setClipSpeed(locked, first.id, 2))).toBe('track-locked')
    // Gesperrte Spur bleibt beim Mitverschieben stehen (nur dieser Clip, Bildspur).
    const alone = must(setClipSpeed(locked, first.id, 2, { linked: false, ripple: true }))
    expect(brief(lane(alone, 'video'))[1]).toEqual([5, 10, 1])
    expect(brief(lane(alone, 'audio'))[1]).toEqual([10, 10, 1])
  })

  it('krumme Faktoren verbrauchen nie mehr Quelle als vorhanden', () => {
    let doc = putAsset(createDoc(), asset('a', 7.777))
    doc = must(appendMedia(doc, 'a'))
    const [clip] = lane(doc, 'video')
    for (const speed of [1 / 3.5, 1.5, 3.5, 1 / 1.5, 1]) {
      doc = must(setClipSpeed(doc, clip.id, speed, { ripple: true }))
      expect(validateDoc(doc)).toEqual([])
    }
    // Rundung kostet höchstens ein paar Mikrosekunden.
    expect(Math.abs(findClip(doc, clip.id)!.clip.duration - 7_777_000)).toBeLessThan(20)
  })
})

describe('setClipGain', () => {
  it('ändert nur Ton-Clips und begrenzt auf 0 bis 2', () => {
    const doc = twoClips()
    const [video] = lane(doc, 'video')
    const [audio] = lane(doc, 'audio')
    const gain = (d: TimelineDoc) => (findClip(d, audio.id)!.clip as { gain: number }).gain
    expect(gain(must(setClipGain(doc, audio.id, 0.5)))).toBe(0.5)
    expect(gain(must(setClipGain(doc, audio.id, 9)))).toBe(2)
    expect(gain(must(setClipGain(doc, audio.id, -1)))).toBe(0)
    expect(must(setClipGain(doc, audio.id, 1))).toBe(doc)
    expect(error(setClipGain(doc, video.id, 0.5))).toBe('kind-mismatch')
    expect(error(setClipGain(doc, audio.id, Number.NaN))).toBe('invalid-settings')
  })
})

describe('Store', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('Tempo ist ein Rückgängig-Schritt, ein gezogener Lautstärke-Regler auch', () => {
    const store = useTimelineStore()
    store.putAsset(asset('a'))
    store.appendMedia('a')
    const [video] = lane(store.doc, 'video')
    const [audio] = lane(store.doc, 'audio')
    expect(store.setClipSpeed(video.id, 2, { ripple: true })).toBe(true)
    expect(brief(lane(store.doc, 'audio'))).toEqual([[0, 5, 2]])
    store.beginGesture()
    for (const g of [0.9, 0.7, 0.5]) store.setClipGain(audio.id, g)
    store.endGesture()
    expect((lane(store.doc, 'audio')[0] as { gain: number }).gain).toBe(0.5)
    store.undo()
    expect((lane(store.doc, 'audio')[0] as { gain: number }).gain).toBe(1)
    expect(brief(lane(store.doc, 'audio'))).toEqual([[0, 5, 2]])
    store.undo()
    expect(brief(lane(store.doc, 'audio'))).toEqual([[0, 10, 1]])
    expect(store.setClipSpeed(video.id, 9)).toBe(false)
    expect(store.lastError).toBe('invalid-time')
  })
})
