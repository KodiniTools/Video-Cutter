import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import ClipInspector from '@/components/timeline/ClipInspector.vue'
import RangeSpinner from '@/components/timeline/RangeSpinner.vue'
import { i18n } from '@/i18n'
import { useTimelineStore } from '@/stores/timeline'
import {
  appendMedia,
  createDoc,
  putAsset,
  type AssetRef,
  type AudioClip,
  type OpResult,
  type TimelineDoc,
} from '@/timeline/model'

const must = (r: OpResult): TimelineDoc => {
  if (!r.ok) throw new Error(r.error)
  return r.doc
}

describe('RangeSpinner', () => {
  function mountSpinner(props: Record<string, unknown>) {
    const seen: string[] = []
    const w = mount(RangeSpinner, {
      props: { value: 0.5, min: 0, max: 1, step: 0.005, ...props },
      attrs: {
        'data-testid': 'x',
        onInput: (e: Event) => seen.push(`input:${(e.target as HTMLInputElement).value}`),
        onChange: () => seen.push('change'),
      },
      global: { plugins: [i18n] },
      attachTo: document.body,
    })
    return { w, seen }
  }

  it('gibt Attribute und Ereignisse an den Regler weiter', async () => {
    const { w, seen } = mountSpinner({})
    const range = w.get('[data-testid=x]')
    expect(range.attributes('type')).toBe('range')
    expect(range.attributes('step')).toBe('0.005')
    ;(range.element as HTMLInputElement).value = '0.25'
    await range.trigger('input')
    await range.trigger('change')
    expect(seen).toEqual(['input:0.25', 'change'])
    w.unmount()
  })

  it('Zahlenfeld zeigt den umgerechneten Wert und stellt den Regler', async () => {
    const { w, seen } = mountSpinner({ scale: 100 })
    const num = w.get('[data-testid=x-num]')
    const el = num.element as HTMLInputElement
    expect(el.value).toBe('50')
    expect([el.min, el.max, el.step]).toEqual(['0', '100', '0.5'])
    await num.setValue('12.5')
    await num.trigger('change')
    expect(seen).toEqual(['input:0.125', 'change'])
    // Außerhalb der Grenzen: begrenzt.
    await num.setValue('400')
    await num.trigger('change')
    expect(seen.slice(2)).toEqual(['input:1', 'change'])
    // Leer: nichts passiert, das Feld zeigt wieder den Wert.
    await num.setValue('')
    await num.trigger('change')
    expect(seen).toHaveLength(4)
    await nextTick()
    expect(el.value).toBe('50')
    await w.setProps({ value: 0.335 })
    expect(el.value).toBe('33.5')
    w.unmount()
  })
})

describe('Spinner im Feld „Clip“', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('Lautstärke per Zahlenfeld ist ein Rückgängig-Schritt', async () => {
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
    const store = useTimelineStore()
    store.load(must(appendMedia(putAsset(createDoc(), asset), 'a')))
    const clip = () => store.doc.tracks.find((t) => t.kind === 'audio')?.clips[0] as AudioClip
    store.select([clip().id])
    const w = mount(ClipInspector, { global: { plugins: [i18n] }, attachTo: document.body })
    const num = w.get('[data-testid=clip-gain-num]')
    await num.setValue('150')
    await num.trigger('change')
    expect(clip().gain).toBe(1.5)
    await num.setValue('35')
    await num.trigger('change')
    expect(clip().gain).toBe(0.35)
    store.undo()
    expect(clip().gain).toBe(1.5)
    store.undo()
    expect(clip().gain).toBe(1)
    // Jeder Regler im Feld hat ein Zahlenfeld.
    expect(w.findAll('input[type=range]').length).toBe(w.findAll('input[type=number]').length)
    w.unmount()
  })
})
