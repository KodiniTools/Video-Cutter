import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { i18n } from '@/i18n'
import FontSelect from '@/components/FontSelect.vue'
import { loadCustomFonts } from '@/lib/customFonts'

const entry = (file: string, group: string, label: string, weight: number) => ({
  key: `f:${file.replace(/\.[^.]+$/, '')}`,
  file,
  group,
  label,
  weight,
  italic: false,
  lineRatio: 1.3,
  shift: 0,
})

describe('FontSelect (Schriftauswahl in eigener Schrift)', () => {
  beforeAll(async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              fonts: [
                entry('Supreme-Bold.woff2', 'Supreme', 'Bold', 700),
                entry('Supreme-Regular.woff2', 'Supreme', 'Regular', 400),
                entry('Zodiak-Regular.woff2', 'Zodiak', 'Regular', 400),
              ],
            }),
          ),
      ),
    )
    await loadCustomFonts()
  })
  afterAll(() => vi.unstubAllGlobals())

  const make = (value = 'roboto', disabled = false) =>
    mount(FontSelect, {
      props: { value, disabled },
      attrs: { 'data-testid': 'text-font' },
      global: { plugins: [i18n] },
      attachTo: document.body,
    })

  it('zeigt die aktuelle Schrift in sich selbst', async () => {
    const w = make('f:Supreme-Bold')
    await flushPromises()
    const btn = w.get('[data-testid="text-font"]')
    expect(btn.text()).toContain('Supreme Bold')
    expect(btn.attributes('style')).toContain('"VCF Supreme-Bold"')
    w.unmount()
  })

  it('listet Standard- und eigene Schriften, jede in ihrer eigenen Schrift', async () => {
    const w = make()
    await flushPromises()
    await w.get('[data-testid="text-font"]').trigger('click')
    const options = w.findAll('[role="option"]')
    expect(options.map((o) => o.attributes('data-font'))).toEqual([
      'roboto',
      'montserrat',
      'bebas',
      'lora',
      'pacifico',
      'f:Supreme-Regular',
      'f:Supreme-Bold',
      'f:Zodiak-Regular',
    ])
    expect(options[0].attributes('style')).toContain('"VC Roboto"')
    expect(options[5].attributes('style')).toContain('"VCF Supreme-Regular"')
    expect(options[0].attributes('aria-selected')).toBe('true')
    expect(w.findAll('.group').map((g) => g.text())).toEqual(['Standard', 'Supreme', 'Zodiak'])
    w.unmount()
  })

  it('Klick wählt eine Schrift und schließt die Liste', async () => {
    const w = make()
    await flushPromises()
    await w.get('[data-testid="text-font"]').trigger('click')
    await w.get('[data-font="f:Zodiak-Regular"]').trigger('click')
    expect(w.emitted('change')).toEqual([['f:Zodiak-Regular']])
    expect(w.find('[role="listbox"]').exists()).toBe(false)
    w.unmount()
  })

  it('Tastatur: ▼ öffnet, ▼▼ Enter wählt, Esc schließt ohne Auswahl', async () => {
    const w = make('lora')
    await flushPromises()
    const btn = w.get('[data-testid="text-font"]')
    await btn.trigger('keydown', { key: 'ArrowDown' })
    expect(w.find('[role="listbox"]').exists()).toBe(true)
    await btn.trigger('keydown', { key: 'Escape' })
    expect(w.find('[role="listbox"]').exists()).toBe(false)
    expect(w.emitted('change')).toBeUndefined()

    await btn.trigger('keydown', { key: 'ArrowDown' })
    await btn.trigger('keydown', { key: 'ArrowDown' })
    await btn.trigger('keydown', { key: 'ArrowDown' })
    await btn.trigger('keydown', { key: 'Enter' })
    expect(w.emitted('change')).toEqual([['f:Supreme-Regular']])
    w.unmount()
  })

  it('gesperrt: öffnet nicht', async () => {
    const w = make('roboto', true)
    await w.get('[data-testid="text-font"]').trigger('click')
    expect(w.find('[role="listbox"]').exists()).toBe(false)
    w.unmount()
  })
})
