import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import ClipInspector from '@/components/timeline/ClipInspector.vue'
import { i18n } from '@/i18n'
import { useTimelineStore } from '@/stores/timeline'
import {
  appendMedia,
  createDoc,
  moveClip,
  putAsset,
  repeatClip,
  repeatLimit,
  setClipFade,
  setClipGain,
  trimClip,
  updateTrack,
  validateDoc,
  type AssetRef,
  type AudioClip,
  type OpResult,
  type TimelineDoc,
} from '@/timeline/model'

const S = 1_000_000
const video = (id: string, seconds: number): AssetRef => ({
  id,
  kind: 'video',
  name: `${id}.mp4`,
  duration: seconds * S,
  width: 1280,
  height: 720,
  fps: 25,
  hasAudio: true,
})
const song = (id: string, seconds: number): AssetRef => ({
  id,
  kind: 'audio',
  name: `${id}.mp3`,
  duration: seconds * S,
  hasAudio: true,
})
const must = (r: OpResult): TimelineDoc => {
  if (!r.ok) throw new Error(r.error)
  return r.doc
}
const error = (r: OpResult) => (r.ok ? null : r.error)
/** Die Musik-Spur ist die letzte Ton-Spur. */
const music = (doc: TimelineDoc): AudioClip[] => [
  ...((doc.tracks.filter((t) => t.kind === 'audio').pop()?.clips ?? []) as AudioClip[]),
]
const brief = (list: AudioClip[]) => list.map((c) => [c.start / S, c.duration / S, c.sourceIn / S])
/** Video von 10 s, darunter Musik von 4 s ab 0. */
function setup(): TimelineDoc {
  let doc = putAsset(putAsset(createDoc(), video('v', 10)), song('m', 4))
  doc = must(appendMedia(doc, 'v'))
  return must(appendMedia(doc, 'm'))
}

describe('repeatClip', () => {
  it('legt Kopien bis zum Ende der übrigen Spuren, die letzte gekürzt', () => {
    const doc = setup()
    const clip = music(doc)[0]
    expect(repeatLimit(doc, clip.id)).toBe(10 * S)
    const next = must(repeatClip(doc, clip.id))
    expect(validateDoc(next)).toEqual([])
    expect(brief(music(next))).toEqual([
      [0, 4, 0],
      [4, 4, 0],
      [8, 2, 0],
    ])
    expect(music(next)[0].id).toBe(clip.id)
    // Danach ist nichts mehr zu füllen.
    expect(repeatLimit(next, clip.id)).toBeNull()
    expect(error(repeatClip(next, music(next)[2].id))).toBe('too-short')
  })

  it('übernimmt Lautstärke und Ausschnitt; die Ausblendung wandert ans Ende', () => {
    let doc = setup()
    const id = music(doc)[0].id
    doc = must(trimClip(doc, id, 'start', 1 * S))
    doc = must(moveClip(doc, id, { start: 0 }))
    doc = must(setClipGain(doc, id, 0.3))
    doc = must(setClipFade(doc, id, 'in', { duration: 1 * S }))
    doc = must(setClipFade(doc, id, 'out', { duration: 2 * S }))
    const next = must(repeatClip(doc, id))
    const list = music(next)
    expect(brief(list)).toEqual([
      [0, 3, 1],
      [3, 3, 1],
      [6, 3, 1],
      [9, 1, 1],
    ])
    expect(list.map((c) => c.gain)).toEqual([0.3, 0.3, 0.3, 0.3])
    expect(list.map((c) => c.fadeIn?.duration ?? 0)).toEqual([1 * S, 0, 0, 0])
    // Die letzte Kopie ist nur 1 s lang: Die Ausblendung passt sich an.
    expect(list.map((c) => c.fadeOut?.duration ?? 0)).toEqual([0, 0, 0, 1 * S])
    expect(validateDoc(next)).toEqual([])
  })

  it('hält vor dem nächsten Clip derselben Spur an', () => {
    let doc = putAsset(setup(), song('n', 2))
    doc = must(appendMedia(doc, 'n'))
    const [first, second] = music(doc)
    doc = must(moveClip(doc, second.id, { start: 7 * S }))
    const next = must(repeatClip(doc, first.id))
    expect(brief(music(next))).toEqual([
      [0, 4, 0],
      [4, 3, 0],
      [7, 2, 0],
    ])
  })

  it('lehnt den Ton eines Videos, gesperrte Spuren und Unbekanntes ab', () => {
    const doc = setup()
    const linked = doc.tracks.filter((t) => t.kind === 'audio')[0].clips[0]
    expect(repeatLimit(doc, linked.id)).toBeNull()
    expect(error(repeatClip(doc, linked.id))).toBe('kind-mismatch')
    expect(error(repeatClip(doc, 'nix'))).toBe('clip-not-found')
    const track = doc.tracks[doc.tracks.length - 1]
    const locked = must(updateTrack(doc, track.id, { locked: true }))
    expect(error(repeatClip(locked, music(doc)[0].id))).toBe('track-locked')
  })
})

describe('Schleife im Feld „Clip“', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('Knopf nur für eigenständige Ton-Clips; ein Rückgängig-Schritt', async () => {
    const store = useTimelineStore()
    store.load(setup())
    const clip = music(store.doc)[0]
    store.select([clip.id])
    const wrapper = mount(ClipInspector, { global: { plugins: [i18n] } })
    const button = wrapper.get('[data-testid=clip-repeat]')
    expect(button.attributes('disabled')).toBeUndefined()
    expect(wrapper.text()).toContain('00:10.000')
    await button.trigger('click')
    expect(music(store.doc)).toHaveLength(3)
    expect(wrapper.get('[data-testid=clip-repeat]').attributes('disabled')).toBeDefined()
    store.undo()
    expect(music(store.doc)).toHaveLength(1)

    // Ton eines Videos: kein Knopf.
    store.select([store.doc.tracks.filter((t) => t.kind === 'audio')[0].clips[0].id])
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid=clip-repeat]').exists()).toBe(false)
  })
})
