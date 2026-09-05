import { describe, it, expect } from 'vitest'
import { mergeMessages, themeCss, slotCss, flattenSlotStyles, applySiteTheme } from '@/content/site'

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

describe('slotCss', () => {
  it('liefert leer ohne Styles', () => {
    expect(slotCss(undefined)).toBe('')
    expect(slotCss({ app: { title: {} } })).toBe('')
    expect(slotCss({ app: { title: { size: 0, spacing: 0, weight: '', font: '' } } })).toBe('')
  })
  it('baut Regeln je Slot inkl. @font-face und Farben je Modus', () => {
    const css = slotCss({
      app: {
        title: {
          font: 'Supreme-Bold.woff2',
          size: 28,
          weight: '700',
          spacing: 1.5,
          transform: 'uppercase',
          colorLight: '#112233',
          colorDark: '#eeeeee',
        },
      },
      drop: { hint: { colorLight: 'rot', size: -3, weight: '999' } },
    })
    expect(css).toContain(
      '@font-face{font-family:"kodini-font-Supreme-Bold";src:url("/fonts/Supreme-Bold.woff2") format("woff2")',
    )
    expect(css).toContain(
      '[data-slot="app.title"]{font-family:"kodini-font-Supreme-Bold",system-ui,sans-serif !important;font-size:28px !important;font-weight:700 !important;letter-spacing:1.5px !important;text-transform:uppercase !important}',
    )
    expect(css).toContain(
      `:root[data-theme='light'] [data-slot="app.title"]{color:#112233 !important}`,
    )
    expect(css).toContain(
      `:root[data-theme='dark'] [data-slot="app.title"]{color:#eeeeee !important}`,
    )
    expect(css).not.toContain('drop.hint')
  })
  it('ignoriert ungültige Slot-Schlüssel und Schriftdateien', () => {
    expect(slotCss({ 'x"y': { size: 10 }, ok: { font: '../evil.woff2' } })).toBe('')
  })
  it('flattenSlotStyles löst verschachtelte Schlüssel zu Slot-Namen auf', () => {
    const flat = flattenSlotStyles({
      app: { title: { size: 20 }, subtitle: { weight: '600' } },
      footer: { colorDark: '#fff' },
      junk: 'x',
    })
    expect(Object.keys(flat).sort()).toEqual(['app.subtitle', 'app.title', 'footer'])
    expect(flat['app.title'].size).toBe(20)
  })
})
