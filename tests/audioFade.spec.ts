import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import {
  AUDIO_FADE_CURVES,
  DEFAULT_AUDIO_FADE,
  clampFadeDuration,
  fadeGain,
  fadePath,
  parseAudioFadeSettings,
  toAudioFadeInput,
} from '@/lib/audioFade'
import { useAudioFadeStore } from '@/stores/audioFade'

describe('audioFade (lib)', () => {
  it('jede Kurve geht beim Einblenden von 0 auf 1 und steigt monoton', () => {
    for (const c of AUDIO_FADE_CURVES) {
      expect(fadeGain(c, 0)).toBeCloseTo(0, 4)
      expect(fadeGain(c, 1)).toBeCloseTo(1, 4)
      let prev = -1
      for (let i = 0; i <= 20; i++) {
        const g = fadeGain(c, i / 20)
        expect(g).toBeGreaterThanOrEqual(prev - 1e-9)
        prev = g
      }
    }
  })

  it('Ausblenden ist gespiegelt (Pfad beginnt oben, endet unten)', () => {
    const p = fadePath('tri', true, 60, 24, 2)
    expect(p).toBe('M0.0,0.0 L30.0,12.0 L60.0,24.0')
  })

  it('Dauer wird auf Raster und Grenzen gebracht', () => {
    expect(clampFadeDuration(2.3, 1)).toBe(2.5)
    expect(clampFadeDuration(0, 1)).toBe(0.5)
    expect(clampFadeDuration(99, 1)).toBe(10)
    expect(clampFadeDuration('x', 3)).toBe(3)
  })

  it('kaputte gespeicherte Werte -> Standard', () => {
    expect(parseAudioFadeSettings('{kaputt')).toEqual(DEFAULT_AUDIO_FADE)
    expect(parseAudioFadeSettings(null)).toEqual(DEFAULT_AUDIO_FADE)
    expect(
      parseAudioFadeSettings('{"fadeIn":{"enabled":true,"duration":3,"curve":"böse"}}').fadeIn,
    ).toEqual({ enabled: true, duration: 3, curve: 'tri' })
  })

  it('Server-Parameter: aus -> undefined, sonst Dauer 0 für inaktive Seite', () => {
    expect(toAudioFadeInput(DEFAULT_AUDIO_FADE)).toBeUndefined()
    expect(
      toAudioFadeInput({
        fadeIn: { enabled: false, duration: 2, curve: 'tri' },
        fadeOut: { enabled: true, duration: 4, curve: 'log' },
      }),
    ).toEqual({ inDuration: 0, inCurve: 'tri', outDuration: 4, outCurve: 'log' })
  })
})

describe('useAudioFadeStore', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
  })

  it('aktualisiert, begrenzt und speichert die Einstellung', async () => {
    const s = useAudioFadeStore()
    expect(s.active).toBe(false)
    s.update('fadeIn', { enabled: true, duration: 50, curve: 'exp' })
    expect(s.active).toBe(true)
    expect(s.input).toEqual({ inDuration: 10, inCurve: 'exp', outDuration: 0, outCurve: 'tri' })
    await nextTick()
    // Neue Sitzung liest die gespeicherte Einstellung.
    setActivePinia(createPinia())
    expect(useAudioFadeStore().settings.fadeIn).toEqual({
      enabled: true,
      duration: 10,
      curve: 'exp',
    })
  })
})
