import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { mount } from '@vue/test-utils'
import { i18n } from '@/i18n'
import TextPanel from '@/components/TextPanel.vue'
import { nudgePosition } from '@/lib/textOverlay'
import { useTextOverlayStore } from '@/stores/textOverlays'

describe('Exakte Text-Position', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ fonts: [] }))),
    )
  })
  afterEach(() => vi.unstubAllGlobals())

  const panel = () =>
    mount(TextPanel, {
      props: {
        duration: 10,
        currentTime: 0,
        busy: false,
        burning: false,
        progressLabel: '',
        canBurn: true,
      },
      global: { plugins: [i18n] },
    })

  it('X/Y per Zahlenfeld (begrenzt, Unsinn verworfen) und ±-Knöpfe', async () => {
    const texts = useTextOverlayStore()
    texts.setItem(1)
    texts.add(0, 10, 'Hallo')
    const w = panel()
    await w.vm.$nextTick()
    const nums = w.findAll('input.pos-num')
    expect(nums).toHaveLength(2)

    await nums[0].setValue('12.3')
    await nums[0].trigger('change')
    expect(texts.selected?.x).toBeCloseTo(0.123, 6)

    await nums[1].setValue('150')
    await nums[1].trigger('change')
    expect(texts.selected?.y).toBe(1)

    await nums[1].setValue('abc')
    await nums[1].trigger('change')
    expect(texts.selected?.y).toBe(1)

    const plusX = w.findAll('button.step')[1]
    await plusX.trigger('click')
    expect(texts.selected?.x).toBeCloseTo(0.128, 6)
  })

  it('Pfeiltasten: 0,1 % fein, 1 % mit Umschalt, am Rand begrenzt', () => {
    const p = { x: 0.5, y: 0.5 }
    expect(nudgePosition(p, 'ArrowRight', false)).toEqual({ x: 0.501, y: 0.5 })
    expect(nudgePosition(p, 'ArrowUp', true)).toEqual({ x: 0.5, y: 0.49 })
    expect(nudgePosition({ x: 0, y: 1 }, 'ArrowLeft', true)).toEqual({ x: 0, y: 1 })
    expect(nudgePosition({ x: 0, y: 1 }, 'ArrowDown', false)).toEqual({ x: 0, y: 1 })
    expect(nudgePosition(p, 'Enter', false)).toBeNull()
  })
})
