import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import TrackHeader from '@/components/timeline/TrackHeader.vue'
import { i18n } from '@/i18n'
import { buildTimelineProject, parseTimelineProject } from '@/timeline/projectFile'
import {
  addTrack,
  createDoc,
  DEFAULT_DUCK,
  normalizeDuck,
  updateTrack,
  validateDoc,
  type AudioTrack,
  type OpResult,
  type TimelineDoc,
} from '@/timeline/model'

const must = (r: OpResult): TimelineDoc => {
  if (!r.ok) throw new Error(r.error)
  return r.doc
}
function docWithAudio(): TimelineDoc {
  const doc = must(addTrack(createDoc(), { id: 'V9', kind: 'video', name: 'V1' }))
  return must(addTrack(doc, { id: 'A9', kind: 'audio', name: 'Musik' }, 1))
}
const audio = (doc: TimelineDoc): AudioTrack => doc.tracks.find((t) => t.id === 'A9') as AudioTrack

describe('Automatisches Absenken einer Ton-Spur', () => {
  it('normalisiert die Stärke', () => {
    expect(normalizeDuck(0.7)).toBe(0.7)
    expect(normalizeDuck(0.72)).toBe(0.7)
    expect(normalizeDuck(3)).toBe(1)
    expect(normalizeDuck(0)).toBeUndefined()
    expect(normalizeDuck(-1)).toBeUndefined()
    expect(normalizeDuck(null)).toBeUndefined()
    expect(normalizeDuck(Number.NaN)).toBeUndefined()
  })

  it('schaltet ein und aus, ohne leeren Schritt', () => {
    const doc = docWithAudio()
    expect(audio(doc)).not.toHaveProperty('duck')
    const on = must(updateTrack(doc, 'A9', { duck: DEFAULT_DUCK }))
    expect(audio(on).duck).toBe(0.7)
    expect(validateDoc(on)).toEqual([])
    expect(must(updateTrack(on, 'A9', { duck: 0.7 }))).toBe(on)
    const off = must(updateTrack(on, 'A9', { duck: null }))
    expect(audio(off)).not.toHaveProperty('duck')
    expect(must(updateTrack(off, 'A9', { duck: 0 }))).toBe(off)
    // Andere Änderungen lassen das Absenken stehen.
    expect(audio(must(updateTrack(on, 'A9', { muted: true })))).toMatchObject({
      duck: 0.7,
      muted: true,
    })
  })

  it('gilt nur für Ton-Spuren', () => {
    const doc = docWithAudio()
    const video = doc.tracks.find((t) => t.kind === 'video')
    expect(video).toBeDefined()
    if (video) expect(must(updateTrack(doc, video.id, { duck: 0.7 }))).toBe(doc)
  })

  it('übersteht Speichern und Öffnen eines Projekts', () => {
    const on = must(updateTrack(docWithAudio(), 'A9', { duck: 0.5 }))
    const back = parseTimelineProject(JSON.parse(JSON.stringify(buildTimelineProject(on, {}))))
    expect(audio(back.doc).duck).toBe(0.5)
  })

  it('Schalter im Spurkopf meldet die Änderung', async () => {
    const doc = docWithAudio()
    const w = mount(TrackHeader, {
      props: { track: audio(doc), canMoveUp: false, canMoveDown: false },
      global: { plugins: [i18n] },
    })
    const button = w.get('[data-action="duck"]')
    expect(button.attributes('aria-pressed')).toBe('false')
    await button.trigger('click')
    expect(w.emitted('update')?.[0]).toEqual([{ duck: DEFAULT_DUCK }])
    await w.setProps({ track: audio(must(updateTrack(doc, 'A9', { duck: DEFAULT_DUCK }))) })
    expect(button.attributes('aria-pressed')).toBe('true')
    await button.trigger('click')
    expect(w.emitted('update')?.[1]).toEqual([{ duck: null }])
  })

  it('Video-Spuren haben keinen Schalter', () => {
    const video = docWithAudio().tracks.find((t) => t.kind === 'video')
    if (!video) throw new Error('keine Video-Spur')
    const w = mount(TrackHeader, {
      props: { track: video, canMoveUp: false, canMoveDown: false },
      global: { plugins: [i18n] },
    })
    expect(w.find('[data-action="duck"]').exists()).toBe(false)
  })
})
