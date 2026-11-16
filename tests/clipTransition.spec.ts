import { describe, expect, it, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import ClipInspector from '@/components/timeline/ClipInspector.vue'
import TimelineClip from '@/components/timeline/TimelineClip.vue'
import { i18n } from '@/i18n'
import { useTimelineStore } from '@/stores/timeline'
import { checkLossless } from '@/timeline/lossless'
import {
  appendMedia,
  createDoc,
  MAX_TRANSITION,
  MIN_TRANSITION,
  putAsset,
  setClipTransition,
  splitClip,
  validateDoc,
  type AssetRef,
  type Clip,
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
  hasAudio: true,
})
const must = (r: OpResult): TimelineDoc => {
  if (!r.ok) throw new Error(r.error)
  return r.doc
}
const error = (r: OpResult) => (r.ok ? null : r.error)
function twoClips(): TimelineDoc {
  let doc = putAsset(putAsset(createDoc(), asset('a')), asset('b'))
  doc = must(appendMedia(doc, 'a'))
  return must(appendMedia(doc, 'b'))
}
const videos = (doc: TimelineDoc): VideoClip[] =>
  (doc.tracks.find((t) => t.kind === 'video')?.clips ?? []) as VideoClip[]
const audios = (doc: TimelineDoc): Clip[] => [
  ...(doc.tracks.find((t) => t.kind === 'audio')?.clips ?? []),
]

describe('setClipTransition', () => {
  it('setzt, ändert und entfernt den Übergang; die Dauer wird begrenzt', () => {
    const doc = twoClips()
    const second = videos(doc)[1]
    let next = must(setClipTransition(doc, second.id, { preset: 'slide' }))
    expect(videos(next)[1].transitionIn).toEqual({ preset: 'slide', duration: S })
    expect(validateDoc(next)).toEqual([])
    // Art wechseln: Die Dauer bleibt.
    next = must(setClipTransition(next, second.id, { preset: 'slide', duration: 2.5 * S }))
    next = must(setClipTransition(next, second.id, { preset: 'fade' }))
    expect(videos(next)[1].transitionIn).toEqual({ preset: 'fade', duration: 2.5 * S })
    // Unverändert: dasselbe Dokument (kein Verlaufsschritt).
    expect(must(setClipTransition(next, second.id, { preset: 'fade' }))).toBe(next)
    expect(
      videos(must(setClipTransition(next, second.id, { preset: 'fade', duration: 99 * S })))[1]
        .transitionIn?.duration,
    ).toBe(MAX_TRANSITION)
    expect(
      videos(must(setClipTransition(next, second.id, { preset: 'fade', duration: 1 })))[1]
        .transitionIn?.duration,
    ).toBe(MIN_TRANSITION)
    const cleared = must(setClipTransition(next, second.id, null))
    expect('transitionIn' in videos(cleared)[1]).toBe(false)
    expect(must(setClipTransition(cleared, second.id, null))).toBe(cleared)
  })

  it('lehnt Ton-Clips, Unbekanntes und Unsinn ab', () => {
    const doc = twoClips()
    expect(error(setClipTransition(doc, audios(doc)[0].id, { preset: 'fade' }))).toBe(
      'kind-mismatch',
    )
    expect(error(setClipTransition(doc, 'nope', { preset: 'fade' }))).toBe('clip-not-found')
    expect(
      error(setClipTransition(doc, videos(doc)[0].id, { preset: 'wipe' as unknown as 'fade' })),
    ).toBe('invalid-settings')
    const broken = structuredClone(doc)
    ;(broken.tracks[0].clips[0] as VideoClip).transitionIn = { preset: 'fade', duration: 5 }
    expect(validateDoc(broken).map((i) => i.error)).toEqual(['invalid-settings'])
  })

  it('beim Teilen bleibt der Übergang am ersten Teil', () => {
    let doc = twoClips()
    const second = videos(doc)[1]
    doc = must(setClipTransition(doc, second.id, { preset: 'flip' }))
    doc = must(splitClip(doc, second.id, 15 * S))
    expect(videos(doc).map((c) => c.transitionIn?.preset)).toEqual([undefined, 'flip', undefined])
  })

  it('macht den verlustfreien Export unmöglich', () => {
    let doc = must(appendMedia(putAsset(createDoc(), asset('a')), 'a'))
    const info = () => ({ width: 1280, height: 720, hasAudio: true })
    expect(checkLossless(doc, info).ok).toBe(true)
    doc = must(setClipTransition(doc, videos(doc)[0].id, { preset: 'fade' }))
    expect(checkLossless(doc, info)).toEqual({ ok: false, reason: 'transition' })
  })
})

describe('Übergang im Feld „Clip“ und auf der Timeline', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('wählt Art und Dauer; Rückgängig nimmt den ganzen Reglerzug zurück', async () => {
    const store = useTimelineStore()
    store.putAsset(asset('a'))
    store.appendMedia('a')
    const wrapper = mount(ClipInspector, { global: { plugins: [i18n] } })
    const clip = () => videos(store.doc)[0]
    expect(wrapper.find('[data-testid=clip-transition-duration]').exists()).toBe(false)

    await wrapper.get('[data-testid=clip-transition-preset]').setValue('scale')
    expect(clip().transitionIn).toEqual({ preset: 'scale', duration: S })
    const slider = wrapper.get('[data-testid=clip-transition-duration]')
    // Ziehen: mehrere `input`, am Ende ein `change`.
    const el = slider.element as HTMLInputElement
    el.value = '1.5'
    await slider.trigger('input')
    el.value = '2'
    await slider.trigger('input')
    await slider.trigger('change')
    expect(clip().transitionIn).toEqual({ preset: 'scale', duration: 2 * S })
    expect(wrapper.get('[data-testid=clip-transition]').text()).toContain('2,0 s')
    store.undo()
    expect(clip().transitionIn).toEqual({ preset: 'scale', duration: S })

    await wrapper.get('[data-testid=clip-transition-preset]').setValue('')
    expect(clip().transitionIn).toBeUndefined()
  })

  it('zeigt die Marke am Clip-Anfang, so breit wie die halbe Dauer', () => {
    let doc = twoClips()
    doc = must(setClipTransition(doc, videos(doc)[1].id, { preset: 'slide', duration: 2 * S }))
    const mountClip = (clip: Clip) =>
      mount(TimelineClip, {
        props: { clip, zoom: 50, height: 40, selected: false },
        global: { plugins: [i18n, createPinia()] },
      })
    expect(mountClip(videos(doc)[0]).find('.transition').exists()).toBe(false)
    const mark = mountClip(videos(doc)[1]).get('.transition')
    expect(mark.attributes('style')).toContain('width: 50px')
    expect(mark.attributes('title')).toBe('Gleiten')
  })
})
