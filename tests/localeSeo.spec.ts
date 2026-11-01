import { describe, expect, it } from 'vitest'
import { applyLocaleHead, localeUrls, resolveInitialLocale } from '@/utils/localeSeo'

const BASE = 'https://kodinitools.com/video-cutter/'

describe('resolveInitialLocale', () => {
  it('?lang hat Vorrang vor der gespeicherten Sprache', () => {
    expect(resolveInitialLocale('?lang=en', 'de')).toBe('en')
    expect(resolveInitialLocale('?source=x&lang=de', 'en')).toBe('de')
  })

  it('ohne Speicher (Googlebot) gilt ?lang=en, ohne Parameter Deutsch', () => {
    expect(resolveInitialLocale('?lang=en', null)).toBe('en')
    expect(resolveInitialLocale('', null)).toBe('de')
  })

  it('ungültige Werte fallen auf Speicher bzw. Deutsch zurück', () => {
    expect(resolveInitialLocale('?lang=fr', 'en')).toBe('en')
    expect(resolveInitialLocale('', 'xx')).toBe('de')
  })
})

describe('localeUrls', () => {
  it('Canonical folgt der Sprache, hreflang ist für beide Sprachen gleich', () => {
    expect(localeUrls(BASE, 'de').canonical).toBe(BASE)
    expect(localeUrls(BASE, 'en').canonical).toBe(`${BASE}?lang=en`)
    for (const locale of ['de', 'en'] as const) {
      expect(localeUrls(BASE, locale).alternates).toEqual([
        { hreflang: 'de', href: BASE },
        { hreflang: 'en', href: `${BASE}?lang=en` },
        { hreflang: 'x-default', href: BASE },
      ])
    }
  })
})

describe('applyLocaleHead', () => {
  it('setzt lang, Titel, Canonical und genau drei hreflang-Links', () => {
    applyLocaleHead(BASE, 'en', { title: 'EN title', description: 'EN desc' })
    applyLocaleHead(BASE, 'en', { title: 'EN title', description: 'EN desc' })
    expect(document.documentElement.lang).toBe('en')
    expect(document.title).toBe('EN title')
    expect(document.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe(
      `${BASE}?lang=en`,
    )
    expect(document.querySelectorAll('link[rel="alternate"][hreflang]')).toHaveLength(3)

    applyLocaleHead(BASE, 'de')
    expect(document.documentElement.lang).toBe('de')
    expect(document.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe(BASE)
  })
})
