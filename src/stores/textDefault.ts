import { defineStore } from 'pinia'
import { ref } from 'vue'
import { parseTextDefault, type TextDefault } from '@/timeline/textDefault'

const STORAGE_KEY = 'videoCutter.textDefault'

function readStorage(): TextDefault | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? parseTextDefault(JSON.parse(raw)) : null
  } catch {
    return null
  }
}

/**
 * Text-Standard: gespeicherte Einstellungen, die neue Texte übernehmen. Bleibt
 * in diesem Browser erhalten, bis der Nutzer ihn aufhebt.
 */
export const useTextDefaultStore = defineStore('textDefault', () => {
  const value = ref<TextDefault | null>(readStorage())

  /** Einstellungen eines Textes als Standard speichern; `false` = unbrauchbare Daten. */
  function save(data: Record<string, unknown>): boolean {
    const parsed = parseTextDefault(data)
    if (!parsed) return false
    value.value = parsed
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed))
    } catch {
      // Gesperrter Speicher: Standard gilt nur für diese Sitzung.
    }
    return true
  }

  function clear(): void {
    value.value = null
    try {
      localStorage.removeItem(STORAGE_KEY)
    } catch {
      // nichts zu tun
    }
  }

  return { value, save, clear }
})
