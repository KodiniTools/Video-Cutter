import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import {
  clampFadeDuration,
  isCurve,
  parseAudioFadeSettings,
  toAudioFadeInput,
  type AudioFadeSettings,
  type FadeSide,
} from '@/lib/audioFade'

const STORAGE_KEY = 'videoCutter.audioFade'

function readStorage(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

/**
 * Ton ein-/ausblenden: gilt für jedes Schneiden und Zusammenfügen (bei
 * Videos mit Ton) und bleibt über Videos und Sitzungen hinweg eingestellt.
 */
export const useAudioFadeStore = defineStore('audioFade', () => {
  const settings = ref<AudioFadeSettings>(parseAudioFadeSettings(readStorage()))

  watch(
    settings,
    (s) => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(s))
      } catch {
        // Gesperrter Speicher: Einstellung gilt nur für diese Sitzung.
      }
    },
    { deep: true },
  )

  /** Ist mindestens eine Seite aktiv? */
  const active = computed(() => settings.value.fadeIn.enabled || settings.value.fadeOut.enabled)
  /** Parameter für den Server-Job (`undefined` = aus). */
  const input = computed(() => toAudioFadeInput(settings.value))

  function update(side: 'fadeIn' | 'fadeOut', patch: Partial<FadeSide>): void {
    const cur = settings.value[side]
    settings.value = {
      ...settings.value,
      [side]: {
        enabled: patch.enabled ?? cur.enabled,
        duration:
          patch.duration !== undefined
            ? clampFadeDuration(patch.duration, cur.duration)
            : cur.duration,
        curve: patch.curve !== undefined && isCurve(patch.curve) ? patch.curve : cur.curve,
      },
    }
  }

  return { settings, active, input, update }
})
