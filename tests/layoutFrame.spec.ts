import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import PositionFrame from '@/components/timeline/PositionFrame.vue'
import { i18n } from '@/i18n'
import { useTimelineStore } from '@/stores/timeline'
import {
  appendMedia,
  createDoc,
  putAsset,
  setClipLayout,
  type AssetRef,
  type OpResult,
  type TimelineDoc,
  type VideoClip,
} from '@/timeline/model'

const asset: AssetRef = {
  id: 'a',
  kind: 'video',
  name: 'a.mp4',
  duration: 10_000_000,
  width: 1280,
  height: 720,
  fps: 25,
  hasAudio: true,
}
const must = (r: OpResult): TimelineDoc => {
  if (!r.ok) throw new Error(r.error)
  return r.doc
}
const video = (doc: TimelineDoc) =>
  doc.tracks.find((t) => t.kind === 'video')?.clips[0] as VideoClip

describe('Positionsrahmen für Bild-in-Bild', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    // jsdom kennt kein Layout: Der Player ist 800 × 450 groß (16:9, ohne Ränder).
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800)
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(450)
    HTMLElement.prototype.setPointerCapture = () => {}
  })
  afterEach(() => vi.restoreAllMocks())

  function setup(layout: { x: number; y: number; scale: number; opacity: number } | null) {
    const store = useTimelineStore()
    let doc = must(appendMedia(putAsset(createDoc(), asset), 'a'))
    if (layout) doc = must(setClipLayout(doc, video(doc).id, layout))
    store.load(doc)
    // Bild und verknüpfter Ton sind gemeinsam markiert.
    store.select(doc.tracks.flatMap((t) => t.clips.map((c) => c.id)))
    return { store, wrapper: mount(PositionFrame, { global: { plugins: [i18n] } }) }
  }

  it('zeigt den Rahmen nur für einen verkleinerten Clip, um dessen Bild', async () => {
    const full = setup(null)
    await full.wrapper.vm.$nextTick()
    expect(full.wrapper.find('[data-testid=position-frame]').exists()).toBe(false)

    setActivePinia(createPinia())
    const { wrapper } = setup({ x: 1, y: 1, scale: 0.4, opacity: 1 })
    await wrapper.vm.$nextTick()
    const frame = wrapper.get('[data-testid=position-frame]')
    // Mitte (1, 1) rückt so weit herein, dass das Bild ganz im Format liegt.
    expect(frame.attributes('style')).toContain('left: 80%')
    expect(frame.attributes('style')).toContain('top: 80%')
    expect(frame.attributes('style')).toContain('width: 40%')
    expect(wrapper.find('[data-testid=position-frame-resize]').exists()).toBe(true)
  })

  it('Ziehen und Pfeiltasten verschieben, begrenzt auf das Format', async () => {
    const { store, wrapper } = setup({ x: 0.5, y: 0.5, scale: 0.4, opacity: 0.8 })
    await wrapper.vm.$nextTick()
    const frame = wrapper.get('[data-testid=position-frame]')
    await frame.trigger('pointerdown', { button: 0, clientX: 400, clientY: 225, pointerId: 1 })
    await frame.trigger('pointermove', { clientX: 480, clientY: 180 })
    await frame.trigger('pointerup')
    expect(video(store.doc).layout).toEqual({ x: 0.6, y: 0.4, scale: 0.4, opacity: 0.8 })
    // Weit hinaus: bleibt ganz im Bild (Mitte höchstens 1 − halbe Breite).
    await frame.trigger('pointerdown', { button: 0, clientX: 400, clientY: 225, pointerId: 1 })
    await frame.trigger('pointermove', { clientX: 2000, clientY: 2000 })
    await frame.trigger('pointerup')
    expect(video(store.doc).layout).toMatchObject({ x: 0.8, y: 0.8 })
    await frame.trigger('keydown', { key: 'ArrowLeft', shiftKey: true })
    expect(video(store.doc).layout).toMatchObject({ x: 0.75, y: 0.8 })
    store.undo()
    expect(video(store.doc).layout).toMatchObject({ x: 0.8, y: 0.8 })
  })

  it('der Griff ändert die Größe', async () => {
    const { store, wrapper } = setup({ x: 0.5, y: 0.5, scale: 0.4, opacity: 1 })
    await wrapper.vm.$nextTick()
    const handle = wrapper.get('[data-testid=position-frame-resize]')
    // Mitte des Rahmens bei (400, 225); Ecke unten rechts bei (560, 315).
    await handle.trigger('pointerdown', { button: 0, clientX: 560, clientY: 315, pointerId: 1 })
    await handle.trigger('pointermove', { clientX: 640, clientY: 360 })
    expect(wrapper.get('[data-testid=position-frame]').attributes('style')).toContain('width: 60%')
    await handle.trigger('pointerup')
    expect(video(store.doc).layout).toEqual({ x: 0.5, y: 0.5, scale: 0.6, opacity: 1 })
  })
})
