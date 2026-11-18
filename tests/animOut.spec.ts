import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import ClipInspector from '@/components/timeline/ClipInspector.vue'
import TextInspector from '@/components/timeline/TextInspector.vue'
import { i18n } from '@/i18n'
import { useTimelineStore } from '@/stores/timeline'
import { animParts, animPatch } from '@/lib/textOverlay'
import { checkLossless } from '@/timeline/lossless'
import {
  appendMedia,
  createDoc,
  MAX_TRANSITION,
  MIN_TRANSITION,
  putAsset,
  setClipFadeOut,
  splitClip,
  validateDoc,
  type AssetRef,
  type OpResult,
  type TimelineDoc,
  type VideoClip,
} from '@/timeline/model'
import { matchesTextDefault, parseTextDefault, textDefaultPatch } from '@/timeline/textDefault'

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
const videos = (doc: TimelineDoc): VideoClip[] =>
  (doc.tracks.find((t) => t.kind === 'video')?.clips ?? []) as VideoClip[]

describe('animParts (Ein- und Ausblenden getrennt)', () => {
  it('deutet ältere Einträge so, wie sie bisher aussahen', () => {
    expect(animParts({ animation: 'none' })).toEqual({
      in: 'none',
      inSpeed: 1,
      out: 'none',
      outSpeed: 1,
    })
    expect(animParts({ animation: 'fade', animSpeed: 0.5 })).toEqual({
      in: 'fadeIn',
      inSpeed: 0.5,
      out: 'fade',
      outSpeed: 0.5,
    })
    expect(animParts({ animation: 'fadeIn' })).toMatchObject({ in: 'fadeIn', out: 'none' })
    expect(animParts({ animation: 'fadeOut' })).toMatchObject({ in: 'none', out: 'fade' })
    expect(animParts({ animation: 'slideLeft' })).toMatchObject({ in: 'slideLeft', out: 'fade' })
    expect(animParts({ animation: 'typewriter' })).toMatchObject({ in: 'typewriter', out: 'fade' })
    expect(animParts({})).toMatchObject({ in: 'none', out: 'none' })
  })

  it('liest die getrennte Schreibweise mit eigenem Tempo', () => {
    const parts = animParts({
      animation: 'zoom',
      animSpeed: 2,
      animOut: 'slide',
      animOutSpeed: 0.1,
    })
    expect(parts).toEqual({ in: 'zoom', inSpeed: 2, out: 'slide', outSpeed: 0.1 })
    expect(animPatch(parts)).toEqual({
      animation: 'zoom',
      animSpeed: 2,
      animOut: 'slide',
      animOutSpeed: 0.1,
    })
    expect(animParts({ animation: 'slide', animOut: 'none' }).out).toBe('none')
  })

  it('eine Änderung am Einblenden lässt das Ausblenden stehen', () => {
    const before = animParts({ animation: 'fade', animSpeed: 0.5 })
    const patch = animPatch({ ...before, in: 'pop', inSpeed: 2 })
    expect(patch).toEqual({ animation: 'pop', animSpeed: 2, animOut: 'fade', animOutSpeed: 0.5 })
  })
})

describe('setClipFadeOut (Video-Clip am Ende ausblenden)', () => {
  const doc = () => must(appendMedia(putAsset(createDoc(), asset('a')), 'a'))

  it('setzt, ändert, begrenzt und entfernt das Ausblenden', () => {
    const start = doc()
    const id = videos(start)[0].id
    let next = must(setClipFadeOut(start, id, {}))
    expect(videos(next)[0].fadeOut).toEqual({ duration: S })
    expect(validateDoc(next)).toEqual([])
    next = must(setClipFadeOut(next, id, { duration: 2.5 * S }))
    expect(videos(next)[0].fadeOut).toEqual({ duration: 2.5 * S })
    expect(must(setClipFadeOut(next, id, { duration: 99 * S })).tracks).not.toBe(next.tracks)
    expect(videos(must(setClipFadeOut(next, id, { duration: 99 * S })))[0].fadeOut).toEqual({
      duration: MAX_TRANSITION,
    })
    expect(videos(must(setClipFadeOut(next, id, { duration: 1 })))[0].fadeOut).toEqual({
      duration: MIN_TRANSITION,
    })
    expect(must(setClipFadeOut(next, id, { duration: 2.5 * S }))).toBe(next)
    next = must(setClipFadeOut(next, id, null))
    expect(videos(next)[0]).not.toHaveProperty('fadeOut')
  })

  it('gilt nur für Video-Clips', () => {
    const start = doc()
    const audio = start.tracks.find((t) => t.kind === 'audio')?.clips[0]
    expect(audio && setClipFadeOut(start, audio.id, {}).ok).toBe(false)
  })

  it('beim Teilen bleibt das Ausblenden am letzten Teil', () => {
    const start = doc()
    const id = videos(start)[0].id
    const split = must(splitClip(must(setClipFadeOut(start, id, {})), id, 4 * S))
    const [left, right] = videos(split)
    expect(left).not.toHaveProperty('fadeOut')
    expect(right.fadeOut).toEqual({ duration: S })
  })

  it('verhindert den verlustfreien Export', () => {
    const start = doc()
    const faded = must(setClipFadeOut(start, videos(start)[0].id, {}))
    const info = () => ({ width: 1280, height: 720, hasAudio: true })
    expect(checkLossless(start, info).ok).toBe(true)
    expect(checkLossless(faded, info)).toEqual({ ok: false, reason: 'transition' })
  })
})

describe('Felder im Editor', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('Clip: Schalter und Dauer für das Ausblenden', async () => {
    const store = useTimelineStore()
    store.putAsset(asset('a'))
    store.appendMedia('a')
    const id = videos(store.doc)[0].id
    store.select([id])
    const w = mount(ClipInspector, { global: { plugins: [i18n] } })
    expect(w.find('[data-testid="clip-fade-out-duration"]').exists()).toBe(false)
    await w.get('[data-testid="clip-fade-out-toggle"]').setValue(true)
    expect(videos(store.doc)[0].fadeOut).toEqual({ duration: S })
    expect(w.find('[data-testid="clip-fade-out-duration"]').exists()).toBe(true)
    await w.get('[data-testid="clip-fade-out-toggle"]').setValue(false)
    expect(videos(store.doc)[0]).not.toHaveProperty('fadeOut')
    w.unmount()
  })

  it('Text: Ein- und Ausblenden mit je eigenem Tempo', async () => {
    const store = useTimelineStore()
    const clipId = store.addText({ text: 'Hallo', animation: 'fade', animSpeed: 0.5 }, 3 * S)
    expect(clipId).toBeTruthy()
    const w = mount(TextInspector, { global: { plugins: [i18n] } })
    const val = (id: string) => (w.get(`[data-testid="${id}"]`).element as HTMLSelectElement).value
    // Älterer Eintrag „Ein- und Ausblenden“ erscheint getrennt.
    expect([val('text-animation'), val('text-anim-speed')]).toEqual(['fadeIn', '0.5'])
    expect([val('text-anim-out'), val('text-anim-out-speed')]).toEqual(['fade', '0.5'])
    await w.get('[data-testid="text-anim-out"]').setValue('slideRight')
    await w.get('[data-testid="text-anim-out-speed"]').setValue('2')
    await w.get('[data-testid="text-animation"]').setValue('zoom')
    const clips = store.doc.tracks.flatMap((t) => [...t.clips] as Array<{ id: string }>)
    const data = clips.find((c) => c.id === clipId) as unknown as {
      data: Record<string, unknown>
    }
    expect(data.data).toMatchObject({
      animation: 'zoom',
      animSpeed: 0.5,
      animOut: 'slideRight',
      animOutSpeed: 2,
    })
    w.unmount()
  })
})

describe('Text-Standard mit eigenem Ausblenden', () => {
  const style = {
    x: 0.5,
    y: 0.88,
    font: 'roboto',
    size: 0.06,
    color: '#ffffff',
    style: 'outline',
    accent: '#000000',
    animation: 'fadeIn',
    animSpeed: 1,
  }

  it('ältere Standards ohne Ausblenden bleiben gültig und unverändert', () => {
    expect(parseTextDefault(style)).toEqual(style)
    expect(matchesTextDefault(style, parseTextDefault(style)!)).toBe(true)
  })

  it('übernimmt Ausblenden und dessen Tempo', () => {
    const def = parseTextDefault({ ...style, animOut: 'zoom', animOutSpeed: 0.5 })
    expect(def).toMatchObject({ animOut: 'zoom', animOutSpeed: 0.5 })
    expect(textDefaultPatch(style, def!)).toEqual({ animOut: 'zoom', animOutSpeed: 0.5 })
    expect(matchesTextDefault({ ...style, animOut: 'zoom', animOutSpeed: 0.5 }, def!)).toBe(true)
    expect(parseTextDefault({ ...style, animOut: 'wirbel' })).toBeNull()
  })

  it('ein Standard ohne Ausblenden nimmt es einem Text wieder weg', () => {
    const def = parseTextDefault(style)!
    const patch = textDefaultPatch({ ...style, animOut: 'zoom', animOutSpeed: 0.5 }, def)
    expect(patch).toHaveProperty('animOut', undefined)
    expect(matchesTextDefault({ ...style, ...patch }, def)).toBe(true)
  })
})
