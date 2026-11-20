import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import {
  createDoc,
  insertClip,
  insertMediaAt,
  putAsset,
  replaceWithMedia,
  replaceWithOverlay,
  secondsToTime,
  setClipColor,
  setClipGain,
  setClipSpeed,
  setClipTransition,
  updateTrack,
  validateDoc,
  type AudioClip,
  type OpResult,
  type TimelineDoc,
  type VideoClip,
} from '@/timeline/model'
import { useTimelineStore } from '@/stores/timeline'

const s = secondsToTime

function unwrap(r: OpResult): TimelineDoc {
  if (!r.ok) throw new Error(r.error)
  return r.doc
}

const counter = (prefix = 'n') => {
  let n = 0
  return () => `${prefix}${++n}`
}

function base(): TimelineDoc {
  let doc = createDoc({ width: 1920, height: 1080, fps: 25 })
  doc = putAsset(doc, {
    id: 'alt',
    kind: 'video',
    name: 'alt.mp4',
    duration: s(10),
    hasAudio: true,
  })
  doc = putAsset(doc, {
    id: 'neu',
    kind: 'video',
    name: 'neu.mp4',
    duration: s(6),
    width: 720,
    height: 1280,
    hasAudio: true,
  })
  doc = putAsset(doc, {
    id: 'lang',
    kind: 'video',
    name: 'lang.mp4',
    duration: s(30),
    hasAudio: true,
  })
  doc = putAsset(doc, { id: 'stumm', kind: 'video', name: 'stumm.mp4', duration: s(4) })
  doc = putAsset(doc, { id: 'lied', kind: 'audio', name: 'lied.mp3', duration: s(20) })
  doc = putAsset(doc, { id: 'lied2', kind: 'audio', name: 'lied2.mp3', duration: s(8) })
  return doc
}

const clipsOf = (doc: TimelineDoc) =>
  doc.tracks.flatMap((t) => t.clips.map((c) => ({ track: t.name, ...c })))

describe('replaceWithMedia', () => {
  it('setzt das neue Video an dieselbe Stelle, ohne Einstellungen zu übernehmen', () => {
    const ids = counter()
    let doc = unwrap(insertMediaAt(base(), 'alt', s(2), { ids }))
    const old = doc.tracks[0].clips[0] as VideoClip
    doc = unwrap(setClipSpeed(doc, old.id, 2))
    doc = unwrap(setClipColor(doc, old.id, { brightness: 0.5, contrast: 0, saturation: 0 }))
    doc = unwrap(setClipTransition(doc, old.id, { preset: 'slide', duration: s(1) }))
    const oldAudio = doc.tracks[1].clips[0] as AudioClip
    doc = unwrap(setClipGain(doc, oldAudio.id, 0.3))

    doc = unwrap(replaceWithMedia(doc, old.id, 'neu', { ids: counter('r') }))
    const [v] = doc.tracks[0].clips as VideoClip[]
    const [a] = doc.tracks[1].clips as AudioClip[]
    expect(doc.tracks.map((t) => t.name)).toEqual(['V1', 'A1'])
    expect(v).toEqual({
      id: 'r2',
      kind: 'video',
      asset: 'neu',
      start: s(2),
      duration: s(6),
      sourceIn: 0,
      speed: 1,
      linkGroup: 'r1',
    })
    expect(a).toEqual({
      id: 'r3',
      kind: 'audio',
      asset: 'neu',
      start: s(2),
      duration: s(6),
      sourceIn: 0,
      speed: 1,
      gain: 1,
      linkGroup: 'r1',
    })
    // Projektformat bleibt.
    expect(doc.settings).toMatchObject({ width: 1920, height: 1080 })
    expect(validateDoc(doc)).toEqual([])
  })

  it('ersetzt auch, wenn der Ton des Videos angeklickt wurde', () => {
    const ids = counter()
    let doc = unwrap(insertMediaAt(base(), 'alt', 0, { ids }))
    const audioId = doc.tracks[1].clips[0].id
    doc = unwrap(replaceWithMedia(doc, audioId, 'stumm'))
    // Stummes Video: Ton des alten geht, kein neuer.
    expect(clipsOf(doc).map((c) => [c.track, c.asset, c.kind])).toEqual([['V1', 'stumm', 'video']])
    expect(doc.tracks[0].clips[0].linkGroup).toBeUndefined()
  })

  it('kürzt bis zum nächsten Clip und überschreibt nichts', () => {
    const ids = counter()
    let doc = unwrap(insertMediaAt(base(), 'alt', 0, { ids }))
    doc = unwrap(insertMediaAt(doc, 'stumm', s(10), { ids }))
    const first = doc.tracks[0].clips[0].id
    doc = unwrap(replaceWithMedia(doc, first, 'lang'))
    const video = doc.tracks.find((t) => t.name === 'V1')!.clips
    expect(video.map((c) => [c.asset, c.start, c.duration])).toEqual([
      ['lang', 0, s(10)],
      ['stumm', s(10), s(4)],
    ])
    expect(validateDoc(doc)).toEqual([])
  })

  it('ist das neue Video kürzer, bleibt dahinter eine Lücke (nichts rückt nach)', () => {
    const ids = counter()
    let doc = unwrap(insertMediaAt(base(), 'alt', 0, { ids }))
    doc = unwrap(insertMediaAt(doc, 'stumm', s(10), { ids }))
    doc = unwrap(replaceWithMedia(doc, doc.tracks[0].clips[0].id, 'stumm'))
    expect(doc.tracks[0].clips.map((c) => [c.start, c.duration])).toEqual([
      [0, s(4)],
      [s(10), s(4)],
    ])
  })

  it('ersetzt eine Tondatei durch eine andere auf derselben Spur', () => {
    let doc = unwrap(insertMediaAt(base(), 'lied', s(1), { ids: counter() }))
    const old = doc.tracks[0].clips[0]
    doc = unwrap(setClipGain(doc, old.id, 1.5))
    doc = unwrap(replaceWithMedia(doc, old.id, 'lied2', { ids: counter('r') }))
    expect(doc.tracks[0].clips).toEqual([
      {
        id: 'r1',
        kind: 'audio',
        asset: 'lied2',
        start: s(1),
        duration: s(8),
        sourceIn: 0,
        speed: 1,
        gain: 1,
      },
    ])
  })

  it('lehnt unpassende Arten und gesperrte Spuren ab', () => {
    let doc = unwrap(insertMediaAt(base(), 'alt', 0, { ids: counter() }))
    const v = doc.tracks[0].clips[0].id
    expect(replaceWithMedia(doc, v, 'lied')).toEqual({ ok: false, error: 'kind-mismatch' })
    doc = unwrap(insertMediaAt(doc, 'lied', 0, { ids: counter('m') }))
    const music = doc.tracks.find((t) => t.name === 'A2')!.clips[0].id
    expect(replaceWithMedia(doc, music, 'neu')).toEqual({ ok: false, error: 'kind-mismatch' })
    doc = unwrap(updateTrack(doc, doc.tracks[0].id, { locked: true }))
    expect(replaceWithMedia(doc, v, 'neu')).toEqual({ ok: false, error: 'track-locked' })
  })

  it('legt den Ton auf eine freie Spur, wenn die alte Ton-Spur dort belegt ist', () => {
    const ids = counter()
    // Stummes Video, darunter Ton eines anderen Videos an derselben Stelle.
    let doc = unwrap(insertMediaAt(base(), 'stumm', 0, { ids }))
    doc = unwrap(
      insertClip(doc, doc.tracks[0].id, {
        id: 'x',
        kind: 'video',
        asset: 'stumm',
        start: s(20),
        duration: s(4),
        sourceIn: 0,
        speed: 1,
      }),
    )
    doc = unwrap(replaceWithMedia(doc, 'x', 'neu', { ids: counter('r') }))
    expect(clipsOf(doc).map((c) => [c.track, c.asset, c.start])).toEqual([
      ['V1', 'stumm', 0],
      ['V1', 'neu', s(20)],
      ['A1', 'neu', s(20)],
    ])
  })
})

describe('replaceWithOverlay', () => {
  function withText(): TimelineDoc {
    let doc = createDoc()
    doc = unwrap(
      updateTrack(
        unwrap(
          // Ebene mit Text samt Keyframes und Marker-Bindung.
          insertClip(
            {
              ...doc,
              tracks: [
                { id: 'e1', kind: 'overlay', name: 'E1', locked: false, hidden: false, clips: [] },
              ],
            },
            'e1',
            {
              id: 't',
              kind: 'text',
              start: s(3),
              duration: s(5),
              data: { text: 'Alt', color: '#ff0000', keys: [{ at: 0, x: 0.1, y: 0.1, scale: 1 }] },
              linkGroup: 'g',
            },
          ),
        ),
        'e1',
        { name: 'E1' },
      ),
    )
    return doc
  }

  it('setzt eine Form an Stelle und Länge des Textes, nur mit eigenen Daten', () => {
    const doc = unwrap(
      replaceWithOverlay(withText(), 't', { kind: 'graphic', data: { kind: 'rect' } }, { id: 'f' }),
    )
    expect(doc.tracks[0].clips).toEqual([
      { id: 'f', kind: 'graphic', start: s(3), duration: s(5), data: { kind: 'rect' } },
    ])
  })

  it('lehnt Medien-Clips und gesperrte Ebenen ab', () => {
    let doc = unwrap(insertMediaAt(base(), 'alt', 0, { ids: counter() }))
    expect(replaceWithOverlay(doc, doc.tracks[0].clips[0].id, { kind: 'text', data: {} })).toEqual({
      ok: false,
      error: 'kind-mismatch',
    })
    doc = unwrap(updateTrack(withText(), 'e1', { locked: true }))
    expect(replaceWithOverlay(doc, 't', { kind: 'text', data: {} })).toEqual({
      ok: false,
      error: 'track-locked',
    })
  })
})

describe('Store: Ersetzen-Modus', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('ersetzt in einem Verlaufsschritt, markiert das Neue und beendet den Modus', () => {
    const store = useTimelineStore()
    store.load(unwrap(insertMediaAt(base(), 'alt', s(2), { ids: counter() })))
    const before = store.doc
    store.selectClip(store.doc.tracks[0].clips[0].id)
    expect(store.replaceCandidate).toBe(store.doc.tracks[0].clips[0].id)
    expect(store.startReplace()).toBe(true)
    expect(store.replaceTargetKind).toBe('video')

    // Unpassend: Modus bleibt, Grund steht da, nichts geändert.
    expect(store.replaceWithMedia('lied')).toBe(false)
    expect(store.replaceError).toBe('kind-mismatch')
    expect(store.replaceTarget).not.toBeNull()
    expect(store.doc).toBe(before)

    expect(store.replaceWithMedia('neu')).toBe(true)
    expect(store.replaceTarget).toBeNull()
    expect(store.selection).toHaveLength(2)
    expect(store.selectedClips.every((c) => 'asset' in c && c.asset === 'neu')).toBe(true)

    store.undo()
    expect(store.doc).toEqual(before)
  })

  it('kein Kandidat bei mehreren unabhängigen Clips; Modus endet, wenn der Clip verschwindet', async () => {
    const store = useTimelineStore()
    const ids = counter()
    let doc = unwrap(insertMediaAt(base(), 'stumm', 0, { ids }))
    doc = unwrap(insertMediaAt(doc, 'stumm', s(5), { ids }))
    store.load(doc)
    store.select(store.doc.tracks[0].clips.map((c) => c.id))
    expect(store.replaceCandidate).toBeNull()
    store.select([store.doc.tracks[0].clips[0].id])
    store.startReplace()
    store.removeSelection()
    await nextTick()
    expect(store.replaceTarget).toBeNull()
  })
})
