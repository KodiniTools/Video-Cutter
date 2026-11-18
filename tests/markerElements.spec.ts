import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { i18n } from '@/i18n'
import TimelineView from '@/components/timeline/TimelineView.vue'
import { useTimelineStore } from '@/stores/timeline'
import { checkLossless } from '@/timeline/lossless'
import { buildTimelineProject, parseTimelineProject } from '@/timeline/projectFile'
import {
  addMarker,
  addTrack,
  bindClipsToMarker,
  createDoc,
  DEFAULT_MARKER_EFFECTS,
  isMarkerEffect,
  setMarkerEffect,
  findClip,
  insertClip,
  markerClipIds,
  removeMarker,
  secondsToTime as s,
  unbindClip,
  updateMarker,
  type OpResult,
  type OverlayClip,
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
const text = (id: string, start: number, duration = s(2)): OverlayClip => ({
  id,
  kind: 'text',
  start,
  duration,
  data: { text: id },
})
const startOf = (doc: TimelineDoc, id: string) => findClip(doc, id)?.clip.start

/** Zwei Ebenen-Spuren, Marker „m“ bei 5 s, Texte a (1 s) und b (8 s) auf T1, c (0 s) auf T2. */
function base(): TimelineDoc {
  let doc = createDoc()
  doc = must(addTrack(doc, { id: 'T1', kind: 'overlay', name: 'T1' }))
  doc = must(addTrack(doc, { id: 'T2', kind: 'overlay', name: 'T2' }))
  doc = must(insertClip(doc, 'T1', text('a', s(1))))
  doc = must(insertClip(doc, 'T1', text('b', s(8))))
  doc = must(insertClip(doc, 'T2', text('c', 0)))
  return must(addMarker(doc, { id: 'm', at: s(5), label: 'Drop' }))
}

describe('Clips am Marker: Befehle', () => {
  it('bindet als Gruppe: der früheste beginnt am Marker, Abstände bleiben', () => {
    const doc = must(bindClipsToMarker(base(), 'm', ['a', 'c']))
    // c (0 s) ist der früheste → an 5 s; a war 1 s später → 6 s.
    expect(startOf(doc, 'c')).toBe(s(5))
    expect(startOf(doc, 'a')).toBe(s(6))
    expect(markerClipIds(doc, 'm').sort()).toEqual(['a', 'c'])
    expect(startOf(doc, 'b')).toBe(s(8))
  })

  it('verschiebt gebundene Clips mit dem Marker, ungebundene bleiben', () => {
    let doc = must(bindClipsToMarker(base(), 'm', ['c']))
    doc = must(updateMarker(doc, 'm', { at: s(3) }))
    expect(doc.markers[0].at).toBe(s(3))
    expect(startOf(doc, 'c')).toBe(s(3))
    expect(startOf(doc, 'a')).toBe(s(1))
    // Nur umbenennen bewegt nichts.
    const renamed = must(updateMarker(doc, 'm', { label: 'Neu' }))
    expect(startOf(renamed, 'c')).toBe(s(3))
  })

  it('lehnt ab, wenn ein gebundener Clip anstoßen oder vor 0 rutschen würde', () => {
    const doc = must(bindClipsToMarker(base(), 'm', ['a']))
    // a liegt 5–7 s; bei Marker 7,5 s läge a auf 7,5–9,5 s und stieße an b (8 s).
    expect(error(updateMarker(doc, 'm', { at: s(7.5) }))).toBe('overlap')
    expect(doc.markers[0].at).toBe(s(5))
    // Gruppe aus d (4 s) und a (5 s): d rückt an den Marker, a um denselben Betrag.
    const before = must(insertClip(doc, 'T2', text('d', s(4), s(0.5))))
    const bound = must(bindClipsToMarker(before, 'm', ['d', 'a']))
    expect(startOf(bound, 'd')).toBe(s(5))
    expect(error(bindClipsToMarker(base(), 'x', ['a']))).toBe('marker-not-found')
    expect(error(bindClipsToMarker(base(), 'm', ['zz']))).toBe('clip-not-found')
  })

  it('lehnt auf gesperrter Spur ab', () => {
    let doc = must(bindClipsToMarker(base(), 'm', ['c']))
    doc = {
      ...doc,
      tracks: doc.tracks.map((t) => (t.id === 'T2' ? { ...t, locked: true } : t)),
    }
    expect(error(updateMarker(doc, 'm', { at: s(2) }))).toBe('track-locked')
  })

  it('lösen und Marker löschen lassen die Clips liegen', () => {
    let doc = must(bindClipsToMarker(base(), 'm', ['a', 'c']))
    doc = must(unbindClip(doc, 'a'))
    expect(findClip(doc, 'a')?.clip.marker).toBeUndefined()
    expect(markerClipIds(doc, 'm')).toEqual(['c'])
    doc = must(removeMarker(doc, 'm'))
    expect(doc.markers).toEqual([])
    expect(startOf(doc, 'c')).toBe(s(5))
    expect(findClip(doc, 'c')?.clip.marker).toBeUndefined()
  })

  it('übersteht Speichern und Öffnen', () => {
    const doc = must(bindClipsToMarker(base(), 'm', ['c']))
    const back = parseTimelineProject(JSON.parse(JSON.stringify(buildTimelineProject(doc, {}))))
    expect(findClip(back.doc, 'c')?.clip.marker).toBe('m')
  })
})

describe('Clips am Marker im Editor', () => {
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
    store.putAsset({ id: 'snd', kind: 'audio', name: 'drop.wav', duration: s(1) })
    store.appendMedia('vid')
    store.seek(s(4))
    const id = store.addMarkerAtPlayhead('Drop')
    if (!id) throw new Error('kein Marker')
    store.seek(0)
    store.select([])
    return { store, id }
  }

  it('Store: Element am Marker ist ein Verlaufsschritt und wandert mit', () => {
    const { store, id } = fill()
    const steps = () => store.canUndo
    expect(steps()).toBe(true)
    expect(store.addAtMarker(id, () => store.insertAudioAt('snd', store.playhead))).toBe(true)
    const [clipId] = store.selection
    expect(findClip(store.doc, clipId)?.clip).toMatchObject({ start: s(4), marker: id })
    store.dragMarkerTo(id, s(6))
    expect(startOf(store.doc, clipId)).toBe(s(6))
    store.undo()
    expect(startOf(store.doc, clipId)).toBe(s(4))
    store.undo()
    expect(findClip(store.doc, clipId)).toBeNull()
    // Ein fehlschlagendes Anlegen hinterlässt nichts.
    const before = store.doc
    expect(store.addAtMarker(id, () => false)).toBe(false)
    expect(store.doc).toBe(before)
  })

  it('Ansicht: + Am Marker, Liste, Zeichen am Fähnchen, Lösen', async () => {
    const { store } = fill()
    const wrapper = mount(TimelineView, { global: { plugins: [i18n] }, attachTo: document.body })
    await nextTick()
    await wrapper.get('.marker').trigger('click')
    const add = wrapper.get('[data-testid=timeline-marker-add]')
    expect(add.findAll('option').map((o) => o.text())).toContain('drop.wav')
    ;(add.element as HTMLSelectElement).value = 'text'
    await add.trigger('change')
    await nextTick()
    const textClip = store.selectedClips[0]
    expect(textClip).toMatchObject({ kind: 'text', start: s(4) })
    expect(wrapper.get('[data-testid=timeline-marker-count]').text()).toBe('⚡1')
    expect(wrapper.get('[data-testid=timeline-marker-elements]').text()).toContain('Text')
    expect(
      wrapper.find(`[data-clip="${textClip.id}"] [data-testid=clip-marker-bound]`).exists(),
    ).toBe(true)

    ;(add.element as HTMLSelectElement).value = 'graphic:emoji'
    await add.trigger('change')
    await nextTick()
    expect(wrapper.get('[data-testid=timeline-marker-count]').text()).toBe('⚡2')

    await wrapper.findAll('[data-testid=timeline-marker-unbind]')[0].trigger('click')
    await nextTick()
    expect(wrapper.get('[data-testid=timeline-marker-count]').text()).toBe('⚡1')
    wrapper.unmount()
  })

  it('Ansicht: markierten Video-Clip anbinden', async () => {
    const { store } = fill()
    const wrapper = mount(TimelineView, { global: { plugins: [i18n] }, attachTo: document.body })
    await nextTick()
    await wrapper.get('.marker').trigger('click')
    const bind = wrapper.get('[data-testid=timeline-marker-bind]')
    expect(bind.attributes('disabled')).toBeDefined()
    const videoId = store.doc.tracks.find((t) => t.kind === 'video')!.clips[0].id
    store.select([videoId])
    await nextTick()
    await bind.trigger('click')
    expect(startOf(store.doc, videoId)).toBe(s(4))
    expect(findClip(store.doc, videoId)?.clip.marker).toBeDefined()
    wrapper.unmount()
  })
})

describe('Drop-Effekt am Marker', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('Befehl: setzen mit Vorgaben, ändern, Art wechseln, entfernen, prüfen', () => {
    const doc = must(addMarker(createDoc(), { id: 'm', at: s(1) }))
    let next = must(setMarkerEffect(doc, 'm', { kind: 'flash' }))
    expect(next.markers[0].effect).toEqual(DEFAULT_MARKER_EFFECTS.flash)
    next = must(setMarkerEffect(next, 'm', { intensity: 0.5, color: '#00FF00' }))
    expect(next.markers[0].effect).toMatchObject({
      kind: 'flash',
      intensity: 0.5,
      color: '#00ff00',
    })
    next = must(setMarkerEffect(next, 'm', { kind: 'strobe' }))
    expect(next.markers[0].effect).toEqual(DEFAULT_MARKER_EFFECTS.strobe)
    expect(error(setMarkerEffect(next, 'm', { rate: 99 }))).toBe('invalid-time')
    expect(error(setMarkerEffect(next, 'm', { intensity: 0 }))).toBe('invalid-time')
    expect(error(setMarkerEffect(next, 'x', null))).toBe('marker-not-found')
    // Verschieben behält den Effekt, Entfernen nimmt ihn weg.
    const moved = must(updateMarker(next, 'm', { at: s(2) }))
    expect(moved.markers[0].effect?.kind).toBe('strobe')
    expect(must(setMarkerEffect(moved, 'm', null)).markers[0]).toEqual({
      id: 'm',
      at: s(2),
      label: '',
    })
    expect(isMarkerEffect(DEFAULT_MARKER_EFFECTS.vignette)).toBe(true)
  })

  it('übersteht Speichern und Öffnen, kaputter Effekt fällt weg', () => {
    const doc = must(
      setMarkerEffect(must(addMarker(createDoc(), { id: 'm', at: s(1) })), 'm', { kind: 'burst' }),
    )
    const raw = JSON.parse(JSON.stringify(buildTimelineProject(doc, {})))
    expect(parseTimelineProject(raw).doc.markers[0].effect).toEqual(DEFAULT_MARKER_EFFECTS.burst)
    raw.doc.markers[0].effect.kind = 'laser'
    expect(parseTimelineProject(raw).doc.markers[0]).not.toHaveProperty('effect')
  })

  it('Ansicht: Art wählen, Regler ist ein Verlaufsschritt, Zeichen am Fähnchen', async () => {
    const store = useTimelineStore()
    store.putAsset({ id: 'vid', kind: 'video', name: 'a.mp4', duration: s(10) })
    store.appendMedia('vid')
    store.seek(s(2))
    store.addMarkerAtPlayhead()
    const wrapper = mount(TimelineView, { global: { plugins: [i18n] }, attachTo: document.body })
    await nextTick()
    await wrapper.get('.marker').trigger('click')
    expect(wrapper.find('[data-testid=marker-effect-intensity]').exists()).toBe(false)
    const kind = wrapper.get('[data-testid=marker-effect-kind]')
    ;(kind.element as HTMLSelectElement).value = 'vignette'
    await kind.trigger('change')
    expect(store.doc.markers[0].effect?.kind).toBe('vignette')
    expect(wrapper.find('[data-testid=timeline-marker-fx]').exists()).toBe(true)
    expect(wrapper.find('[data-testid=marker-effect-rate]').exists()).toBe(false)

    const slider = wrapper.get('[data-testid=marker-effect-intensity]')
    ;(slider.element as HTMLInputElement).value = '0.3'
    await slider.trigger('input')
    ;(slider.element as HTMLInputElement).value = '0.4'
    await slider.trigger('input')
    await slider.trigger('change')
    expect(store.doc.markers[0].effect?.intensity).toBe(0.4)
    store.undo()
    expect(store.doc.markers[0].effect?.intensity).toBe(DEFAULT_MARKER_EFFECTS.vignette.intensity)

    ;(kind.element as HTMLSelectElement).value = ''
    await kind.trigger('change')
    expect(store.doc.markers[0].effect).toBeUndefined()
    wrapper.unmount()
  })

  it('Verlustfrei geht mit Drop-Effekt nicht', () => {
    let doc = must(addTrack(createDoc(), { id: 'V', kind: 'video', name: 'V' }))
    doc = {
      ...doc,
      settings: { ...doc.settings, width: 640, height: 360 },
      assets: { a: { id: 'a', kind: 'video', name: 'a', duration: s(4) } },
    }
    doc = must(
      insertClip(doc, 'V', {
        id: 'v',
        kind: 'video',
        asset: 'a',
        start: 0,
        duration: s(4),
        sourceIn: 0,
        speed: 1,
      }),
    )
    const info = () => ({ width: 640, height: 360, hasAudio: false })
    expect(checkLossless(doc, info).ok).toBe(true)
    doc = must(setMarkerEffect(must(addMarker(doc, { id: 'm', at: s(1) })), 'm', { kind: 'flash' }))
    expect(checkLossless(doc, info)).toEqual({ ok: false, reason: 'effects' })
  })
})
