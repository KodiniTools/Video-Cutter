import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import ClipInspector from '@/components/timeline/ClipInspector.vue'
import TimelineClip from '@/components/timeline/TimelineClip.vue'
import { i18n } from '@/i18n'
import { useTimelineStore } from '@/stores/timeline'
import {
  clipToSource,
  envelopeAt,
  envelopeLine,
  sourceToClip,
  visiblePoints,
} from '@/timeline/envelope'
import { losslessCheck } from '@/timeline/lossless'
import { buildTimelineProject, parseTimelineProject } from '@/timeline/projectFile'
import {
  appendMedia,
  createDoc,
  MAX_ENVELOPE_POINTS,
  normalizeEnvelope,
  putAsset,
  setClipEnvelope,
  setClipSpeed,
  splitClip,
  trimClip,
  validateDoc,
  type AssetRef,
  type AudioClip,
  type OpResult,
  type TimelineDoc,
} from '@/timeline/model'

const S = 1_000_000
const asset: AssetRef = {
  id: 'a',
  kind: 'video',
  name: 'a.mp4',
  duration: 10 * S,
  width: 1280,
  height: 720,
  fps: 25,
  hasAudio: true,
}
const must = (r: OpResult): TimelineDoc => {
  if (!r.ok) throw new Error(r.error)
  return r.doc
}
const error = (r: OpResult) => (r.ok ? null : r.error)
const sounds = (doc: TimelineDoc): AudioClip[] =>
  (doc.tracks.find((t) => t.kind === 'audio')?.clips ?? []) as AudioClip[]
const oneClip = (): TimelineDoc => must(appendMedia(putAsset(createDoc(), asset), 'a'))
const DIP = [
  { at: 2 * S, gain: 1 },
  { at: 4 * S, gain: 0.2 },
]

describe('Lautstärke-Kurve: Befehl', () => {
  it('bereinigt Punkte: sortiert, begrenzt, je Zeit einer', () => {
    expect(
      normalizeEnvelope([
        { at: 4 * S, gain: 5 },
        { at: 2 * S + 0.4, gain: -1 },
        { at: 4 * S, gain: 0.333 },
        { at: Number.NaN, gain: 1 },
      ]),
    ).toEqual([
      { at: 2 * S, gain: 0 },
      { at: 4 * S, gain: 0.33 },
    ])
    expect(normalizeEnvelope([])).toBeNull()
    expect(normalizeEnvelope(null)).toBeNull()
  })

  it('setzt und entfernt die Kurve, ohne leeren Schritt', () => {
    const doc = oneClip()
    const id = sounds(doc)[0].id
    const set = must(setClipEnvelope(doc, id, DIP))
    expect(sounds(set)[0].envelope).toEqual(DIP)
    expect(validateDoc(set)).toEqual([])
    expect(must(setClipEnvelope(set, id, [...DIP].reverse()))).toBe(set)
    const off = must(setClipEnvelope(set, id, []))
    expect(sounds(off)[0]).not.toHaveProperty('envelope')
    expect(must(setClipEnvelope(off, id, null))).toBe(off)
  })

  it('lehnt Unpassendes ab', () => {
    const doc = oneClip()
    const video = doc.tracks.find((t) => t.kind === 'video')?.clips[0].id ?? ''
    expect(error(setClipEnvelope(doc, video, DIP))).toBe('kind-mismatch')
    expect(error(setClipEnvelope(doc, 'x', DIP))).toBe('clip-not-found')
    const many = Array.from({ length: MAX_ENVELOPE_POINTS + 1 }, (_, i) => ({ at: i, gain: 1 }))
    expect(error(setClipEnvelope(doc, sounds(doc)[0].id, many))).toBe('too-many')
    const broken = structuredClone(must(setClipEnvelope(doc, sounds(doc)[0].id, DIP)))
    ;(broken.tracks[1].clips[0] as AudioClip).envelope = [...DIP].reverse()
    expect(validateDoc(broken).length).toBeGreaterThan(0)
  })

  it('hängt an der Quelle: Teilen, Trimmen und Tempo lassen die Punkte stehen', () => {
    const doc = oneClip()
    const id = sounds(doc)[0].id
    const set = must(setClipEnvelope(doc, id, DIP))
    const parts = sounds(must(splitClip(set, id, 3 * S)))
    expect(parts.map((c) => c.envelope)).toEqual([DIP, DIP])
    // Zweiter Teil beginnt bei 3 s der Quelle: mitten in der Rampe.
    expect(envelopeAt(parts[1].envelope, clipToSource(parts[1], 0))).toBeCloseTo(0.6)
    const trimmed = sounds(must(trimClip(set, id, 'start', 4 * S)))[0]
    expect(trimmed.envelope).toEqual(DIP)
    expect(visiblePoints(trimmed).map((p) => p.offset)).toEqual([0])
    const fast = sounds(must(setClipSpeed(set, id, 2)))[0]
    expect(fast.envelope).toEqual(DIP)
    expect(visiblePoints(fast).map((p) => p.offset)).toEqual([1 * S, 2 * S])
  })

  it('schließt den verlustfreien Export aus und übersteht Speichern', () => {
    const doc = oneClip()
    expect(losslessCheck(doc).ok).toBe(true)
    const set = must(setClipEnvelope(doc, sounds(doc)[0].id, DIP))
    expect(losslessCheck(set)).toMatchObject({ ok: false, reason: 'audio' })
    const back = parseTimelineProject(JSON.parse(JSON.stringify(buildTimelineProject(set, {}))))
    expect(sounds(back.doc)[0].envelope).toEqual(DIP)
  })
})

describe('Lautstärke-Kurve: Rechnen', () => {
  it('ist zwischen den Punkten linear und außen gehalten', () => {
    expect(envelopeAt(undefined, 5)).toBe(1)
    expect(envelopeAt(DIP, 0)).toBe(1)
    expect(envelopeAt(DIP, 3 * S)).toBeCloseTo(0.6)
    expect(envelopeAt(DIP, 4 * S)).toBe(0.2)
    expect(envelopeAt(DIP, 9 * S)).toBe(0.2)
    expect(envelopeAt([{ at: S, gain: 0.5 }], 0)).toBe(0.5)
  })

  it('rechnet zwischen Clip- und Quellzeit um', () => {
    const clip = { sourceIn: 2 * S, speed: 2 }
    expect(clipToSource(clip, S)).toBe(4 * S)
    expect(sourceToClip(clip, 4 * S)).toBe(S)
    expect(sourceToClip(clip, 0)).toBe(-S)
  })

  it('liefert die Linie über die Clip-Länge', () => {
    const clip = { sourceIn: 0, speed: 1, duration: 10 * S, envelope: DIP }
    expect(envelopeLine(clip)).toEqual([
      [0, 1],
      [0.2, 1],
      [0.4, 0.2],
      [1, 0.2],
    ])
    expect(envelopeLine({ ...clip, envelope: undefined })).toEqual([])
  })
})

describe('Lautstärke-Kurve im Editor', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('Punkt am Abspielkopf, Regler als ein Schritt, Entfernen', async () => {
    const store = useTimelineStore()
    store.load(oneClip())
    const clip = () => sounds(store.doc)[0]
    store.select([clip().id])
    const wrapper = mount(ClipInspector, { global: { plugins: [i18n] } })
    const add = wrapper.get('[data-testid=clip-envelope-add]')

    store.seek(2 * S)
    await add.trigger('click')
    store.seek(4 * S)
    await add.trigger('click')
    expect(clip().envelope).toEqual([
      { at: 2 * S, gain: 1 },
      { at: 4 * S, gain: 1 },
    ])
    // Derselbe Punkt entsteht nicht doppelt.
    await add.trigger('click')
    expect(clip().envelope).toHaveLength(2)

    const slider = wrapper.get('[data-testid=clip-envelope-gain-1]')
    for (const v of [80, 50, 20]) {
      ;(slider.element as HTMLInputElement).value = String(v)
      await slider.trigger('input')
    }
    await slider.trigger('change')
    expect(clip().envelope?.[1].gain).toBe(0.2)
    store.undo()
    expect(clip().envelope?.[1].gain).toBe(1)
    store.redo()

    // Ein neuer Punkt dazwischen übernimmt den Wert der Kurve.
    store.seek(3 * S)
    await add.trigger('click')
    expect(clip().envelope?.[1]).toEqual({ at: 3 * S, gain: 0.6 })

    await wrapper.get('[data-testid=clip-envelope-remove-1]').trigger('click')
    expect(clip().envelope).toHaveLength(2)
    await wrapper.get('[data-testid=clip-envelope-clear]').trigger('click')
    expect(clip()).not.toHaveProperty('envelope')
    expect(wrapper.find('[data-testid=clip-envelope-points]').exists()).toBe(false)

    // Abspielkopf neben dem Clip: kein Punkt möglich.
    store.seek(12 * S)
    await wrapper.vm.$nextTick()
    expect(add.attributes('disabled')).toBeDefined()
  })

  it('nennt Punkte außerhalb des Clips', async () => {
    const store = useTimelineStore()
    store.load(oneClip())
    const id = sounds(store.doc)[0].id
    store.setClipEnvelope(id, DIP)
    store.trimClip(id, 'start', 3 * S)
    store.select([id])
    const wrapper = mount(ClipInspector, { global: { plugins: [i18n] } })
    expect(wrapper.findAll('[data-testid=clip-envelope-points] li')).toHaveLength(1)
    expect(wrapper.get('[data-testid=clip-envelope-hidden]').text()).toContain('Ein Punkt')
  })

  it('zeichnet die Linie auf dem Ton-Clip', () => {
    const clip = { ...sounds(oneClip())[0], envelope: DIP }
    const w = mount(TimelineClip, {
      props: { clip, zoom: 100, height: 48, selected: false },
      global: { plugins: [i18n] },
    })
    expect(w.get('.envelope polyline').attributes('points')).toBe(
      '0.00,50.00 20.00,50.00 40.00,90.00 100.00,90.00',
    )
  })
})
