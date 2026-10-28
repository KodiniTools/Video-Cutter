import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { useSettingsStore, parseTheme, parseLocale } from '@/stores/settings'
import { i18n } from '@/i18n'

describe('Settings-Store (Theme/Sprache, synchron mit der SSI-Navigation)', () => {
  let store: ReturnType<typeof useSettingsStore> | null = null

  beforeEach(() => {
    localStorage.clear()
    document.documentElement.removeAttribute('data-theme')
    document.documentElement.className = ''
    document.body.innerHTML = ''
    setActivePinia(createPinia())
  })

  afterEach(() => {
    store?.stopListening()
    store = null
    i18n.global.locale.value = 'de'
  })

  it('parst gespeicherte Werte defensiv', () => {
    expect(parseTheme('dark')).toBe('dark')
    expect(parseTheme('blau')).toBe('light')
    expect(parseTheme(null)).toBe('light')
    expect(parseLocale('en')).toBe('en')
    expect(parseLocale('fr')).toBeNull()
  })

  it('startet mit Light/DE und setzt html[data-theme] sowie lang', () => {
    store = useSettingsStore()
    expect(store.theme).toBe('light')
    expect(store.locale).toBe('de')
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    expect(document.documentElement.getAttribute('lang')).toBe('de')
  })

  it('übernimmt gespeicherte Einstellungen und schaltet vue-i18n um', () => {
    localStorage.setItem('theme', 'dark')
    localStorage.setItem('locale', 'en')
    store = useSettingsStore()
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(i18n.global.locale.value).toBe('en')
  })

  it('setzt body.light-theme nicht (Designer-Overrides auf :root bleiben wirksam)', async () => {
    store = useSettingsStore()
    store.toggleTheme()
    store.toggleTheme()
    await nextTick()
    expect(document.body.classList.contains('light-theme')).toBe(false)
  })

  it('folgt dem locale-changed-Event der Navigation und übersetzt die Nav', async () => {
    document.body.innerHTML = `
      <nav class="global-nav">
        <span data-i18n="nav.contact">Kontakt</span>
        <button class="global-nav-lang-btn active" data-lang="de"></button>
        <button class="global-nav-lang-btn" data-lang="en"></button>
      </nav>`
    store = useSettingsStore()
    window.dispatchEvent(new CustomEvent('locale-changed', { detail: { locale: 'en' } }))
    await nextTick()
    expect(store.locale).toBe('en')
    expect(localStorage.getItem('locale')).toBe('en')
    expect(i18n.global.locale.value).toBe('en')
    expect(document.querySelector('[data-i18n="nav.contact"]')?.textContent).toBe('Contact')
    expect(document.querySelector('[data-lang="en"]')?.classList.contains('active')).toBe(true)
    expect(document.querySelector('[data-lang="de"]')?.classList.contains('active')).toBe(false)
  })

  it('ignoriert unbekannte Sprachen aus dem Event', async () => {
    store = useSettingsStore()
    window.dispatchEvent(new CustomEvent('locale-changed', { detail: { locale: 'fr' } }))
    await nextTick()
    expect(store.locale).toBe('de')
  })

  it('übernimmt einen Theme-Wechsel der Navigation (html[data-theme])', async () => {
    store = useSettingsStore()
    document.documentElement.setAttribute('data-theme', 'dark')
    // MutationObserver liefert asynchron (Microtask)
    await new Promise((r) => setTimeout(r, 0))
    expect(store.theme).toBe('dark')
    expect(localStorage.getItem('theme')).toBe('dark')
  })
})
