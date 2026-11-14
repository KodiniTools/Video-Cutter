import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import SpeedPanel from '@/components/SpeedPanel.vue'
import { i18n } from '@/i18n'

const mountWith = (over: Record<string, unknown> = {}) =>
  mount(SpeedPanel, {
    props: {
      step: 0,
      duration: 6,
      canApply: true,
      busy: false,
      applying: false,
      progressLabel: 'Verarbeite 40%',
      done: false,
      ...over,
    },
    global: { plugins: [i18n] },
  })

describe('SpeedPanel (Tempo eines einzelnen Videos)', () => {
  it('Regler meldet die Stufe; Anwenden erst ab Stufe ≠ 0', async () => {
    const w = mountWith()
    const apply = w.find('button.apply')
    expect(apply.attributes('disabled')).toBeDefined()
    await w.find('input[type=range]').setValue('-1')
    expect(w.emitted('update:step')).toEqual([[-1]])
  })

  it('zeigt Faktor und neue Länge; ↺ setzt zurück; Anwenden meldet sich', async () => {
    const w = mountWith({ step: 1 })
    expect(w.find('.speed-value').text()).toContain('2×')
    expect(w.find('.hint.length').text()).toContain('00:03.000')
    expect(w.find('.hint.length').text()).toContain('00:06.000')
    await w.find('.speed-head button').trigger('click')
    await w.find('button.apply').trigger('click')
    expect(w.emitted('update:step')).toEqual([[0]])
    expect(w.emitted('apply')).toHaveLength(1)
  })

  it('ohne Video gesperrt mit Hinweis; während des Laufs Fortschritt', () => {
    const none = mountWith({ canApply: false, step: 1 })
    expect(none.find('input[type=range]').attributes('disabled')).toBeDefined()
    expect(none.find('button.apply').attributes('disabled')).toBeDefined()
    const busy = mountWith({ step: 1, busy: true, applying: true })
    expect(busy.find('button.apply').text()).toBe('Verarbeite 40%')
    expect(mountWith({ done: true }).find('.hint.done').exists()).toBe(true)
  })
})
