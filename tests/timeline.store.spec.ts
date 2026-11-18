import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { MAX_TIMELINE_HISTORY, MAX_ZOOM, MIN_ZOOM, useTimelineStore } from '@/stores/timeline'
import {
  createDoc,
  secondsToTime as s,
  validateDoc,
  type AudioClip,
  type VideoClip,
} from '@/timeline/model'

const video = (id: string, start: number, duration: number, extra: Partial<VideoClip> = {}) =>
  ({
    id,
    kind: 'video',
    asset: 'vid',
    start: s(start),
    duration: s(duration),
    sourceIn: 0,
    speed: 1,
    ...extra,
  }) satisfies VideoClip

const audio = (id: string, start: number, duration: number, extra: Partial<AudioClip> = {}) =>
  ({
    id,
    kind: 'audio',
    asset: 'vid',
    start: s(start),
    duration: s(duration),
    sourceIn: 0,
    speed: 1,
    gain: 1,
    ...extra,
  }) satisfies AudioClip

function setup() {
  const store = useTimelineStore()
  store.putAsset({ id: 'vid', kind: 'video', name: 'a.mp4', duration: s(10) })
  store.addTrack({ id: 'A1', kind: 'audio', name: 'Ton' })
  store.addTrack({ id: 'V1', kind: 'video', name: 'Video' })
  return store
}

const clips = (store: ReturnType<typeof useTimelineStore>, trackId: string) =>
  store.doc.tracks.find((t) => t.id === trackId)!.clips.map((c) => [c.id, c.start, c.duration])

describe('Timeline-Store', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('führt Befehle aus und macht sie rückgängig/wiederholbar', () => {
    const store = setup()
    expect(store.insertClip('V1', video('a', 0, 4))).toBe(true)
    expect(store.moveClip('a', { start: s(2) })).toBe(true)
    expect(clips(store, 'V1')).toEqual([['a', s(2), s(4)]])
    expect(store.duration).toBe(s(6))

    expect(store.undo()).toBe(true)
    expect(clips(store, 'V1')).toEqual([['a', 0, s(4)]])
    expect(store.canRedo).toBe(true)
    expect(store.redo()).toBe(true)
    expect(clips(store, 'V1')).toEqual([['a', s(2), s(4)]])
    expect(store.redo()).toBe(false)
  })

  it('lässt bei abgelehnten Befehlen alles unverändert und nennt den Grund', () => {
    const store = setup()
    store.insertClip('V1', video('a', 0, 4))
    const before = store.doc
    expect(store.insertClip('V1', video('b', 2, 4))).toBe(false)
    expect(store.lastError).toBe('overlap')
    expect(store.doc).toBe(before)
    store.undo()
    // Der abgelehnte Befehl hat keinen Verlaufsschritt erzeugt.
    expect(clips(store, 'V1')).toEqual([])
    expect(store.insertClip('V1', video('b', 2, 4))).toBe(true)
    expect(store.lastError).toBeNull()
  })

  it('verwirft „Wiederholen“ nach einem neuen Befehl', () => {
    const store = setup()
    store.insertClip('V1', video('a', 0, 2))
    store.undo()
    store.insertClip('V1', video('b', 0, 2))
    expect(store.canRedo).toBe(false)
  })

  it('fasst eine Geste zu einem Schritt zusammen', () => {
    const store = setup()
    store.insertClip('V1', video('a', 0, 2))
    store.beginGesture()
    store.moveClip('a', { start: s(1) })
    store.moveClip('a', { start: s(2) })
    store.moveClip('a', { start: s(3) })
    store.endGesture()
    expect(clips(store, 'V1')).toEqual([['a', s(3), s(2)]])
    store.undo()
    expect(clips(store, 'V1')).toEqual([['a', 0, s(2)]])
    store.redo()
    expect(clips(store, 'V1')).toEqual([['a', s(3), s(2)]])
  })

  it('erzeugt für eine Geste ohne Änderung keinen Schritt und kann abbrechen', () => {
    const store = setup()
    store.insertClip('V1', video('a', 0, 2))
    store.undo()
    store.redo()
    const steps = () => {
      let n = 0
      while (store.undo()) n++
      for (let i = 0; i < n; i++) store.redo()
      return n
    }
    const before = steps()
    store.beginGesture()
    store.endGesture()
    expect(steps()).toBe(before)

    store.beginGesture()
    store.moveClip('a', { start: s(5) })
    store.cancelGesture()
    expect(clips(store, 'V1')).toEqual([['a', 0, s(2)]])
    expect(steps()).toBe(before)
  })

  it('behält angemeldete Medien über Rückgängig hinweg', () => {
    const store = setup()
    store.insertClip('V1', video('a', 0, 2))
    store.putAsset({ id: 'neu', kind: 'video', name: 'b.mp4', duration: s(5) })
    store.undo()
    expect(store.doc.assets.neu).toBeDefined()
    expect(store.insertClip('V1', video('b', 0, 2, { asset: 'neu' }))).toBe(true)
    expect(validateDoc(store.doc)).toEqual([])
  })

  it('meldet Medien ab: nicht solange verwendet, und ohne Rückkehr über den Verlauf', () => {
    const store = setup()
    store.putAsset({ id: 'frei', kind: 'video', name: 'f.mp4', duration: s(5) })
    store.insertClip('V1', video('a', 0, 2))
    expect(store.removeAsset('vid')).toBe(false)
    expect(store.lastError).toBe('asset-in-use')
    expect(store.removeAsset('nope')).toBe(false)

    // Unbenutzt, kommt in keinem früheren Stand als Clip vor: Verlauf bleibt.
    expect(store.removeAsset('frei')).toBe(true)
    expect(store.canUndo).toBe(true)
    store.undo()
    expect(store.doc.assets.frei).toBeUndefined()
    store.redo()
    expect(store.doc.assets.frei).toBeUndefined()

    // Nur noch im Verlauf verwendet: Verlauf wird geleert.
    store.removeClip('a')
    expect(store.removeAsset('vid')).toBe(true)
    expect([store.canUndo, store.canRedo]).toEqual([false, false])
    expect(store.doc.assets.vid).toBeUndefined()
    expect(validateDoc(store.doc)).toEqual([])
  })

  it('wertet das Anmelden eines Mediums während einer Geste nicht als Änderung', () => {
    const store = setup()
    store.beginGesture()
    store.putAsset({ id: 'neu', kind: 'video', name: 'b.mp4', duration: s(5) })
    store.endGesture()
    expect(store.canUndo).toBe(true) // nur die beiden Spuren aus setup()
    store.undo()
    store.undo()
    expect(store.canUndo).toBe(false)
  })

  it('begrenzt den Verlauf', () => {
    const store = setup()
    store.insertClip('V1', video('a', 0, 1))
    for (let i = 1; i <= MAX_TIMELINE_HISTORY + 20; i++) store.moveClip('a', { start: s(i) })
    let n = 0
    while (store.undo()) n++
    expect(n).toBe(MAX_TIMELINE_HISTORY)
  })

  it('hält die Auswahl sauber und teilt/löscht markierte Clips in einem Schritt', () => {
    const store = setup()
    store.insertClip('V1', video('v', 0, 4, { linkGroup: 'g' }))
    store.insertClip('A1', audio('a', 0, 4, { linkGroup: 'g' }))
    store.insertClip('V1', video('w', 5, 2))
    store.select(['v', 'a', 'gibt-es-nicht', 'v'])
    expect(store.selection).toEqual(['v', 'a'])
    expect(store.selectedClips.map((c) => c.id)).toEqual(['v', 'a'])

    store.seek(s(1))
    expect(store.splitAtPlayhead()).toBe(true)
    expect(clips(store, 'V1').map((c) => c[1])).toEqual([0, s(1), s(5)])
    expect(clips(store, 'A1').map((c) => c[1])).toEqual([0, s(1)])
    store.undo()
    expect(clips(store, 'V1')).toHaveLength(2)
    expect(clips(store, 'A1')).toHaveLength(1)

    // Abspielkopf außerhalb aller markierten Clips: abgelehnt.
    store.seek(s(4.5))
    expect(store.splitAtPlayhead()).toBe(false)
    expect(store.lastError).toBe('invalid-time')

    expect(store.removeSelection({ ripple: true })).toBe(true)
    expect(clips(store, 'V1')).toEqual([['w', s(1), s(2)]])
    expect(clips(store, 'A1')).toEqual([])
    expect(store.selection).toEqual([])
    store.undo()
    expect(clips(store, 'V1')).toHaveLength(2)
    expect(store.removeSelection()).toBe(false)
  })

  it('löst den Ton vom Video und verbindet beide wieder', () => {
    const store = useTimelineStore()
    store.putAsset({ id: 'vid', kind: 'video', name: 'a.mp4', duration: s(10), hasAudio: true })
    store.appendMedia('vid')
    const [v, a] = [store.doc.tracks[0].clips[0].id, store.doc.tracks[1].clips[0].id]
    expect(store.canUnlink).toBe(true)
    expect(store.canLink).toBe(false)

    expect(store.unlinkSelection()).toBe(true)
    expect(store.doc.tracks.every((t) => t.clips.every((c) => !c.linkGroup))).toBe(true)
    // Auswahl ist aufgehoben: „Löschen“ träfe sonst weiter beide.
    expect(store.selection).toEqual([])
    expect(store.canUnlink).toBe(false)
    expect(store.canLink).toBe(false)
    expect(validateDoc(store.doc)).toEqual([])

    // Getrennt: Anklicken markiert nur den einen Clip, Verschieben und Löschen wirken einzeln.
    store.selectClip(a)
    expect(store.selection).toEqual([a])
    expect(store.canLink).toBe(false)
    expect(store.moveClip(a, { start: s(3) })).toBe(true)
    expect(store.doc.tracks[0].clips[0].start).toBe(0)
    expect(store.doc.tracks[1].clips[0].start).toBe(s(3))
    store.undo()

    // Wieder verbinden: beide markieren, danach wandern sie gemeinsam.
    store.select([v, a])
    expect(store.canLink).toBe(true)
    expect(store.linkSelection()).toBe(true)
    expect(store.doc.tracks[0].clips[0].linkGroup).toBeTruthy()
    expect(store.doc.tracks[0].clips[0].linkGroup).toBe(store.doc.tracks[1].clips[0].linkGroup)
    store.selectClip(a)
    expect(store.selection).toHaveLength(2)

    // Rückgängig: verbinden, dann lösen zurück -> ursprüngliche Verknüpfung.
    store.undo()
    store.undo()
    expect(store.doc.tracks[0].clips[0].linkGroup).toBeTruthy()

    // Ton allein löschen.
    store.select([v, a])
    store.unlinkSelection()
    store.selectClip(a)
    expect(store.removeSelection()).toBe(true)
    expect(store.doc.tracks[0].clips).toHaveLength(1)
    expect(store.doc.tracks[1].clips).toHaveLength(0)
  })

  it('legt ein Video in einem Schritt auf die Timeline und markiert die neuen Clips', () => {
    const store = useTimelineStore()
    store.putAsset({ id: 'vid', kind: 'video', name: 'a.mp4', duration: s(10), hasAudio: true })
    expect(store.appendMedia('vid')).toBe(true)
    expect(store.doc.tracks.map((t) => t.name)).toEqual(['V1', 'A1'])
    expect(store.selection).toHaveLength(2)
    expect(store.appendMedia('vid')).toBe(true)
    expect(store.duration).toBe(s(20))
    expect(store.selection).toEqual([
      store.doc.tracks[0].clips[1].id,
      store.doc.tracks[1].clips[1].id,
    ])

    store.undo()
    expect(store.duration).toBe(s(10))
    store.undo()
    // Spuren und Clips verschwinden gemeinsam.
    expect(store.doc.tracks).toEqual([])
    expect(store.canUndo).toBe(false)
    expect(store.appendMedia('nope')).toBe(false)
    expect(store.lastError).toBe('asset-not-found')
  })

  it('entfernt gelöschte Clips aus der Auswahl, auch nach Rückgängig', () => {
    const store = setup()
    store.insertClip('V1', video('a', 0, 2))
    store.select(['a'])
    store.toggleSelected('a')
    expect(store.selection).toEqual([])
    store.toggleSelected('a')
    store.undo()
    expect(store.selection).toEqual([])
  })

  it('setzt Abspielkopf (Bildraster, nie negativ) und Zoom in Grenzen', () => {
    const store = setup()
    store.seek(s(1.02))
    expect(store.playhead).toBe(s(1 + 1 / 30))
    store.seek(-5)
    expect(store.playhead).toBe(0)
    store.seek(Number.NaN)
    expect(store.playhead).toBe(0)
    store.setZoom(1e9)
    expect(store.zoom).toBe(MAX_ZOOM)
    store.setZoom(0)
    expect(store.zoom).toBe(MIN_ZOOM)
    store.setZoom(Number.NaN)
    expect(store.zoom).toBe(MIN_ZOOM)
  })

  it('rastet abhängig vom Zoom ein und lässt sich abschalten', () => {
    const store = setup()
    store.insertClip('V1', video('a', 2, 2))
    store.setZoom(100) // 8 px = 0,08 s
    expect(store.snap(s(2.05))).toBe(s(2))
    expect(store.snap(s(2.2))).toBe(s(2.2))
    // Der gezogene Clip selbst zählt nicht als Ziel.
    expect(store.snap(s(2.05), { exclude: ['a'] })).toBe(s(2.05))
    store.seek(s(3))
    expect(store.snap(s(3.05), { exclude: ['a'] })).toBe(s(3))
    store.snapping = false
    expect(store.snap(s(2.05))).toBe(s(2.05))
  })

  it('lädt nur gültige Dokumente und beginnt den Verlauf neu', () => {
    const store = setup()
    store.insertClip('V1', video('a', 0, 2))
    const good = store.doc
    const bad = {
      ...good,
      tracks: [{ ...good.tracks[0], clips: [video('x', 0, 3), video('y', 1, 3)] }, good.tracks[1]],
    } as typeof good
    expect(store.load(bad)).toEqual([{ error: 'overlap', id: 'y' }])
    expect(store.doc).toBe(good)

    store.select(['a'])
    store.seek(s(1))
    expect(store.load(createDoc({ fps: 25 }))).toEqual([])
    expect(store.doc.settings.fps).toBe(25)
    expect([store.canUndo, store.canRedo, store.selection, store.playhead]).toEqual([
      false,
      false,
      [],
      0,
    ])
    store.reset()
    expect(store.doc.settings.fps).toBe(30)
  })

  it('zieht Clips: Einrasten an Anfang oder Ende, Bildraster, andere Spur, nie vor 0', () => {
    const store = setup()
    store.addTrack({ id: 'V2', kind: 'video', name: 'V2' })
    store.insertClip('V1', video('v', 2, 2, { linkGroup: 'g' }))
    store.insertClip('A1', audio('a', 1, 2, { linkGroup: 'g' }))
    store.insertClip('V1', video('w', 6, 2))

    // Ende rastet am Anfang von w ein (Toleranz 8 px = 0,08 s bei 100 px/s).
    expect(store.dragClipTo('v', s(3.95))).toBe(true)
    expect(clips(store, 'V1')[0]).toEqual(['v', s(4), s(2)])
    expect(clips(store, 'A1')[0]).toEqual(['a', s(3), s(2)])
    // Ohne Einrastpunkt in der Nähe: Bildraster (30 fps).
    expect(store.dragClipTo('v', s(2.51))).toBe(true)
    expect(clips(store, 'V1')[0][1]).toBe(s(2.5))
    // Der verknüpfte Ton liegt 1 s früher: weiter als bis 1 s geht es nicht nach links.
    expect(store.dragClipTo('v', s(-5))).toBe(true)
    expect(clips(store, 'V1')[0][1]).toBe(s(1))
    expect(clips(store, 'A1')[0][1]).toBe(0)
    // Belegte Stelle: abgelehnt, Clip bleibt liegen.
    expect(store.dragClipTo('v', s(5))).toBe(false)
    expect(store.lastError).toBe('overlap')
    expect(clips(store, 'V1')[0][1]).toBe(s(1))
    // Auf eine andere Video-Spur; eine Ton-Spur als Ziel wird ignoriert.
    expect(store.dragClipTo('v', s(5), 'V2')).toBe(true)
    expect(clips(store, 'V2')).toEqual([['v', s(5), s(2)]])
    expect(store.dragClipTo('v', s(3), 'A1')).toBe(true)
    expect(clips(store, 'V2')).toEqual([['v', s(3), s(2)]])

    store.snapping = false
    expect(store.dragClipTo('w', s(5.03))).toBe(true)
    expect(clips(store, 'V1')[0][1]).toBe(s(5 + 1 / 30))
    expect(store.dragClipTo('gibt-es-nicht', 0)).toBe(false)
    expect(validateDoc(store.doc)).toEqual([])
  })

  it('trimmt beim Ziehen innerhalb der Grenzen und rastet am Abspielkopf ein', () => {
    const store = setup()
    store.insertClip('V1', video('v', 2, 4, { sourceIn: s(1) }))
    store.insertClip('V1', video('w', 8, 2))
    store.seek(s(5))

    expect(store.dragTrimTo('v', 'end', s(5.05))).toBe(true)
    expect(clips(store, 'V1')[0]).toEqual(['v', s(2), s(3)])
    // Ende: höchstens bis zum Nachbarn (8 s); die Quelle reichte bis 11 s.
    expect(store.dragTrimTo('v', 'end', s(20))).toBe(true)
    expect(clips(store, 'V1')[0]).toEqual(['v', s(2), s(6)])
    // Anfang: höchstens 1 s nach links (Quelle beginnt dort), mindestens 0,05 s Länge.
    expect(store.dragTrimTo('v', 'start', s(-3))).toBe(true)
    expect(clips(store, 'V1')[0]).toEqual(['v', s(1), s(7)])
    expect(store.dragTrimTo('v', 'start', s(30))).toBe(true)
    expect(clips(store, 'V1')[0]).toEqual(['v', s(7.95), s(0.05)])
    expect(store.dragTrimTo('gibt-es-nicht', 'end', 0)).toBe(false)
    expect(validateDoc(store.doc)).toEqual([])
  })

  it('teilt ohne passende Auswahl alles unter dem Abspielkopf, außer auf gesperrten Spuren', () => {
    const store = setup()
    store.insertClip('V1', video('v', 0, 4))
    store.insertClip('A1', audio('a', 0, 4))
    store.insertClip('V1', video('w', 5, 2))
    store.select(['w'])
    store.updateTrack('A1', { locked: true })
    store.seek(s(2))
    expect(store.splitTargets).toEqual(['v'])
    expect(store.splitAtPlayhead()).toBe(true)
    expect(clips(store, 'V1')).toHaveLength(3)
    expect(clips(store, 'A1')).toHaveLength(1)

    store.selectClip('w')
    store.selectAll()
    expect(store.selection).toHaveLength(4)
  })

  it('legt Spuren an (Bild oben, Ton unten), verschiebt und entfernt sie rückgängig machbar', () => {
    const store = useTimelineStore()
    const names = () => store.doc.tracks.map((tr) => tr.name)
    store.newTrack('video')
    store.newTrack('audio')
    store.newTrack('video')
    store.newTrack('audio')
    expect(names()).toEqual(['V2', 'V1', 'A1', 'A2'])
    const v2 = store.doc.tracks[0].id
    expect(store.moveTrack(v2, 1)).toBe(true)
    expect(names()).toEqual(['V1', 'V2', 'A1', 'A2'])

    store.putAsset({ id: 'vid', kind: 'video', name: 'a.mp4', duration: s(10) })
    store.insertClip(v2, video('v', 0, 2))
    store.select(['v'])
    expect(store.removeTrack(v2)).toBe(true)
    expect(store.selection).toEqual([])
    store.undo()
    expect(names()).toEqual(['V1', 'V2', 'A1', 'A2'])
    expect(store.doc.tracks[1].clips).toHaveLength(1)

    // Unveränderte Eigenschaft: kein leerer Rückgängig-Schritt.
    const steps = () => {
      let n = 0
      while (store.undo()) n++
      for (let i = 0; i < n; i++) store.redo()
      return n
    }
    const before = steps()
    store.updateTrack(v2, { locked: false })
    expect(steps()).toBe(before)
    store.updateTrack(v2, { locked: true })
    expect(store.removeTrack(v2)).toBe(false)
    expect(store.lastError).toBe('track-locked')
  })

  it('entfernt alle leeren Spuren in einem Schritt, gesperrte und belegte bleiben', () => {
    const store = useTimelineStore()
    const names = () => store.doc.tracks.map((t) => t.name)
    store.newTrack('video')
    store.newTrack('audio')
    store.newTrack('video')
    store.newTrack('audio')
    expect(names()).toEqual(['V2', 'V1', 'A1', 'A2'])
    const [v2, v1, a1] = store.doc.tracks.map((t) => t.id)
    store.putAsset({ id: 'vid', kind: 'video', name: 'a.mp4', duration: s(10) })
    store.insertClip(v1, video('v', 0, 2))
    store.updateTrack(a1, { locked: true })

    expect(store.removeEmptyTracks()).toBe(true)
    expect(names()).toEqual(['V1', 'A1'])
    expect(store.doc.tracks[0].clips).toHaveLength(1)
    // Ein Rückgängig-Schritt stellt beide Spuren wieder her.
    store.undo()
    expect(names()).toEqual(['V2', 'V1', 'A1', 'A2'])
    expect(store.doc.tracks[0].id).toBe(v2)
    store.redo()

    // Nichts mehr zu entfernen: kein leerer Rückgängig-Schritt.
    const before = store.doc
    expect(store.removeEmptyTracks()).toBe(true)
    expect(store.doc).toBe(before)
  })

  it('legt Text am Abspielkopf an, markiert ihn und fasst Tippen zu einem Schritt zusammen', () => {
    const store = useTimelineStore()
    store.seek(s(2))
    const id = store.addText({ text: 'Hallo', size: 0.06 }, s(3))
    expect(id).not.toBeNull()
    expect(store.selection).toEqual([id])
    expect(store.doc.tracks[0]).toMatchObject({ kind: 'overlay', name: 'T1' })
    expect(store.doc.tracks[0].clips[0]).toMatchObject({
      kind: 'text',
      start: s(2),
      duration: s(3),
    })
    expect(store.duration).toBe(s(5))

    const before = store.doc
    store.beginGesture()
    store.updateClipData(id as string, { text: 'Hallo W' })
    store.updateClipData(id as string, { text: 'Hallo Welt' })
    store.endGesture()
    expect(store.selectedClips[0]).toMatchObject({ data: { text: 'Hallo Welt', size: 0.06 } })
    store.undo()
    expect(store.doc.tracks).toBe(before.tracks)
    store.undo()
    expect(store.doc.tracks).toHaveLength(0)
  })
})
