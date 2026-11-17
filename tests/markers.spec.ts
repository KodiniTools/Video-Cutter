import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { i18n } from '@/i18n'
import TimelineView from '@/components/timeline/TimelineView.vue'
import { useTimelineStore } from '@/stores/timeline'
import { chapterList, chapterTime, neighbourMarker } from '@/timeline/markers'
import { buildTimelineProject, parseTimelineProject } from '@/timeline/projectFile'
import {
  addMarker,
  createDoc,
  MAX_MARKERS,
  removeMarker,
  secondsToTime as s,
  snapPoints,
  updateMarker,
  validateDoc,
  type OpResult,
  type TimelineDoc,
} from '@/timeline/model'

vi.mock('@/lib/mediaApi', () => ({
  UPLOAD_ABORTED: 'UPLOAD_ABORTED',
  uploadMedia: vi.fn(),
  deleteMedia: vi.fn(() => Promise.resolve()),
}))

const must = (r: OpResult): TimelineDoc => {
  if (!r.ok) throw new Error(r.error)
  return r.doc
}
const error = (r: OpResult) => (r.ok ? null : r.error)

describe('Marker: Befehle', () => {
  it('setzt Marker sortiert, je Stelle nur einen', () => {
    let doc = must(addMarker(createDoc(), { id: 'b', at: s(5), label: '  Haupt   teil ' }))
    doc = must(addMarker(doc, { id: 'a', at: s(1) }))
    expect(doc.markers).toEqual([
      { id: 'a', at: s(1), label: '' },
      { id: 'b', at: s(5), label: 'Haupt teil' },
    ])
    expect(validateDoc(doc)).toEqual([])
    expect(must(addMarker(doc, { at: s(5), label: 'doppelt' }))).toBe(doc)
    expect(error(addMarker(doc, { id: 'a', at: s(2) }))).toBe('duplicate-id')
    expect(error(addMarker(doc, { at: -1 }))).toBe('invalid-time')
    expect(error(addMarker(doc, { at: 1.5 }))).toBe('invalid-time')
  })

  it('begrenzt die Anzahl und die Länge des Namens', () => {
    let doc = createDoc()
    for (let i = 0; i < MAX_MARKERS; i++) doc = must(addMarker(doc, { at: i }))
    expect(error(addMarker(doc, { at: s(9) }))).toBe('too-many')
    const long = must(addMarker(createDoc(), { id: 'm', at: 0, label: 'x'.repeat(200) }))
    expect(long.markers[0].label).toHaveLength(60)
  })

  it('benennt um, verschiebt und löscht', () => {
    let doc = must(addMarker(createDoc(), { id: 'a', at: s(1), label: 'Intro' }))
    doc = must(addMarker(doc, { id: 'b', at: s(5) }))
    expect(must(updateMarker(doc, 'a', { label: 'Intro' }))).toBe(doc)
    const moved = must(updateMarker(doc, 'a', { at: s(8), label: 'Ende' }))
    expect(moved.markers.map((m) => [m.id, m.at, m.label])).toEqual([
      ['b', s(5), ''],
      ['a', s(8), 'Ende'],
    ])
    expect(error(updateMarker(doc, 'a', { at: s(5) }))).toBe('overlap')
    expect(error(updateMarker(doc, 'x', { label: 'a' }))).toBe('marker-not-found')
    expect(error(updateMarker(doc, 'a', { at: -5 }))).toBe('invalid-time')
    expect(must(removeMarker(doc, 'a')).markers.map((m) => m.id)).toEqual(['b'])
    expect(error(removeMarker(doc, 'x'))).toBe('marker-not-found')
  })

  it('rastet an Markern ein, aber nicht am gezogenen selbst', () => {
    const doc = must(addMarker(createDoc(), { id: 'a', at: s(3) }))
    expect(snapPoints(doc)).toContain(s(3))
    expect(snapPoints(doc, { exclude: ['a'] })).not.toContain(s(3))
  })

  it('übersteht Speichern und Öffnen', () => {
    const doc = must(addMarker(createDoc(), { id: 'a', at: s(3), label: 'Teil 2' }))
    const back = parseTimelineProject(JSON.parse(JSON.stringify(buildTimelineProject(doc, {}))))
    expect(back.doc.markers).toEqual(doc.markers)
  })
})

describe('Marker: Kapitelliste und Springen', () => {
  const markers = [
    { id: 'b', at: s(75.9), label: 'Hauptteil' },
    { id: 'a', at: 0, label: 'Intro' },
    { id: 'c', at: s(3725), label: '' },
  ]

  it('schreibt Zeiten wie in Videobeschreibungen', () => {
    expect(chapterTime(0)).toBe('0:00')
    expect(chapterTime(s(75.9))).toBe('1:15')
    expect(chapterTime(s(3725))).toBe('1:02:05')
    expect(chapterList(markers)).toBe('0:00 Intro\n1:15 Hauptteil\n1:02:05 Kapitel 3')
    expect(chapterList([])).toBe('')
  })

  it('findet den nächsten und den vorherigen Marker', () => {
    expect(neighbourMarker(markers, 0, 1)?.id).toBe('b')
    expect(neighbourMarker(markers, s(80), 1)?.id).toBe('c')
    expect(neighbourMarker(markers, s(3725), 1)).toBeNull()
    expect(neighbourMarker(markers, s(80), -1)?.id).toBe('b')
    expect(neighbourMarker(markers, 0, -1)).toBeNull()
  })
})

describe('Marker im Editor', () => {
  beforeEach(() => setActivePinia(createPinia()))

  function fill() {
    const store = useTimelineStore()
    store.putAsset({
      id: 'vid',
      kind: 'video',
      name: 'a.mp4',
      duration: s(10),
      width: 1920,
      height: 1080,
      fps: 25,
      hasAudio: false,
    })
    store.appendMedia('vid')
    return store
  }

  it('Store: setzen am Abspielkopf, rückgängig, springen, ziehen mit Einrasten', () => {
    const store = fill()
    store.seek(s(2))
    const id = store.addMarkerAtPlayhead('Intro')
    expect(id).not.toBeNull()
    expect(store.addMarkerAtPlayhead()).toBe(id)
    expect(store.doc.markers).toHaveLength(1)
    store.seek(s(6))
    store.addMarkerAtPlayhead()
    store.seek(0)
    expect(store.jumpToMarker(1)).toBe(id)
    expect(store.playhead).toBe(s(2))
    store.jumpToMarker(1)
    expect(store.playhead).toBe(s(6))
    expect(store.jumpToMarker(1)).toBeNull()
    store.jumpToMarker(-1)
    expect(store.playhead).toBe(s(2))
    // Nahe am Clip-Ende (10 s) rastet der Marker dort ein, sonst aufs Bildraster.
    if (id) {
      store.dragMarkerTo(id, s(9.97))
      expect(store.doc.markers.find((m) => m.id === id)?.at).toBe(s(10))
      store.dragMarkerTo(id, s(4.011))
      expect(store.doc.markers.find((m) => m.id === id)?.at).toBe(s(4))
    }
    store.undo()
    store.undo()
    store.undo()
    expect(store.doc.markers.map((m) => m.at)).toEqual([s(2)])
  })

  it('Ansicht: Knopf, Fähnchen, Name, Löschen', async () => {
    const store = fill()
    const wrapper = mount(TimelineView, { global: { plugins: [i18n] }, attachTo: document.body })
    await nextTick()
    expect(wrapper.find('[data-testid=marker-bar]').exists()).toBe(false)
    store.seek(s(3))
    await wrapper.get('[data-testid=timeline-add-marker]').trigger('click')
    await nextTick()
    const flag = wrapper.get('.marker')
    expect(flag.attributes('style')).toContain('left: 300px')
    expect(flag.classes()).toContain('active')
    const name = wrapper.get('[data-testid=timeline-marker-name]')
    ;(name.element as HTMLInputElement).value = 'Intro'
    await name.trigger('change')
    expect(store.doc.markers[0].label).toBe('Intro')
    expect(wrapper.get('.marker').text()).toBe('Intro')

    // Zweiter Marker per Taste M, dann den ersten anklicken.
    store.seek(s(7))
    await wrapper.get('[data-testid=timeline]').trigger('keydown', { key: 'm' })
    await nextTick()
    expect(store.doc.markers).toHaveLength(2)
    await wrapper.findAll('.marker')[0].trigger('click')
    expect(store.playhead).toBe(s(3))
    expect(
      (wrapper.get('[data-testid=timeline-marker-name]').element as HTMLInputElement).value,
    ).toBe('Intro')
    await wrapper.get('[data-testid=timeline-next-marker]').trigger('click')
    expect(store.playhead).toBe(s(7))

    await wrapper.get('[data-testid=timeline-marker-remove]').trigger('click')
    expect(store.doc.markers.map((m) => m.label)).toEqual(['Intro'])
    expect(wrapper.find('[data-testid=timeline-marker-name]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('Ansicht: kopiert die Kapitelliste', async () => {
    const store = fill()
    store.addMarkerAtPlayhead('Intro')
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const wrapper = mount(TimelineView, { global: { plugins: [i18n] }, attachTo: document.body })
    await nextTick()
    await wrapper.get('[data-testid=timeline-copy-chapters]').trigger('click')
    await nextTick()
    expect(writeText).toHaveBeenCalledWith('0:00 Intro')
    expect(wrapper.get('[data-testid=marker-bar]').text()).toContain('Kapitelliste kopiert.')
    wrapper.unmount()
  })
})
