import { describe, it, expect } from 'vitest'
import { mergeMessages, themeCss, applySiteTheme } from '@/content/site'

describe('Content-Schicht (Kodini Designer)', () => {
  const base = {
    de: { app: { title: 'Video schneiden', subtitle: 'Sub' }, footer: 'Fuß' },
    en: { app: { title: 'Cut video', subtitle: 'Sub' }, footer: 'Foot' },
  }

  it('mergeMessages: nicht-leere Strings überschreiben, leere bleiben Standard', () => {
    const merged = mergeMessages(base, {
      de: { app: { title: 'Mein Titel', subtitle: '' }, footer: '  ' },
      en: { app: { title: 'My title' } },
    })
    expect(merged.de.app.title).toBe('Mein Titel')
    expect(merged.de.app.subtitle).toBe('Sub')
    expect(merged.de.footer).toBe('Fuß')
    expect(merged.en.app.title).toBe('My title')
    expect(base.de.app.title).toBe('Video schneiden') // Basis unverändert
  })

  it('mergeMessages: unbekannte Schlüssel und falsche Typen werden ignoriert', () => {
    const merged = mergeMessages(base, { de: { app: { title: 42, extra: 'x' } }, fr: { a: 'b' } })
    expect(merged.de.app.title).toBe('Video schneiden')
    expect((merged.de.app as Record<string, unknown>).extra).toBeUndefined()
    expect((merged as Record<string, unknown>).fr).toBeUndefined()
  })

  it('themeCss: nur gültige Hex-Farben, je Modus getrennt', () => {
    expect(themeCss(undefined)).toBe('')
    expect(themeCss({ accent: '', light: { bg: '' } })).toBe('')
    const css = themeCss({
      accent: '#ff0000',
      playhead: 'rot',
      light: { bg: '#fff', surface: 'nope' },
      dark: { text: '#e6edf3' },
    })
    expect(css).toContain(
      ':root{--vc-accent:#ff0000;--vc-accent-soft:rgba(255, 0, 0, 0.16);--vc-focus:rgba(255, 0, 0, 0.6)}',
    )
    expect(css).not.toContain('playhead')
    expect(css).toContain(":root[data-theme='light']{--vc-bg:#fff}")
    expect(css).toContain(":root[data-theme='dark']{--vc-text:#e6edf3}")
  })

  it('applySiteTheme: fügt genau ein <style id="site-theme"> ein', () => {
    applySiteTheme(document, { theme: {} })
    expect(document.getElementById('site-theme')).toBeNull()
    applySiteTheme(document, { theme: { accent: '#123456' } })
    applySiteTheme(document, { theme: { accent: '#abcdef' } })
    const els = document.querySelectorAll('#site-theme')
    expect(els.length).toBe(1)
    expect(els[0].textContent).toContain('--vc-accent:#abcdef')
  })
})
