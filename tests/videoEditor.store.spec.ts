import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useVideoEditorStore } from '@/stores/videoEditor'

// jsdom kennt createObjectURL nicht -> stubben.
beforeEach(() => {
  setActivePinia(createPinia())
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: () => 'blob:mock',
    revokeObjectURL: () => {},
  })
})

function loadVideo(seconds: number) {
  const store = useVideoEditorStore()
  store.setFile(new File([new Uint8Array([0])], 'clip.mp4', { type: 'video/mp4' }))
  store.setDuration(seconds)
  return store
}

describe('videoEditor store', () => {
  it('setDuration setzt Auswahl auf volle Länge', () => {
    const store = loadVideo(30)
    expect(store.duration).toBe(30)
    expect(store.startTime).toBe(0)
    expect(store.endTime).toBe(30)
    expect(store.selectionDuration).toBe(30)
    expect(store.canExport).toBe(true)
  })

  it('setStart darf Ende nicht überholen', () => {
    const store = loadVideo(30)
    store.setEnd(10)
    store.setStart(999)
    expect(store.startTime).toBeLessThanOrEqual(store.endTime)
    expect(store.startTime).toBeCloseTo(9.95, 5)
  })

  it('setEnd bleibt >= Start und <= Dauer', () => {
    const store = loadVideo(30)
    store.setStart(12)
    store.setEnd(5) // ungültig -> wird auf Start+min gezogen
    expect(store.endTime).toBeGreaterThanOrEqual(store.startTime)
    store.setEnd(999)
    expect(store.endTime).toBe(30)
  })

  it('setCurrentTime wird auf [0, duration] begrenzt', () => {
    const store = loadVideo(30)
    store.setCurrentTime(-5)
    expect(store.currentTime).toBe(0)
    store.setCurrentTime(1000)
    expect(store.currentTime).toBe(30)
  })

  it('ohne Video kein Export', () => {
    const store = useVideoEditorStore()
    expect(store.hasVideo).toBe(false)
    expect(store.canExport).toBe(false)
  })

  it('reset leert den Zustand', () => {
    const store = loadVideo(30)
    store.reset()
    expect(store.hasVideo).toBe(false)
    expect(store.duration).toBe(0)
    expect(store.fileName).toBe('')
  })

  it('setMode wechselt den Schnittmodus', () => {
    const store = useVideoEditorStore()
    expect(store.mode).toBe('copy')
    store.setMode('reencode')
    expect(store.mode).toBe('reencode')
  })

  it('ohne Liste sind die effektiven Ausschnitte die aktuelle Auswahl', () => {
    const store = loadVideo(30)
    store.setStart(5)
    store.setEnd(12)
    expect(store.segments).toHaveLength(0)
    expect(store.effectiveSegments).toEqual([{ start: 5, end: 12 }])
  })

  it('addSegment hält die Auswahl fest und sortiert nach Start', () => {
    const store = loadVideo(30)
    store.setStart(10)
    store.setEnd(15)
    store.addSegment()
    // Nach dem Hinzufügen ist der Entwurf leer (an der Position) -> Ende zuerst.
    store.markEnd(6)
    store.markStart(2)
    store.addSegment()
    expect(store.segments).toEqual([
      { start: 2, end: 6 },
      { start: 10, end: 15 },
    ])
    // Bei vorhandener Liste zählt die Liste, nicht die aktuelle Auswahl.
    expect(store.effectiveSegments).toEqual(store.segments)
  })

  it('addSegment ignoriert exakte Duplikate', () => {
    const store = loadVideo(30)
    store.setStart(3)
    store.setEnd(8)
    store.addSegment()
    store.addSegment()
    expect(store.segments).toHaveLength(1)
  })

  it('removeSegment und clearSegments leeren die Liste', () => {
    const store = loadVideo(30)
    store.setStart(1)
    store.setEnd(4)
    store.addSegment()
    store.setEnd(14)
    store.setStart(10)
    store.addSegment()
    store.removeSegment(0)
    expect(store.segments).toEqual([{ start: 10, end: 14 }])
    store.clearSegments()
    expect(store.segments).toHaveLength(0)
  })

  it('markStart setzt Start absolut und zieht das Ende bei Bedarf mit', () => {
    const store = loadVideo(30)
    store.setEnd(10) // Auswahl [0, 10]
    store.markStart(20) // Wiedergabeposition hinter dem alten Ende
    expect(store.startTime).toBe(20)
    expect(store.endTime).toBe(20) // Ende mitgezogen
  })

  it('markEnd setzt Ende absolut und zieht den Start bei Bedarf mit', () => {
    const store = loadVideo(30)
    store.setStart(15) // Auswahl [15, 30]
    store.markEnd(8) // Wiedergabeposition vor dem Start
    expect(store.endTime).toBe(8)
    expect(store.startTime).toBe(8)
  })

  it('markStart/markEnd bauen einen neuen Ausschnitt aus der Wiedergabe auf', () => {
    const store = loadVideo(60)
    // Ersten Ausschnitt festhalten.
    store.setStart(2)
    store.setEnd(6)
    store.addSegment()
    // Neuen Ausschnitt per Wiedergabeposition markieren (weiter hinten).
    store.markStart(30)
    store.markEnd(40)
    store.addSegment()
    expect(store.segments).toEqual([
      { start: 2, end: 6 },
      { start: 30, end: 40 },
    ])
  })

  it('addSegment setzt den Entwurf auf die Wiedergabeposition zurück', () => {
    const store = loadVideo(30)
    store.setCurrentTime(12)
    store.setStart(4)
    store.setEnd(9)
    store.addSegment()
    expect(store.startTime).toBe(12)
    expect(store.endTime).toBe(12)
  })

  it('setFile leert eine bestehende Segmentliste', () => {
    const store = loadVideo(30)
    store.setStart(1)
    store.setEnd(4)
    store.addSegment()
    expect(store.segments).toHaveLength(1)
    store.setFile(new File([new Uint8Array([0])], 'neu.mp4', { type: 'video/mp4' }))
    expect(store.segments).toHaveLength(0)
  })
})

describe('videoEditor store – Undo/Redo', () => {
  it('macht eine Auswahländerung rückgängig und stellt sie wieder her', () => {
    const store = loadVideo(30)
    expect(store.canUndo).toBe(false)
    store.setStart(5)
    store.setEnd(20)
    store.commitHistory() // eine Änderungsserie = ein Schritt
    expect(store.canUndo).toBe(true)

    store.undo()
    expect(store.startTime).toBe(0)
    expect(store.endTime).toBe(30)
    expect(store.canRedo).toBe(true)

    store.redo()
    expect(store.startTime).toBe(5)
    expect(store.endTime).toBe(20)
  })

  it('macht das Hinzufügen eines Ausschnitts rückgängig', () => {
    const store = loadVideo(30)
    store.setStart(2)
    store.setEnd(8)
    store.commitHistory()
    store.addSegment()
    store.commitHistory()
    expect(store.segments).toHaveLength(1)

    store.undo()
    expect(store.segments).toHaveLength(0)
    expect(store.startTime).toBe(2)
    expect(store.endTime).toBe(8)
  })

  it('deckt Modus und Aktion ab', () => {
    const store = loadVideo(30)
    store.setOperation('remove')
    store.commitHistory()
    expect(store.operation).toBe('remove')
    store.undo()
    expect(store.operation).toBe('keep')

    store.setMode('reencode')
    store.commitHistory()
    store.undo()
    expect(store.mode).toBe('copy')
  })

  it('eine neue Änderung verwirft den Redo-Zweig', () => {
    const store = loadVideo(30)
    store.setStart(5)
    store.commitHistory()
    store.undo()
    expect(store.canRedo).toBe(true)
    store.setStart(9)
    store.commitHistory()
    expect(store.canRedo).toBe(false)
  })

  it('mehrere Schritte werden in umgekehrter Reihenfolge rückgängig gemacht', () => {
    const store = loadVideo(30)
    store.setStart(5)
    store.commitHistory() // Schritt 1
    store.setStart(10)
    store.commitHistory() // Schritt 2
    expect(store.startTime).toBe(10)
    store.undo()
    expect(store.startTime).toBe(5)
    store.undo()
    expect(store.startTime).toBe(0)
    expect(store.canUndo).toBe(false)
  })

  it('History reicht nicht über einen Videowechsel hinaus', () => {
    const store = loadVideo(30)
    store.setStart(5)
    store.commitHistory()
    expect(store.canUndo).toBe(true)
    // Neues Video laden -> History-Ausgangspunkt zurücksetzen.
    store.setFile(new File([new Uint8Array([0])], 'neu.mp4', { type: 'video/mp4' }))
    store.setDuration(40)
    expect(store.canUndo).toBe(false)
    expect(store.canRedo).toBe(false)
  })

  it('unverändert -> kein Undo-Schritt', () => {
    const store = loadVideo(30)
    store.commitHistory()
    expect(store.canUndo).toBe(false)
  })
})
