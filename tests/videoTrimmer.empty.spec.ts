import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import VideoTrimmer from '@/components/VideoTrimmer.vue'
import { i18n } from '@/i18n'

/**
 * Leerzustand: Der Editor ist sofort sichtbar, auch ohne Video. Videos kommen
 * über „Videos hochladen" bzw. die Ablagefläche im Player dazu.
 */
describe('VideoTrimmer – Editor ohne Video', () => {
  let wrapper: VueWrapper | null = null

  beforeEach(() => {
    i18n.global.locale.value = 'de'
    const pinia = createPinia()
    setActivePinia(pinia)
    wrapper = mount(VideoTrimmer, {
      global: { plugins: [pinia, i18n] },
      attachTo: document.body,
    })
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
  })

  it('zeigt den vollen Editor statt einer Startseite', () => {
    const w = wrapper!
    expect(w.find('.editor').exists()).toBe(true)
    expect(w.find('.panel-left').exists()).toBe(true)
    expect(w.find('.canvas').exists()).toBe(true)
    expect(w.find('.panel-right').exists()).toBe(true)
    expect(w.text()).toContain('Noch kein Video')
  })

  it('bietet im Player eine Ablagefläche mit Datei-Eingabe', () => {
    const zone = wrapper!.find('.video-wrap .player-empty')
    expect(zone.exists()).toBe(true)
    expect(zone.find('input[type="file"][accept="video/*"]').exists()).toBe(true)
    // Player bleibt eingehängt (Refs/Vorschau), ist aber versteckt und ohne Quelle.
    const video = wrapper!.find('video.player')
    expect(video.exists()).toBe(true)
    expect((video.element as HTMLVideoElement).style.display).toBe('none')
    expect(video.attributes('src')).toBeUndefined()
  })

  it('sperrt videobezogene Aktionen', () => {
    const w = wrapper!
    const right = w.find('.panel-right')
    expect(right.attributes('inert')).toBeDefined()
    expect(w.find('.cursor-row').attributes('inert')).toBeDefined()
    expect(w.find('.preview-row').attributes('inert')).toBeDefined()
    expect(w.find('.crop-toggle').attributes('disabled')).toBeDefined()
    expect(w.find('.export').attributes('disabled')).toBeDefined()
    expect(w.find('.merge').attributes('disabled')).toBeDefined()
    expect(w.find('.filebar .danger').attributes('disabled')).toBeDefined()
  })

  it('lässt Hochladen, Bild-Clip und Projekte bedienbar', () => {
    const left = wrapper!.find('.panel-left')
    expect(left.attributes('inert')).toBeUndefined()
    const upload = left.find('label.add input[type="file"]')
    expect(upload.exists()).toBe(true)
    expect(upload.attributes('disabled')).toBeUndefined()
    // Hochladen-Knopf in der Kopfzeile
    expect(wrapper!.find('.filebar-actions input[type="file"]').exists()).toBe(true)
  })
})
