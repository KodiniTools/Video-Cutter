import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { FORMAT_PRESETS, findPreset, formatKey, formatLabel, ratioOf } from '@/timeline/formats'
import ProjectSettings from '@/components/timeline/ProjectSettings.vue'
import { useTimelineStore } from '@/stores/timeline'
import { i18n } from '@/i18n'

describe('Formatliste', () => {
  it('jede Größe nur einmal, gerade und innerhalb der Servergrenze', () => {
    const keys = FORMAT_PRESETS.map(formatKey)
    expect(new Set(keys).size).toBe(keys.length)
    for (const p of FORMAT_PRESETS) {
      expect((p.width % 2) + (p.height % 2)).toBe(0)
      expect(Math.max(p.width, p.height)).toBeLessThanOrEqual(3840)
      expect(Math.min(p.width, p.height)).toBeGreaterThanOrEqual(16)
    }
  })

  it('Beschriftung nennt Plattform und Maße', () => {
    const reel = findPreset({ width: 1080, height: 1920 })!
    expect(formatLabel(reel)).toContain('TikTok')
    expect(formatLabel(reel)).toContain('1080 × 1920 (9:16)')
    expect(findPreset({ width: 1000, height: 1500 })!.names.join()).toContain('Pinterest')
  })

  it('Seitenverhältnis gekürzt', () => {
    expect(ratioOf(1920, 800)).toBe('12:5')
    expect(ratioOf(1080, 1920)).toBe('9:16')
  })
})

describe('ProjectSettings Formatauswahl', () => {
  function setup() {
    setActivePinia(createPinia())
    const store = useTimelineStore()
    const wrapper = mount(ProjectSettings, { global: { plugins: [i18n] } })
    return { store, wrapper }
  }

  it('zeigt Plattformnamen in Gruppen und setzt die Größe', async () => {
    const { store, wrapper } = setup()
    const select = wrapper.get('[data-testid="project-size"]')
    expect(select.findAll('optgroup')).toHaveLength(3)
    expect(select.text()).toContain('Instagram Portrait')
    await select.setValue('1000x1500')
    expect(store.doc.settings.width).toBe(1000)
    expect(store.doc.settings.height).toBe(1500)
  })

  it('unbekanntes Format bleibt sichtbar und ausgewählt', async () => {
    const { store, wrapper } = setup()
    store.updateSettings({ width: 1440, height: 1080 })
    await wrapper.vm.$nextTick()
    const select = wrapper.get('[data-testid="project-size"]').element as HTMLSelectElement
    expect(select.value).toBe('1440x1080')
    expect(select.options[select.selectedIndex].text).toContain('1440 × 1080 (4:3)')
  })
})
