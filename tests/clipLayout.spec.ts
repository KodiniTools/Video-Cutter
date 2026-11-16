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
  MIN_LAYOUT_SCALE,
  normalizeLayout,
  putAsset,
  setClipLayout,
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

describe('setClipLayout', () => {
  it('setzt Größe, Lage und Deckkraft in gültigen Grenzen', () => {
    const doc = oneClip()
    const id = videos(doc)[0].id
    const next = must(setClipLayout(doc, id, { x: 1.4, y: -1, scale: 0.001, opacity: 0.5 }))
    expect(videos(next)[0].layout).toEqual({ x: 1, y: 0, scale: MIN_LAYOUT_SCALE, opacity: 0.5 })
    expect(validateDoc(next)).toEqual([])
    // Unverändert: dasselbe Dokument (kein Rückgängig-Schritt).
    expect(must(setClipLayout(next, id, { x: 1, y: 0, scale: 0.05, opacity: 0.5 }))).toBe(next)
  })

  it('volle Größe und Deckkraft (oder null) hebt die Lage auf', () => {
    const doc = oneClip()
    const id = videos(doc)[0].id
    const small = must(setClipLayout(doc, id, { x: 0.2, y: 0.2, scale: 0.4, opacity: 1 }))
    const full = must(setClipLayout(small, id, { x: 0.2, y: 0.2, scale: 1, opacity: 1 }))
    expect(videos(full)[0]).not.toHaveProperty('layout')
    expect(videos(must(setClipLayout(small, id, null)))[0]).not.toHaveProperty('layout')
    expect(must(setClipLayout(doc, id, null))).toBe(doc)
    expect(normalizeLayout({ x: NaN, y: 0, scale: 0.5, opacity: 1 })).toBeNull()
    // Nur durchscheinend, volle Größe: bleibt.
    expect(normalizeLayout({ x: 0.5, y: 0.5, scale: 1, opacity: 0.3 })?.opacity).toBe(0.3)
  })

  it('bleibt beim Teilen an beiden Teilen; lehnt Unpassendes ab', () => {
    const doc = oneClip()
    const id = videos(doc)[0].id
    const small = must(setClipLayout(doc, id, { x: 0.2, y: 0.2, scale: 0.4, opacity: 1 }))
    const parts = videos(must(splitClip(small, id, 4 * S)))
    expect(parts.map((c) => c.layout?.scale)).toEqual([0.4, 0.4])
    expect(error(setClipLayout(doc, 'nix', null))).toBe('clip-not-found')
    const locked = must(updateTrack(doc, doc.tracks[0].id, { locked: true }))
    expect(error(setClipLayout(locked, id, null))).toBe('track-locked')
    // Ungültige Werte im Dokument fallen bei der Prüfung auf.
    const broken = structuredClone(small)
    ;(broken.tracks[0].clips[0] as VideoClip).layout = { x: 0.5, y: 0.5, scale: 3, opacity: 1 }
    expect(validateDoc(broken).length).toBeGreaterThan(0)
  })

  it('schließt den verlustfreien Export aus', () => {
    const doc = oneClip()
    const small = must(
      setClipLayout(doc, videos(doc)[0].id, { x: 0.5, y: 0.5, scale: 0.5, opacity: 1 }),
    )
    expect(checkLossless(small, () => undefined)).toMatchObject({ ok: false, reason: 'layout' })
  })
})

describe('Bild-in-Bild im Feld „Clip“', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('Regler, Ecken und Zurücksetzen; Ziehen ist ein Rückgängig-Schritt', async () => {
    const store = useTimelineStore()
    store.load(oneClip())
    const id = videos(store.doc)[0].id
    store.select([id])
    const wrapper = mount(ClipInspector, { global: { plugins: [i18n] } })
    const clip = () => videos(store.doc)[0]
    const drag = async (field: string, values: number[]) => {
      const input = wrapper.get(`[data-testid=clip-layout-${field}]`)
      for (const v of values) {
        ;(input.element as HTMLInputElement).value = String(v)
        await input.trigger('input')
      }
      await input.trigger('change')
    }
    // In voller Größe gibt es nichts zu verschieben und nichts zurückzusetzen.
    expect(wrapper.get('[data-testid=clip-layout-x]').attributes('disabled')).toBeDefined()
    expect(wrapper.find('[data-testid=clip-layout-reset]').exists()).toBe(false)

    await drag('scale', [80, 60, 40])
    expect(clip().layout).toEqual({ x: 0.5, y: 0.5, scale: 0.4, opacity: 1 })
    expect(wrapper.get('[data-testid=clip-layout-x]').attributes('disabled')).toBeUndefined()
    store.undo()
    expect(clip()).not.toHaveProperty('layout')
    store.redo()

    await drag('x', [80])
    await drag('opacity', [70])
    expect(clip().layout).toEqual({ x: 0.8, y: 0.5, scale: 0.4, opacity: 0.7 })

    await wrapper.get('[data-testid=clip-layout-bottomRight]').trigger('click')
    expect(clip().layout).toEqual({ x: 0.77, y: 0.77, scale: 0.4, opacity: 0.7 })
    await wrapper.get('[data-testid=clip-layout-reset]').trigger('click')
    expect(clip()).not.toHaveProperty('layout')

    // Ecke aus voller Größe: auf ein Drittel verkleinert.
    await wrapper.get('[data-testid=clip-layout-topLeft]').trigger('click')
    expect(clip().layout).toEqual({ x: 0.195, y: 0.195, scale: 0.33, opacity: 1 })
  })
})
