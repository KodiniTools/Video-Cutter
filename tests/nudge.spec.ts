import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { mount } from '@vue/test-utils'
import { i18n } from '@/i18n'
import { useTimelineStore } from '@/stores/timeline'
import { DEFAULT_TEXT_STYLE } from '@/lib/textOverlay'
import { isNudgeStep, nudgeTime } from '@/timeline/nudge'

vi.mock('@/lib/previewApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/previewApi')>()),
  fetchPreviewPlan: vi.fn(() => new Promise(() => {})),
  fetchPreviewStats: vi.fn(async () => null),
}))

const S = 1_000_000
const MS = 1000

describe('nudgeTime', () => {
  it('verschiebt um den Schritt und bleibt auf dem Bildraster', () => {
    // 25 Bilder/s: 100 ms = 2,5 Bilder -> nächstes Bild
    expect(nudgeTime(2 * S, 1, 1000, 25, 10 * S)).toBe(3 * S)
    expect(nudgeTime(2 * S, -1, 1000, 25, 10 * S)).toBe(1 * S)
    expect(nudgeTime(2 * S, 1, 100, 25, 10 * S)).toBe(2 * S + 120 * MS)
    expect(nudgeTime(2 * S, -1, 100, 25, 10 * S)).toBe(2 * S - 80 * MS)
  })

  it('Schritt kürzer als ein Bild: genau ein Bild weiter', () => {
    expect(nudgeTime(2 * S, 1, 10, 25, 10 * S)).toBe(2 * S + 40 * MS)
    expect(nudgeTime(2 * S, -1, 10, 25, 10 * S)).toBe(2 * S - 40 * MS)
    // 100 Bilder/s: 10 ms = ein Bild
    expect(nudgeTime(2 * S, 1, 10, 100, 10 * S)).toBe(2 * S + 10 * MS)
  })

  it('bleibt zwischen Anfang und Ende', () => {
    expect(nudgeTime(0, -1, 100, 25, 10 * S)).toBe(0)
    expect(nudgeTime(200 * MS, -1, 1000, 25, 10 * S)).toBe(0)
    expect(nudgeTime(9_800 * MS, 1, 1000, 25, 10 * S)).toBe(10 * S)
    expect(nudgeTime(0, 1, 100, 25, 0)).toBe(0)
  })

  it('isNudgeStep kennt nur 10/100/1000', () => {
    expect([10, 100, 1000].every(isNudgeStep)).toBe(true)
    expect([0, 50, '100', null].some(isNudgeStep)).toBe(false)
  })
})

describe('Schrittknöpfe im Vorschau-Player', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
  })

  const player = async () => {
    const { default: PreviewPlayer } = await import('@/components/timeline/PreviewPlayer.vue')
    const store = useTimelineStore()
    // Ein Text gibt der Timeline eine Länge von 5 s (30 Bilder/s).
    store.addText({ ...DEFAULT_TEXT_STYLE, text: 'x' }, 5 * S)
    store.seek(2 * S)
    const w = mount(PreviewPlayer, {
      global: { plugins: [i18n], stubs: { PositionFrame: true } },
    })
    return { w, store }
  }

  it('− und + verschieben um den gewählten Schritt; Auswahl wird gemerkt', async () => {
    const { w, store } = await player()
    expect(store.doc.settings.fps).toBe(30)
    // Standard 100 ms = 3 Bilder
    expect(w.get('[data-testid="preview-nudge-100"]').attributes('aria-pressed')).toBe('true')
    await w.get('[data-testid="preview-nudge-forward"]').trigger('click')
    expect(store.playhead).toBe(2 * S + 100 * MS)
    await w.get('[data-testid="preview-nudge-1000"]').trigger('click')
    await w.get('[data-testid="preview-nudge-back"]').trigger('click')
    expect(store.playhead).toBe(1 * S + 100 * MS)
    expect(localStorage.getItem('videoCutter.nudgeStep')).toBe('1000')
    w.unmount()

    const again = await player()
    expect(again.w.get('[data-testid="preview-nudge-1000"]').attributes('aria-pressed')).toBe(
      'true',
    )
    again.w.unmount()
  })

  it('am Anfang und am Ende gesperrt', async () => {
    const { w, store } = await player()
    const back = w.get('[data-testid="preview-nudge-back"]')
    const forward = w.get('[data-testid="preview-nudge-forward"]')
    store.seek(0)
    await w.vm.$nextTick()
    expect(back.attributes('disabled')).toBeDefined()
    expect(forward.attributes('disabled')).toBeUndefined()
    store.seek(store.duration)
    await w.vm.$nextTick()
    expect(forward.attributes('disabled')).toBeDefined()
    w.unmount()
  })
})
