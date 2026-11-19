import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import {
  appendMedia,
  createDoc,
  insertMediaAt,
  isMusicTrack,
  putAsset,
  secondsToTime,
  updateTrack,
  validateDoc,
  type OpResult,
  type TimelineDoc,
} from '@/timeline/model'
import { useTimelineStore } from '@/stores/timeline'

const s = secondsToTime

function unwrap(r: OpResult): TimelineDoc {
  if (!r.ok) throw new Error(r.error)
  return r.doc
}

const counter = () => {
  let n = 0
  return () => `n${++n}`
}

function base(): TimelineDoc {
  let doc = createDoc()
  doc = putAsset(doc, {
    id: 'vid',
    kind: 'video',
    name: 'a.mp4',
    duration: s(10),
    width: 1080,
    height: 1920,
    fps: 25,
    hasAudio: true,
  })
  doc = putAsset(doc, { id: 'stumm', kind: 'video', name: 's.mp4', duration: s(4) })
  doc = putAsset(doc, { id: 'img', kind: 'image', name: 'b.png', duration: null })
  doc = putAsset(doc, { id: 'lied', kind: 'audio', name: 'l.mp3', duration: s(30), hasAudio: true })
  return doc
}

/** [Spurname, Start in s] je Clip. */
const layout = (doc: TimelineDoc) =>
  doc.tracks.flatMap((t) => t.clips.map((c) => [t.name, c.asset, c.start / 1e6]))

describe('insertMediaAt', () => {
  it('legt Bild und Ton genau an die Stelle, verknüpft, und übernimmt das Format', () => {
    const doc = unwrap(insertMediaAt(base(), 'vid', s(3), { ids: counter() }))
    expect(layout(doc)).toEqual([
      ['V1', 'vid', 3],
      ['A1', 'vid', 3],
    ])
    const [v] = doc.tracks[0].clips
    const [a] = doc.tracks[1].clips
    expect(v.linkGroup).toBeTruthy()
    expect(v.linkGroup).toBe(a.linkGroup)
    expect(doc.settings).toMatchObject({ width: 1080, height: 1920, fps: 25 })
    expect(validateDoc(doc)).toEqual([])
  })

  it('nutzt eine freie Lücke der vorhandenen Spur', () => {
    const ids = counter()
    let doc = unwrap(insertMediaAt(base(), 'stumm', 0, { ids }))
    doc = unwrap(insertMediaAt(doc, 'stumm', s(10), { ids }))
    // Lücke 4–10 s ist frei: kein neue Spur.
    doc = unwrap(insertMediaAt(doc, 'stumm', s(5), { ids }))
    expect(doc.tracks.map((t) => t.name)).toEqual(['V1'])
    expect(doc.tracks[0].clips.map((c) => c.start)).toEqual([0, s(5), s(10)])
  })

  it('weicht bei belegter Stelle auf eine neue Spur darüber aus, ohne etwas zu verschieben', () => {
    const ids = counter()
    let doc = unwrap(insertMediaAt(base(), 'vid', 0, { ids }))
    doc = unwrap(insertMediaAt(doc, 'vid', s(5), { ids }))
    expect(layout(doc)).toEqual([
      ['V2', 'vid', 5],
      ['V1', 'vid', 0],
      ['A1', 'vid', 0],
      ['A2', 'vid', 5],
    ])
    expect(validateDoc(doc)).toEqual([])
  })

  it('Tondatei: auf eine Musik-Spur an die Stelle, nie auf die Ton-Spur des Videos', () => {
    const ids = counter()
    let doc = unwrap(insertMediaAt(base(), 'vid', 0, { ids }))
    doc = unwrap(insertMediaAt(doc, 'lied', s(2), { ids }))
    expect(layout(doc)).toEqual([
      ['V1', 'vid', 0],
      ['A1', 'vid', 0],
      ['A2', 'lied', 2],
    ])
    expect(isMusicTrack(doc, doc.tracks[2])).toBe(true)
    // Das Format bleibt beim Video.
    expect(doc.settings).toMatchObject({ width: 1080, height: 1920 })
    // Hinter der Musik ist A2 frei, davor auch nicht (2–32 s belegt).
    doc = unwrap(insertMediaAt(doc, 'lied', s(32), { ids }))
    doc = unwrap(insertMediaAt(doc, 'lied', s(10), { ids }))
    expect(layout(doc).slice(2)).toEqual([
      ['A2', 'lied', 2],
      ['A2', 'lied', 32],
      ['A3', 'lied', 10],
    ])
    // Ein Video an freier Stelle bleibt der Musik fern.
    doc = unwrap(insertMediaAt(doc, 'vid', s(10), { ids }))
    expect(doc.tracks.find((t) => t.name === 'A1')?.clips.map((c) => c.start)).toEqual([0, s(10)])
  })

  it('übergeht gesperrte Spuren', () => {
    let doc = unwrap(insertMediaAt(base(), 'stumm', 0, { ids: counter() }))
    doc = unwrap(updateTrack(doc, doc.tracks[0].id, { locked: true }))
    doc = unwrap(insertMediaAt(doc, 'stumm', s(20), { ids: () => `m${Math.random()}` }))
    expect(layout(doc)).toEqual([
      ['V2', 'stumm', 20],
      ['V1', 'stumm', 0],
    ])
  })

  it('lehnt Unbekanntes, Bilder und ungültige Zeiten ab', () => {
    const err = (r: OpResult) => (r.ok ? null : r.error)
    expect(err(insertMediaAt(base(), 'nope', 0))).toBe('asset-not-found')
    expect(err(insertMediaAt(base(), 'img', 0))).toBe('kind-mismatch')
    expect(err(insertMediaAt(base(), 'vid', -1))).toBe('invalid-time')
  })

  it('appendMedia bleibt unverändert (hängt hinten an)', () => {
    const ids = counter()
    let doc = unwrap(appendMedia(base(), 'stumm', { ids }))
    doc = unwrap(appendMedia(doc, 'stumm', { ids }))
    expect(doc.tracks[0].clips.map((c) => c.start)).toEqual([0, s(4)])
  })
})

describe('Store: insertMediaAtPlayhead', () => {
  beforeEach(() => setActivePinia(createPinia()))

  function store() {
    const st = useTimelineStore()
    const doc = base()
    for (const a of Object.values(doc.assets)) st.putAsset(a)
    return st
  }

  it('fügt am Abspielkopf ein, markiert die neuen Clips und rückt den Abspielkopf ans Ende', () => {
    const st = store()
    st.seek(s(2))
    expect(st.insertMediaAtPlayhead('vid')).toBe(true)
    expect(layout(st.doc)).toEqual([
      ['V1', 'vid', 2],
      ['A1', 'vid', 2],
    ])
    expect(st.selection).toHaveLength(2)
    expect(st.playhead).toBe(s(12))
    // Nacheinander eingefügt = lückenlos hintereinander auf derselben Spur.
    expect(st.insertMediaAtPlayhead('stumm')).toBe(true)
    expect(st.doc.tracks[0].clips.map((c) => c.start)).toEqual([s(2), s(12)])
    expect(st.playhead).toBe(s(16))
  })

  it('Ende zwischen zwei Bildern: Abspielkopf aufs nächste Bild, das nächste Video bleibt auf V1', () => {
    const st = store()
    st.putAsset({
      id: 'krumm',
      kind: 'video',
      name: 'k.mp4',
      duration: 10_010_000,
      fps: 25,
      width: 640,
      height: 360,
    })
    expect(st.insertMediaAtPlayhead('krumm')).toBe(true)
    // 10,01 s liegt zwischen 10,00 und 10,04 s (25 fps): nicht zurück auf 10,00.
    expect(st.playhead).toBe(10_040_000)
    expect(st.insertMediaAtPlayhead('stumm')).toBe(true)
    expect(st.doc.tracks.map((t) => t.name)).toEqual(['V1'])
    expect(st.doc.tracks[0].clips.map((c) => c.start)).toEqual([0, 10_040_000])
  })

  it('ist ein Rückgängig-Schritt', () => {
    const st = store()
    st.seek(s(1))
    st.insertMediaAtPlayhead('vid')
    expect(st.undo()).toBe(true)
    expect(st.doc.tracks.every((t) => t.clips.length === 0)).toBe(true)
    expect(st.redo()).toBe(true)
    expect(layout(st.doc)).toEqual([
      ['V1', 'vid', 1],
      ['A1', 'vid', 1],
    ])
  })

  it('lässt bei Fehler Abspielkopf und Auswahl stehen', () => {
    const st = store()
    st.seek(s(3))
    expect(st.insertMediaAtPlayhead('img')).toBe(false)
    expect(st.lastError).toBe('kind-mismatch')
    expect(st.playhead).toBe(s(3))
  })
})
