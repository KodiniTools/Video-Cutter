import { describe, it, expect } from 'vitest'
import { nextTick } from 'vue'
import { useAnimationPref, ANIMATIONS } from '@/composables/useAnimationPref'

describe('useAnimationPref', () => {
  it('bietet die erwarteten Presets inkl. Ein-/Ausblenden', () => {
    const ids = ANIMATIONS.map((a) => a.id)
    expect(ids).toEqual(['none', 'fade', 'slide', 'scale', 'flip'])
  })

  it('transitionName folgt der Auswahl', async () => {
    const { animation, transitionName } = useAnimationPref()
    animation.value = 'slide'
    await nextTick()
    expect(transitionName.value).toBe('anim-slide')
    animation.value = 'none'
    await nextTick()
    expect(transitionName.value).toBe('anim-none')
  })

  it('speichert die Auswahl in localStorage', async () => {
    const { animation } = useAnimationPref()
    animation.value = 'flip'
    await nextTick()
    expect(localStorage.getItem('vc-animation')).toBe('flip')
  })
})
