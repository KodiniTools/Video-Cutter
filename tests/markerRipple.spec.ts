import { describe, expect, it } from 'vitest'
import {
  addMarker,
  appendMedia,
  createDoc,
  cutClipRanges,
  putAsset,
  removeClip,
  setClipSpeed,
  updateTrack,
  validateDoc,
  type AssetRef,
  type Clip,
  type OpResult,
  type TimelineDoc,
} from '@/timeline/model'

const S = 1_000_000
const asset = (id: string): AssetRef => ({
  id,
  kind: 'video',
  name: `${id}.mp4`,
  duration: 10 * S,
  width: 1280,
  height: 720,
  fps: 25,
  hasAudio: true,
})
const must = (r: OpResult): TimelineDoc => {
  if (!r.ok) throw new Error(r.error)
  return r.doc
}
/** Drei Videos (je 10 s) hintereinander, dazu Marker an den genannten Sekunden. */
function threeClips(marks: Array<[number, string?]>): TimelineDoc {
  let doc = createDoc()
  for (const id of ['a', 'b', 'c']) doc = must(appendMedia(putAsset(doc, asset(id)), id))
  marks.forEach(([at, label], i) => {
    doc = must(addMarker(doc, { id: `m${i}`, at: at * S, label }))
  })
  return doc
}
const video = (doc: TimelineDoc): Clip[] => [
  ...(doc.tracks.find((t) => t.kind === 'video')?.clips ?? []),
]
const marks = (doc: TimelineDoc) => doc.markers.map((m) => [m.id, m.at / S, m.label])

describe('Marker wandern beim Nachrücken mit', () => {
  it('Löschen mit Lücke schließen: Marker dahinter rücken vor, davor bleiben', () => {
    const doc = threeClips([[5], [22, 'Teil 3'], [30]])
    const next = must(removeClip(doc, video(doc)[1].id, { ripple: true }))
    expect(marks(next)).toEqual([
      ['m0', 5, ''],
      ['m1', 12, 'Teil 3'],
      ['m2', 20, ''],
    ])
    expect(validateDoc(next)).toEqual([])
    // Eingabe unverändert.
    expect(marks(doc)[1]).toEqual(['m1', 22, 'Teil 3'])
  })

  it('Marker im gelöschten Bereich rücken an dessen Anfang', () => {
    const doc = threeClips([[13, 'Mitte'], [25]])
    const next = must(removeClip(doc, video(doc)[1].id, { ripple: true }))
    expect(marks(next)).toEqual([
      ['m0', 10, 'Mitte'],
      ['m1', 15, ''],
    ])
  })

  it('treffen zwei Marker dieselbe Stelle, bleibt der mit Namen', () => {
    const doc = threeClips([[10], [15], [20, 'Teil 3'], [21]])
    const next = must(removeClip(doc, video(doc)[1].id, { ripple: true }))
    expect(marks(next)).toEqual([
      ['m2', 10, 'Teil 3'],
      ['m3', 11, ''],
    ])
    // Ohne Namen bleibt der frühere.
    const plain = threeClips([[10], [20]])
    expect(marks(must(removeClip(plain, video(plain)[1].id, { ripple: true })))).toEqual([
      ['m0', 10, ''],
    ])
  })

  it('ohne Lücke schließen bleiben alle Marker stehen', () => {
    const doc = threeClips([[13], [25]])
    const next = must(removeClip(doc, video(doc)[1].id))
    expect(next.markers).toBe(doc.markers)
  })

  it('rückt nichts nach (gesperrte Spur hält alles), bleiben die Marker', () => {
    let doc = threeClips([[25]])
    const audio = doc.tracks.find((t) => t.kind === 'audio')!
    doc = must(updateTrack(doc, audio.id, { locked: true }))
    const next = must(removeClip(doc, video(doc)[1].id, { ripple: true, linked: false }))
    expect(video(next).map((c) => c.start / S)).toEqual([0, 10])
    expect(marks(next)).toEqual([['m0', 15, '']])
  })

  it('Tempo mit Nachrücken: langsamer schiebt Marker nach hinten, schneller nach vorn', () => {
    const doc = threeClips([[5], [10, 'Teil 2'], [25]])
    const first = video(doc)[0]
    const slow = must(setClipSpeed(doc, first.id, 0.5, { ripple: true }))
    expect(marks(slow)).toEqual([
      ['m0', 5, ''],
      ['m1', 20, 'Teil 2'],
      ['m2', 35, ''],
    ])
    const fast = must(setClipSpeed(doc, first.id, 2, { ripple: true }))
    // m0 und m1 treffen sich bei 5 s: der mit Namen bleibt.
    expect(marks(fast)).toEqual([
      ['m1', 5, 'Teil 2'],
      ['m2', 20, ''],
    ])
    expect(validateDoc(fast)).toEqual([])
    // Ohne Nachrücken bleiben sie stehen.
    expect(must(setClipSpeed(doc, first.id, 2)).markers).toBe(doc.markers)
  })

  it('Bereiche herausschneiden (Stille, Schnittvorschläge) nimmt die Marker mit', () => {
    const doc = threeClips([[1], [4], [8], [15]])
    const next = must(cutClipRanges(doc, video(doc)[0].id, [{ start: 2 * S, end: 5 * S }]))
    expect(marks(next)).toEqual([
      ['m0', 1, ''],
      ['m1', 2, ''],
      ['m2', 5, ''],
      ['m3', 12, ''],
    ])
  })
})
