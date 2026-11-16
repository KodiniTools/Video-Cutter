import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import ClipInspector from '@/components/timeline/ClipInspector.vue'
import { i18n } from '@/i18n'
import { useTimelineStore } from '@/stores/timeline'
import { checkLossless } from '@/timeline/lossless'
import {
  appendMedia,
  createDoc,
  normalizeColor,
  putAsset,
  setClipColor,
  splitClip,
  updateTrack,
  validateDoc,
  type AssetRef,
  type OpResult,
  type TimelineDoc,
  type VideoClip,
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
  hasAudio: false,
})
const must = (r: OpResult): TimelineDoc => {
  if (!r.ok) throw new Error(r.error)
  return r.doc
}
const error = (r: OpResult) => (r.ok ? null : r.error)
const videos = (doc: TimelineDoc): VideoClip[] =>
  (doc.tracks.find((t) => t.kind === 'video')?.clips ?? []) as VideoClip[]
const oneClip = (): TimelineDoc => must(appendMedia(putAsset(createDoc(), asset('a')), 'a'))

describe('setClipColor', () => {
  it('setzt die Werte in den Grenzen −1 … 1, auf Hundertstel gerundet', () => {
    const doc = oneClip()
    const id = videos(doc)[0].id
    const next = must(setClipColor(doc, id, { brightness: 2, contrast: -0.256, saturation: -3 }))
    expect(videos(next)[0].color).toEqual({ brightness: 1, contrast: -0.26, saturation: -1 })
    expect(validateDoc(next)).toEqual([])
    expect(must(setClipColor(next, id, { brightness: 1, contrast: -0.26, saturation: -1 }))).toBe(
      next,
    )
  })

  it('alles auf 0 (oder null) hebt die Korrektur auf', () => {
    const doc = oneClip()
    const id = videos(doc)[0].id
    const set = must(setClipColor(doc, id, { brightness: 0.2, contrast: 0, saturation: 0 }))
    const zero = must(setClipColor(set, id, { brightness: 0, contrast: 0, saturation: 0 }))
    expect(videos(zero)[0]).not.toHaveProperty('color')
    expect(videos(must(setClipColor(set, id, null)))[0]).not.toHaveProperty('color')
    expect(must(setClipColor(doc, id, null))).toBe(doc)
    expect(normalizeColor({ brightness: NaN, contrast: 0, saturation: 0 })).toBeNull()
    // Kein „−0“ im Dokument.
    expect(
      Object.is(normalizeColor({ brightness: 0.5, contrast: -0.001, saturation: 0 })?.contrast, 0),
    ).toBe(true)
  })

  it('bleibt beim Teilen an beiden Teilen; lehnt Unpassendes ab', () => {
    const doc = oneClip()
    const id = videos(doc)[0].id
    const set = must(setClipColor(doc, id, { brightness: 0.2, contrast: 0.1, saturation: -1 }))
    const parts = videos(must(splitClip(set, id, 4 * S)))
    expect(parts.map((c) => c.color?.saturation)).toEqual([-1, -1])
    expect(error(setClipColor(doc, 'nix', null))).toBe('clip-not-found')
    const locked = must(updateTrack(doc, doc.tracks[0].id, { locked: true }))
    expect(error(setClipColor(locked, id, null))).toBe('track-locked')
    const broken = structuredClone(set)
    ;(broken.tracks[0].clips[0] as VideoClip).color = { brightness: 5, contrast: 0, saturation: 0 }
    expect(validateDoc(broken).length).toBeGreaterThan(0)
    expect(checkLossless(set, () => undefined)).toMatchObject({ ok: false, reason: 'color' })
  })
})

describe('Farbkorrektur im Feld „Clip“', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('Regler und Zurücksetzen; Ziehen ist ein Rückgängig-Schritt', async () => {
    const store = useTimelineStore()
    store.load(oneClip())
    store.select([videos(store.doc)[0].id])
    const wrapper = mount(ClipInspector, { global: { plugins: [i18n] } })
    const clip = () => videos(store.doc)[0]
    const drag = async (field: string, values: number[]) => {
      const input = wrapper.get(`[data-testid=clip-color-${field}]`)
      for (const v of values) {
        ;(input.element as HTMLInputElement).value = String(v)
        await input.trigger('input')
      }
      await input.trigger('change')
    }
    expect(wrapper.find('[data-testid=clip-color-reset]').exists()).toBe(false)
    await drag('saturation', [-30, -60, -100])
    expect(clip().color).toEqual({ brightness: 0, contrast: 0, saturation: -1 })
    await drag('brightness', [25])
    expect(clip().color).toEqual({ brightness: 0.25, contrast: 0, saturation: -1 })
    expect(wrapper.get('[data-testid=clip-color]').text()).toContain('+25')
    store.undo()
    expect(clip().color).toEqual({ brightness: 0, contrast: 0, saturation: -1 })
    store.undo()
    expect(clip()).not.toHaveProperty('color')
    store.redo()
    await wrapper.get('[data-testid=clip-color-reset]').trigger('click')
    expect(clip()).not.toHaveProperty('color')
  })
})
