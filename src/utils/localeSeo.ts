// Sprachfassungen als eigene URLs: Deutsch ohne Parameter, Englisch mit ?lang=en.
// Canonical und hreflang zeigen darauf; beim Start hat ?lang Vorrang vor der
// gespeicherten Sprache, damit Googlebot (ohne Speicher) unter ?lang=en Englisch sieht.

export type Locale = 'de' | 'en'

export interface LocaleMeta {
  title: string
  description: string
}

export const isLocale = (value: unknown): value is Locale => value === 'de' || value === 'en'

/** Startsprache: ?lang=de|en, dann gespeicherte Wahl, sonst Deutsch. */
export function resolveInitialLocale(search: string, stored: string | null | undefined): Locale {
  const fromUrl = new URLSearchParams(search).get('lang')
  if (isLocale(fromUrl)) return fromUrl
  return isLocale(stored) ? stored : 'de'
}

/** Absolute URL einer Seite in der gewünschten Sprache. */
export function localizedUrl(baseUrl: string, locale: Locale): string {
  return locale === 'en' ? `${baseUrl}?lang=en` : baseUrl
}

/** Canonical und hreflang-Ziele (de, en, x-default = de) für eine Seite. */
export function localeUrls(baseUrl: string, locale: Locale) {
  return {
    canonical: localizedUrl(baseUrl, locale),
    alternates: [
      { hreflang: 'de', href: localizedUrl(baseUrl, 'de') },
      { hreflang: 'en', href: localizedUrl(baseUrl, 'en') },
      { hreflang: 'x-default', href: localizedUrl(baseUrl, 'de') },
    ],
  }
}

function upsert(
  doc: Document,
  selector: string,
  tag: string,
  attrs: Record<string, string>,
): Element {
  let el = doc.head.querySelector(selector)
  if (!el) {
    el = doc.createElement(tag)
    doc.head.appendChild(el)
  }
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value)
  return el
}

/**
 * Schreibt Sprache, Canonical, hreflang und (optional) Titel/Beschreibung in den Head.
 * Open-Graph-Tags werden nur aktualisiert, wenn sie im HTML vorhanden sind.
 */
export function applyLocaleHead(
  baseUrl: string,
  locale: Locale,
  meta?: LocaleMeta,
  doc: Document | undefined = globalThis.document,
): void {
  if (!doc?.head) return
  const { canonical, alternates } = localeUrls(baseUrl, locale)
  doc.documentElement.setAttribute('lang', locale)
  upsert(doc, 'link[rel="canonical"]', 'link', { rel: 'canonical', href: canonical })
  for (const { hreflang, href } of alternates) {
    upsert(doc, `link[rel="alternate"][hreflang="${hreflang}"]`, 'link', {
      rel: 'alternate',
      hreflang,
      href,
    })
  }
  doc.head.querySelector('meta[property="og:url"]')?.setAttribute('content', canonical)
  doc.head
    .querySelector('meta[property="og:locale"]')
    ?.setAttribute('content', locale === 'de' ? 'de_DE' : 'en_US')
  doc.head
    .querySelector('meta[property="og:locale:alternate"]')
    ?.setAttribute('content', locale === 'de' ? 'en_US' : 'de_DE')
  if (!meta) return
  doc.title = meta.title
  upsert(doc, 'meta[name="description"]', 'meta', {
    name: 'description',
    content: meta.description,
  })
  doc.head.querySelector('meta[property="og:title"]')?.setAttribute('content', meta.title)
  doc.head
    .querySelector('meta[property="og:description"]')
    ?.setAttribute('content', meta.description)
  doc.head.querySelector('meta[name="twitter:title"]')?.setAttribute('content', meta.title)
  doc.head
    .querySelector('meta[name="twitter:description"]')
    ?.setAttribute('content', meta.description)
}
