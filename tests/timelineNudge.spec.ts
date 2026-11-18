import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useTimelineStore } from '@/stores/timeline'
import {
  nudgeClips,
  nudgeSpan,
  secondsToTime as s,
  validateDoc,
  type AudioClip,
  type OverlayClip,
  type TimelineDoc,
  type VideoClip,
} from '@/timeline/model'

const ms = (v: number) => v * 1000

const video = (id: string, start: number, duration: number, extra: Partial<VideoClip> = {}) =>
  ({
    id,
    kind: 'video',
    asset: 'vid',
    start,
    duration,
    sourceIn: 0,
    speed: 1,
    ...extra,
  }) satisfies VideoClip

const audio = (id: string, start: number, duration: number, extra: Partial<AudioClip> = {}) =>
  ({
    id,
    kind: 'audio',
    asset: 'vid',
    start,
    duration,
    sourceIn: 0,
    speed: 1,
    gain: 1,
    ...extra,
  }) satisfies AudioClip

const text = (id: string, start: number, duration: number) =>
  ({
    id,
    kind: 'text',
    start,
    duration,
    data: { text: 'Hallo', keys: [{ at: s(1), x: 0.2, y: 0.3, scale: 1 }] },
  }) satisfies OverlayClip

function setup() {
  const store = useTimelineStore()
  store.putAsset({ id: 'vid', kind: 'video', name: 'a.mp4', duration: s(30) })
  store.addTrack({ id: 'A1', kind: 'audio', name: 'Ton' })
  store.addTrack({ id: 'V1', kind: 'video', name: 'Video' })
  store.addTrack({ id: 'T1', kind: 'overlay', name: 'Text' })
  return store
}

const starts = (doc: TimelineDoc, trackId: string) =>
  doc.tracks.find((t) => t.id === trackId)!.clips.map((c) => [c.id, c.start])

describe('Zeitlich verschieben (Knopfleiste)', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('verschiebt um 5/10/100/1000 ms vor und zurück, je ein Rückgängig-Schritt', () => {
    const store = setup()
    store.insertClip('T1', text('t', s(2), s(3)))
    store.select(['t'])
    for (const step of [5, 10, 100, 1000]) {
      expect(store.nudgeSelection({ by: ms(step) })).toBe(true)
    }
    expect(starts(store.doc, 'T1')).toEqual([['t', s(2) + ms(1115)]])
    expect(store.nudgeSelection({ by: -ms(5) })).toBe(true)
    expect(starts(store.doc, 'T1')).toEqual([['t', s(2) + ms(1110)]])
    // Keyframes zählen ab Clip-Anfang und bleiben daher unverändert.
    expect((store.selectedClips[0] as OverlayClip).data.keys).toEqual([
      { at: s(1), x: 0.2, y: 0.3, scale: 1 },
    ])
    store.undo()
    expect(starts(store.doc, 'T1')).toEqual([['t', s(2) + ms(1115)]])
    store.undo()
    expect(starts(store.doc, 'T1')).toEqual([['t', s(2) + ms(115)]])
    expect(validateDoc(store.doc)).toEqual([])
  })

  it('nimmt verknüpften Ton mit und hält bei 0 an', () => {
    const store = setup()
    store.insertClip('V1', video('v', ms(30), s(2), { linkGroup: 'g' }))
    store.insertClip('A1', audio('a', ms(30), s(2), { linkGroup: 'g' }))
    store.select(['v'])
    expect(store.nudgeSelection({ by: -ms(100) })).toBe(true)
    expect(starts(store.doc, 'V1')).toEqual([['v', 0]])
    expect(starts(store.doc, 'A1')).toEqual([['a', 0]])
    // Schon bei 0: nichts ändert sich, kein leerer Rückgängig-Schritt.
    const before = store.doc
    expect(store.nudgeSelection({ by: -ms(5) })).toBe(true)
    expect(store.doc).toBe(before)
  })

  it('verschiebt Mehrfachauswahl gemeinsam und lehnt Kollisionen ab', () => {
    const store = setup()
    store.insertClip('V1', video('v1', 0, s(2)))
    store.insertClip('V1', video('v2', s(2) + ms(10), s(1)))
    store.insertClip('T1', text('t', s(1), s(1)))
    store.select(['v2', 't'])
    expect(store.nudgeSelection({ by: ms(100) })).toBe(true)
    expect(starts(store.doc, 'V1')).toEqual([
      ['v1', 0],
      ['v2', s(2) + ms(110)],
    ])
    expect(starts(store.doc, 'T1')).toEqual([['t', s(1) + ms(100)]])
    // v2 würde v1 überlappen: nichts bewegt sich.
    const before = store.doc
    expect(store.nudgeSelection({ by: -ms(1000) })).toBe(false)
    expect(store.lastError).toBe('overlap')
    expect(store.doc).toBe(before)
  })

  it('richtet Anfang oder Ende am Abspielkopf aus', () => {
    const store = setup()
    store.insertClip('T1', text('t', s(1), s(2)))
    store.select(['t'])
    store.seek(s(5))
    expect(store.nudgeSelection({ startAt: store.playhead })).toBe(true)
    expect(starts(store.doc, 'T1')).toEqual([['t', store.playhead]])
    expect(store.nudgeSelection({ endAt: store.playhead })).toBe(true)
    expect(starts(store.doc, 'T1')).toEqual([['t', store.playhead - s(2)]])
    // Ende an 1 s hieße Anfang bei −1 s: abgelehnt.
    store.seek(s(1))
    expect(store.nudgeSelection({ endAt: store.playhead })).toBe(false)
    expect(store.lastError).toBe('invalid-time')
  })

  it('verschiebt mit „Ganze Spur“ alle Clips der Spur', () => {
    const store = setup()
    store.insertClip('T1', text('t1', s(1), s(1)))
    store.insertClip('T1', text('t2', s(3), s(1)))
    store.insertClip('V1', video('v', 0, s(2)))
    store.select(['t2'])
    expect(store.nudgeSelection({ by: ms(10) }, { wholeTracks: true })).toBe(true)
    expect(starts(store.doc, 'T1')).toEqual([
      ['t1', s(1) + ms(10)],
      ['t2', s(3) + ms(10)],
    ])
    expect(starts(store.doc, 'V1')).toEqual([['v', 0]])
    // Anfang der Spur an den Abspielkopf.
    store.seek(0)
    expect(store.nudgeSelection({ startAt: 0 }, { wholeTracks: true })).toBe(true)
    expect(starts(store.doc, 'T1')).toEqual([
      ['t1', 0],
      ['t2', s(2)],
    ])
  })

  it('lehnt gesperrte Spuren ab und nennt die gemeinsame Spanne', () => {
    const store = setup()
    store.insertClip('V1', video('v', s(1), s(2)))
    expect(nudgeSpan(store.doc, ['v'])).toEqual({ ids: ['v'], start: s(1), end: s(3) })
    expect(nudgeSpan(store.doc, ['gibt-es-nicht'])).toBeNull()
    store.updateTrack('V1', { locked: true })
    expect(nudgeClips(store.doc, ['v'], { by: ms(5) })).toEqual({
      ok: false,
      error: 'track-locked',
    })
  })
})
