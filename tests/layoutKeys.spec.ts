import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import ClipInspector from '@/components/timeline/ClipInspector.vue'
import { i18n } from '@/i18n'
import { useTimelineStore } from '@/stores/timeline'
import {
  canAddKey,
  FULL_LAYOUT,
  keyIndexAt,
  layoutAt,
  motionAt,
  visibleKeys,
  withKeyAt,
  withLayoutChange,
  withoutKey,
} from '@/timeline/layoutKeys'
import {
  appendMedia,
  createDoc,
  MAX_LAYOUT_KEYS,
  normalizeLayout,
  putAsset,
  setClipLayout,
  setClipSpeed,
  splitClip,
  validateDoc,
  type AssetRef,
  type LayoutKey,
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
const videos = (doc: TimelineDoc): VideoClip[] =>
  (doc.tracks.find((t) => t.kind === 'video')?.clips ?? []) as VideoClip[]
const oneClip = (): TimelineDoc => must(appendMedia(putAsset(createDoc(), asset('a')), 'a'))
const key = (at: number, x: number, y: number, scale: number, opacity = 1): LayoutKey => ({
  at: at * S,
  x,
  y,
  scale,
  opacity,
})
const A = key(2, 0.2, 0.5, 0.25)
const B = key(6, 0.8, 0.5, 0.75)
const clipWith = (keys: LayoutKey[], over: Partial<VideoClip> = {}) =>
  ({
    sourceIn: 0,
    speed: 1,
    duration: 10 * S,
    layout: { x: keys[0]?.x ?? 0.5, y: 0.5, scale: 0.5, opacity: 0.9, keys },
    ...over,
  }) as VideoClip

describe('normalizeLayout mit Keyframes', () => {
  it('sortiert, begrenzt, behält je Zeit den letzten und spiegelt den ersten', () => {
    const out = normalizeLayout({
      x: 0.9,
      y: 0.9,
      scale: 1,
      opacity: 1,
      keys: [B, { ...A, x: 0.1 }, { at: 2 * S, x: -1, y: 2, scale: 0.001 }, key(1.5, 0, 0, 0.5)],
    })
    expect(out?.keys).toEqual([
      key(1.5, 0, 0, 0.5),
      { at: 2 * S, x: 0, y: 1, scale: 0.05, opacity: 1 },
      B,
    ])
    expect(out).toMatchObject({ x: 0, y: 0, scale: 0.5, opacity: 1 })
  })

  it('verwirft Ungültiges, begrenzt die Anzahl; ohne Keyframes wie bisher', () => {
    const many = Array.from({ length: MAX_LAYOUT_KEYS + 5 }, (_, i) => key(i, 0.5, 0.5, 0.5))
    expect(normalizeLayout({ ...FULL_LAYOUT, keys: many })?.keys).toHaveLength(MAX_LAYOUT_KEYS)
    const bad = [
      { at: 1.5, x: 0, y: 0, scale: 1 },
      { at: S, x: NaN, y: 0, scale: 1 },
    ] as LayoutKey[]
    expect(normalizeLayout({ ...FULL_LAYOUT, keys: bad })).toBeNull()
    expect(normalizeLayout({ ...FULL_LAYOUT, keys: [] })).toBeNull()
    expect(normalizeLayout({ x: 0.5, y: 0.5, scale: 0.5, opacity: 1 })).not.toHaveProperty('keys')
    // Ein Keyframe in voller Größe bleibt eine Lage.
    expect(normalizeLayout({ ...FULL_LAYOUT, keys: [key(1, 0.5, 0.5, 1)] })?.keys).toHaveLength(1)
  })
})

describe('Keyframes im Dokument', () => {
  it('setClipLayout übernimmt Keyframes; gleiche Lage ändert nichts; Prüfung besteht', () => {
    const doc = oneClip()
    const id = videos(doc)[0].id
    const next = must(setClipLayout(doc, id, { ...FULL_LAYOUT, keys: [B, A] }))
    expect(videos(next)[0].layout).toEqual({
      x: 0.2,
      y: 0.5,
      scale: 0.25,
      opacity: 1,
      keys: [A, B],
    })
    expect(validateDoc(next)).toEqual([])
    expect(must(setClipLayout(next, id, { ...FULL_LAYOUT, keys: [A, B] }))).toBe(next)
    expect(must(setClipLayout(next, id, { ...FULL_LAYOUT, keys: [A, { ...B, x: 0.7 }] }))).not.toBe(
      next,
    )
    expect(videos(must(setClipLayout(next, id, null)))[0]).not.toHaveProperty('layout')
  })

  it('validateDoc meldet ungeordnete oder ungültige Keyframes', () => {
    const doc = oneClip()
    const broken = (keys: unknown): TimelineDoc => ({
      ...doc,
      tracks: doc.tracks.map((t) =>
        t.kind === 'video'
          ? { ...t, clips: t.clips.map((c) => ({ ...c, layout: { ...FULL_LAYOUT, keys } })) }
          : t,
      ) as TimelineDoc['tracks'],
    })
    for (const keys of [[B, A], [A, A], [], [{ ...A, scale: 0.01 }], 'x'])
      expect(validateDoc(broken(keys)).map((i) => i.error)).toContain('invalid-settings')
    expect(validateDoc(broken([A, B]))).toEqual([])
  })

  it('Teilen und Tempo lassen die Keyframes an derselben Stelle des Videos', () => {
    let doc = oneClip()
    const id = videos(doc)[0].id
    doc = must(setClipLayout(doc, id, { ...FULL_LAYOUT, keys: [A, B] }))
    const cut = must(splitClip(doc, id, 4 * S))
    const [left, right] = videos(cut)
    expect(left.layout?.keys).toEqual([A, B])
    expect(right.layout?.keys).toEqual([A, B])
    // Am Schnitt zeigen beide Teile dieselbe Lage.
    expect(layoutAt(left, 4 * S)).toEqual(layoutAt(right, 0))
    expect(visibleKeys(left).map((k) => k.offset / S)).toEqual([2])
    expect(visibleKeys(right).map((k) => k.offset / S)).toEqual([2])
    const fast = videos(must(setClipSpeed(doc, id, 2)))[0]
    expect(visibleKeys(fast).map((k) => k.offset / S)).toEqual([1, 3])
    expect(layoutAt(fast, 2 * S)).toMatchObject({ x: 0.5, scale: 0.5 })
  })
})

describe('layoutKeys', () => {
  it('motionAt: gleichmäßig dazwischen, außen gehalten', () => {
    expect(motionAt([A, B], 0)).toEqual({ x: 0.2, y: 0.5, scale: 0.25, opacity: 1 })
    expect(motionAt([A, B], 4 * S)).toEqual({ x: 0.5, y: 0.5, scale: 0.5, opacity: 1 })
    expect(motionAt([A, B], 3 * S)).toEqual({ x: 0.35, y: 0.5, scale: 0.375, opacity: 1 })
    expect(motionAt([A, B], 9 * S)).toEqual({ x: 0.8, y: 0.5, scale: 0.75, opacity: 1 })
    // Deckkraft läuft mit; fehlt sie im Keyframe (ältere Projekte), gilt die des Clips.
    expect(motionAt([key(0, 0, 0, 1, 0), key(4, 0, 0, 1, 1)], S).opacity).toBe(0.25)
    const old = [A, B].map(({ opacity: _unused, ...k }) => k)
    expect(motionAt(old, 3 * S, 0.6).opacity).toBe(0.6)
  })

  it('layoutAt: ohne Lage voll, ohne Keyframes fest, sonst Wert an der Stelle samt Deckkraft', () => {
    expect(layoutAt({ sourceIn: 0, speed: 1, duration: S }, 0)).toBe(FULL_LAYOUT)
    const fixed = { x: 0.1, y: 0.2, scale: 0.3, opacity: 0.4 }
    expect(layoutAt({ sourceIn: 0, speed: 1, duration: S, layout: fixed }, 0)).toBe(fixed)
    expect(layoutAt(clipWith([A, B]), 4 * S)).toEqual({ x: 0.5, y: 0.5, scale: 0.5, opacity: 1 })
    // Getrimmter Anfang: Zeit im Clip 2 s ist Quellzeit 4 s.
    expect(layoutAt(clipWith([A, B], { sourceIn: 2 * S }), 2 * S).x).toBe(0.5)
  })

  it('withKeyAt setzt einen Keyframe mit der Lage an der Stelle bzw. ändert den vorhandenen', () => {
    const first = withKeyAt(
      {
        sourceIn: 0,
        speed: 1,
        duration: 10 * S,
        layout: { x: 0.3, y: 0.4, scale: 0.5, opacity: 1 },
      },
      3 * S,
    )
    expect(first.keys).toEqual([key(3, 0.3, 0.4, 0.5)])
    const clip = clipWith([A, B])
    expect(withKeyAt(clip, 4 * S).keys).toEqual([A, key(4, 0.5, 0.5, 0.5), B])
    expect(withKeyAt(clip, 2 * S + 5000, { x: 0.9 }).keys).toEqual([{ ...A, x: 0.9 }, B])
    expect(keyIndexAt(clip, 6 * S)).toBe(1)
    expect(keyIndexAt(clip, 5 * S)).toBe(-1)
    expect(canAddKey(clip, 5 * S)).toBe(true)
    expect(canAddKey(clip, 6 * S)).toBe(false)
  })

  it('withLayoutChange: ohne Keyframes für den ganzen Clip, mit Keyframes an der Stelle', () => {
    const plain = { sourceIn: 0, speed: 1, duration: 10 * S }
    expect(withLayoutChange(plain, 3 * S, { scale: 0.4 })).toEqual({ ...FULL_LAYOUT, scale: 0.4 })
    const clip = clipWith([A, B])
    const moved = withLayoutChange(clip, 8 * S, { x: 0.1 })
    expect(moved.keys).toEqual([A, B, key(8, 0.1, 0.5, 0.75)])
    // Auch die Deckkraft landet im Keyframe an der Stelle.
    const dim = withLayoutChange(clip, 8 * S, { opacity: 0.3 })
    expect(dim.keys).toEqual([A, B, key(8, 0.8, 0.5, 0.75, 0.3)])
    expect(withLayoutChange(clip, 2 * S, { opacity: 0 }).keys).toEqual([{ ...A, opacity: 0 }, B])
  })

  it('withoutKey entfernt; der letzte hinterlässt eine feste Lage', () => {
    const clip = clipWith([A, B])
    expect(withoutKey(clip, 0)?.keys).toEqual([B])
    expect(withoutKey(clipWith([A]), 0)).toEqual({ x: 0.2, y: 0.5, scale: 0.25, opacity: 1 })
    expect(withoutKey(clip, 5)).toBe(clip.layout)
  })
})

describe('ClipInspector: Keyframes', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('setzt Keyframes am Abspielkopf, ändert dort die Lage, springt und entfernt', async () => {
    const store = useTimelineStore()
    store.putAsset(asset('a'))
    store.appendMedia('a')
    const id = videos(store.doc)[0].id
    store.setClipLayout(id, { x: 0.2, y: 0.5, scale: 0.25, opacity: 1 })
    store.seek(2 * S)
    const wrapper = mount(ClipInspector, { global: { plugins: [i18n] } })
    const layout = () => videos(store.doc)[0].layout
    await wrapper.get('[data-testid=clip-layout-key-add]').trigger('click')
    expect(layout()?.keys).toEqual([key(2, 0.2, 0.5, 0.25)])
    // Auf dem Keyframe geht kein zweiter.
    expect(wrapper.get('[data-testid=clip-layout-key-add]').attributes('disabled')).toBeDefined()

    // An anderer Stelle die Größe ändern: Der nächste Keyframe entsteht von selbst.
    store.seek(6 * S)
    await wrapper.vm.$nextTick()
    const scale = wrapper.get('[data-testid=clip-layout-scale-num]')
    await scale.setValue('75')
    await scale.trigger('change')
    expect(layout()?.keys).toEqual([key(2, 0.2, 0.5, 0.25), key(6, 0.2, 0.5, 0.75)])

    // Dazwischen zeigt der Regler den Wert an der Stelle.
    store.seek(4 * S)
    await wrapper.vm.$nextTick()
    expect(
      (wrapper.get('[data-testid=clip-layout-scale-num]').element as HTMLInputElement).value,
    ).toBe('50')

    // Deckkraft am Ende auf 0: Der Clip blendet aus.
    store.seek(6 * S)
    await wrapper.vm.$nextTick()
    const opacity = wrapper.get('[data-testid=clip-layout-opacity-num]')
    await opacity.setValue('0')
    await opacity.trigger('change')
    expect(layout()?.keys).toEqual([key(2, 0.2, 0.5, 0.25), key(6, 0.2, 0.5, 0.75, 0)])
    await opacity.setValue('100')
    await opacity.trigger('change')

    await wrapper.get('[data-testid=clip-layout-key-1]').trigger('click')
    expect(store.playhead).toBe(6 * S)
    await wrapper.get('[data-testid=clip-layout-key-remove-0]').trigger('click')
    expect(layout()?.keys).toEqual([key(6, 0.2, 0.5, 0.75)])
    await wrapper.get('[data-testid=clip-layout-key-remove-0]').trigger('click')
    expect(layout()).toEqual({ x: 0.2, y: 0.5, scale: 0.75, opacity: 1 })

    // Abspielkopf neben dem Clip: kein Keyframe möglich.
    store.seek(0)
    store.setClipLayout(id, null)
    await wrapper.vm.$nextTick()
    expect(wrapper.get('[data-testid=clip-layout-key-add]').attributes('disabled')).toBeUndefined()
  })
})
