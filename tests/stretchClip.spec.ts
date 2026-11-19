import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import {
  addTrack,
  createDoc,
  insertClip,
  insertMediaAt,
  putAsset,
  secondsToTime,
  stretchClip,
  stretchRange,
  updateTrack,
  validateDoc,
  type Clip,
  type OpResult,
  type TimelineDoc,
} from '@/timeline/model'
import { useTimelineStore } from '@/stores/timeline'

const s = secondsToTime

function unwrap(r: OpResult): TimelineDoc {
  if (!r.ok) throw new Error(r.error)
  return r.doc
}
const err = (r: OpResult) => (r.ok ? null : r.error)

/** V1: Video a (0–4 s, mit Ton auf A1), Video b ab 6 s; T1: Text bei 5 s. */
function base(): TimelineDoc {
  let n = 0
  const ids = () => `n${++n}`
  let doc = createDoc({ fps: 25 })
  doc = putAsset(doc, { id: 'a', kind: 'video', name: 'a.mp4', duration: s(4), hasAudio: true })
  doc = putAsset(doc, { id: 'b', kind: 'video', name: 'b.mp4', duration: s(3) })
  doc = unwrap(insertMediaAt(doc, 'a', 0, { ids }))
  doc = unwrap(insertMediaAt(doc, 'b', s(6), { ids }))
  doc = unwrap(addTrack(doc, { id: 'T1', kind: 'overlay', name: 'T1' }, 0))
  doc = unwrap(
    insertClip(doc, 'T1', { id: 'txt', kind: 'text', start: s(5), duration: s(1), data: {} }),
  )
  return doc
}
const clip = (doc: TimelineDoc, id: string): Clip =>
  doc.tracks.flatMap((t): Clip[] => t.clips).find((c) => c.id === id) as Clip
const videoA = (doc: TimelineDoc) =>
  doc.tracks.find((t) => t.name === 'V1')!.clips.find((c) => 'asset' in c && c.asset === 'a')!

describe('stretchClip', () => {
  it('dehnt bis zum nächsten Video: langsamer, Ton mit, alles andere bleibt', () => {
    const doc = base()
    const a = videoA(doc)
    const out = unwrap(stretchClip(doc, a.id, 'end', s(6)))
    const v = clip(out, a.id) as Clip & { speed: number; sourceIn: number }
    expect([v.start, v.duration, v.sourceIn]).toEqual([0, s(6), 0])
    expect(v.speed).toBeCloseTo(4 / 6, 9)
    const audio = out.tracks
      .find((t) => t.name === 'A1')!
      .clips.find((c) => c.linkGroup === a.linkGroup) as Clip & { speed: number }
    expect([audio.start, audio.duration]).toEqual([0, s(6)])
    expect(audio.speed).toBeCloseTo(4 / 6, 9)
    // Video b und der Text stehen exakt wie vorher.
    const b = out.tracks.find((t) => t.name === 'V1')!.clips.find((c) => c.id !== a.id)!
    expect(b.start).toBe(s(6))
    expect(clip(out, 'txt').start).toBe(s(5))
    expect(validateDoc(out)).toEqual([])
  })

  it('Anfang ziehen: Ende bleibt, schneller beim Stauchen', () => {
    const doc = base()
    const a = videoA(doc)
    const out = unwrap(stretchClip(doc, a.id, 'start', s(2)))
    const v = clip(out, a.id) as Clip & { speed: number }
    expect([v.start, v.duration]).toEqual([s(2), s(2)])
    expect(v.speed).toBeCloseTo(2, 9)
  })

  it('Bereich: bis zum Nachbarn und Tempo 0,25–4', () => {
    const doc = base()
    const a = videoA(doc)
    expect(stretchRange(doc, a.id, 'end')).toEqual({ min: s(1), max: s(6) })
    expect(stretchRange(doc, a.id, 'start')).toEqual({ min: 0, max: s(3) })
    expect(err(stretchClip(doc, a.id, 'end', s(7)))).toBe('overlap')
    expect(err(stretchClip(doc, a.id, 'end', s(0.5)))).toBe('invalid-time')
  })

  it('lehnt Texte und gesperrte Spuren ab', () => {
    const doc = base()
    expect(err(stretchClip(doc, 'txt', 'end', s(7)))).toBe('kind-mismatch')
    const a = videoA(doc)
    const locked = unwrap(
      updateTrack(doc, doc.tracks.find((t) => t.name === 'A1')!.id, { locked: true }),
    )
    expect(err(stretchClip(locked, a.id, 'end', s(5)))).toBe('track-locked')
    expect(stretchRange(locked, a.id, 'end')).toBeNull()
  })
})

describe('Store: dragStretchTo', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('rastet am nächsten Video ein und ist ein Rückgängig-Schritt', () => {
    const st = useTimelineStore()
    st.load(base())
    const a = videoA(st.doc)
    st.beginGesture()
    // Etwas vor dem nächsten Video losgelassen: rastet bei 6 s ein.
    expect(st.dragStretchTo(a.id, 'end', s(5.98))).toBe(true)
    // Darüber hinaus: bleibt am Nachbarn hängen.
    expect(st.dragStretchTo(a.id, 'end', s(9))).toBe(true)
    st.endGesture()
    expect(clip(st.doc, a.id).duration).toBe(s(6))
    expect(st.undo()).toBe(true)
    expect(clip(st.doc, a.id).duration).toBe(s(4))
  })
})
