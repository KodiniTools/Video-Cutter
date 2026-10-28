import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import { i18n, type AppLocale } from '@/i18n'

// Theme- und Sprach-Einstellungen, übernommen aus dem Collage Maker
// (src/stores/settings.ts). Die globale SSI-Navigation besitzt die Schalter;
// dieser Store hält App, Design-Tokens und Nav über localStorage 'theme'/'locale',
// html[data-theme] und das 'locale-changed'-Event synchron.

export type Theme = 'light' | 'dark'
export type Locale = AppLocale

export function parseTheme(value: string | null | undefined): Theme {
  return value === 'dark' ? 'dark' : 'light'
}

export function parseLocale(value: string | null | undefined): Locale | null {
  return value === 'de' || value === 'en' ? value : null
}

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Privater Modus / gesperrter Speicher: Einstellung gilt nur für diese Sitzung.
  }
}

// SSI nav translations — keys must match the data-i18n attributes in nav.html
const ssiNavTranslations: Record<string, Record<string, string>> = {
  de: {
    'nav.audioTools': 'Audiotools',
    'nav.mp3Converter': 'MP3 Konverter',
    'nav.audioEqualizer': 'Interaktiver Audio Equalizer',
    'nav.modernPlayer': 'Moderner Musikplayer',
    'nav.ultimatePlayer': 'Ultimativer Musikplayer',
    'nav.playlistGenerator': 'Wiedergabeliste Generator',
    'nav.playlistConverter': 'Wiedergabeliste Konverter',
    'nav.alarmTool': 'Alarmtool',
    'nav.audioNormalizer': 'Audio Normalizer',
    'nav.visualizer': 'Visualizer',
    'nav.equalizer19': '19-Band Equalizer',
    'nav.audioConverter': 'Audio Konverter',
    'nav.imageTools': 'Bildtools',
    'nav.imageConverter': 'Bildkonverter',
    'nav.batchImageEditor': 'Bildserie bearbeiten',
    'nav.photoCollage': 'Fotocollage',
    'nav.tools': 'Tools',
    'nav.colorExtractor': 'Kodini Farbextraktor',
    'nav.videoConverter': 'Videokonverter',
    'nav.contact': 'Kontakt',
    'aria.toggleTheme': 'Theme wechseln',
    'aria.selectLanguage': 'Sprache wählen',
    'aria.menuOpen': 'Menü öffnen',
    'aria.menuClose': 'Menü schliessen',
    'aria.mainNav': 'Hauptnavigation',
  },
  en: {
    'nav.audioTools': 'Audio Tools',
    'nav.mp3Converter': 'MP3 Converter',
    'nav.audioEqualizer': 'Interactive Audio Equalizer',
    'nav.modernPlayer': 'Modern Music Player',
    'nav.ultimatePlayer': 'Ultimate Music Player',
    'nav.playlistGenerator': 'Audio Playlist Generator',
    'nav.playlistConverter': 'Playlist to WebM Converter',
    'nav.alarmTool': 'Alarm Tool',
    'nav.audioNormalizer': 'Audio Normalizer',
    'nav.visualizer': 'Visualizer',
    'nav.equalizer19': '19-Band Equalizer',
    'nav.audioConverter': 'Audio Converter',
    'nav.imageTools': 'Image Tools',
    'nav.imageConverter': 'Image Converter',
    'nav.batchImageEditor': 'Batch Image Editor',
    'nav.photoCollage': 'Photo Collage',
    'nav.tools': 'Tools',
    'nav.colorExtractor': 'Kodini Color Extractor',
    'nav.videoConverter': 'Video Converter',
    'nav.contact': 'Contact',
    'aria.toggleTheme': 'Toggle theme',
    'aria.selectLanguage': 'Select language',
    'aria.menuOpen': 'Open menu',
    'aria.menuClose': 'Close menu',
    'aria.mainNav': 'Main navigation',
  },
}

export const useSettingsStore = defineStore('settings', () => {
  const theme = ref<Theme>(parseTheme(readStorage('theme')))
  const locale = ref<Locale>(parseLocale(readStorage('locale')) ?? 'de')

  // MutationObserver state (declared early because theme watcher runs immediately)
  let themeObserver: MutationObserver | null = null
  let ignoreMutation = false

  // Theme watcher: html[data-theme] schaltet die Design-Tokens (--ds-*) und die
  // globale SSI-Navigation, html.dark bleibt als Altbestand für externe Skripte.
  // Abweichung zum Collage Maker: body.light-theme wird bewusst NICHT gesetzt –
  // der Block auf <body> würde die Farb-Overrides des Kodini Designers (auf
  // :root, src/content/site.ts) für alle App-Elemente verdecken.
  watch(
    theme,
    (newTheme) => {
      writeStorage('theme', newTheme)
      // Suppress MutationObserver while we set the attribute ourselves
      ignoreMutation = true
      document.documentElement.classList.toggle('dark', newTheme === 'dark')
      document.documentElement.setAttribute('data-theme', newTheme)
      ignoreMutation = false
      // Sync SSI nav theme icons (moon/sun emoji)
      document.querySelectorAll('.global-nav-theme-icon').forEach((icon) => {
        icon.textContent = newTheme === 'light' ? '\uD83C\uDF19' : '\u2600\uFE0F'
      })
    },
    { immediate: true },
  )

  // Locale watcher - sync localStorage, html lang, vue-i18n, SSI nav buttons & text
  watch(
    locale,
    (newLocale) => {
      writeStorage('locale', newLocale)
      document.documentElement.setAttribute('lang', newLocale)
      i18n.global.locale.value = newLocale
      syncNavLangButtons(newLocale)
      translateSsiNav(newLocale)
    },
    { immediate: true },
  )

  // Listen for locale-changed event from global SSI nav
  function onLocaleChanged(e: Event) {
    const customEvent = e as CustomEvent<{ locale?: string }>
    const newLang = parseLocale(customEvent.detail?.locale)
    if (newLang && newLang !== locale.value) {
      locale.value = newLang
    }
  }

  // Translate all SSI nav DOM elements using data-i18n attributes
  function translateSsiNav(lang: string) {
    const t = ssiNavTranslations[lang] || ssiNavTranslations['de']
    const nav = document.querySelector('.global-nav')
    if (!nav) return

    nav.querySelectorAll('[data-i18n]').forEach((el) => {
      const key = el.getAttribute('data-i18n')
      if (key && t[key]) el.textContent = t[key]
    })

    nav.querySelectorAll('[data-i18n-aria]').forEach((el) => {
      const key = el.getAttribute('data-i18n-aria')
      if (key && t[key]) el.setAttribute('aria-label', t[key])
    })

    nav.querySelectorAll('[data-i18n-title]').forEach((el) => {
      const key = el.getAttribute('data-i18n-title')
      if (key && t[key]) el.setAttribute('title', t[key])
    })
  }

  // Keep SSI nav buttons' active class in sync
  function syncNavLangButtons(lang: string) {
    document.querySelectorAll('.global-nav-lang-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-lang') === lang)
    })
  }

  function startThemeObserver() {
    themeObserver = new MutationObserver((mutations) => {
      if (ignoreMutation) return
      for (const m of mutations) {
        if (m.type === 'attributes' && m.attributeName === 'data-theme') {
          const attr = document.documentElement.getAttribute('data-theme')
          if (attr === 'light' || attr === 'dark') {
            if (attr !== theme.value) theme.value = attr
          }
        }
      }
    })
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    })
  }

  function startListening() {
    stopListening()
    window.addEventListener('locale-changed', onLocaleChanged)
    startThemeObserver()
  }

  function stopListening() {
    window.removeEventListener('locale-changed', onLocaleChanged)
    if (themeObserver) {
      themeObserver.disconnect()
      themeObserver = null
    }
  }

  // Auto-start listening
  startListening()

  function toggleTheme() {
    theme.value = theme.value === 'light' ? 'dark' : 'light'
  }

  function setTheme(newTheme: Theme) {
    theme.value = newTheme
  }

  function setLocale(newLocale: Locale) {
    locale.value = newLocale
  }

  return {
    theme,
    locale,
    toggleTheme,
    setTheme,
    setLocale,
    startListening,
    stopListening,
  }
})
