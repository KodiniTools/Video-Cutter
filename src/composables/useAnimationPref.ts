import { ref, computed, watch } from 'vue'

/** Auswählbare Animationsstile für das Zusammensetzen der Ausschnitte. */
export const ANIMATIONS = [
  { id: 'none', labelKey: 'anim.none' },
  { id: 'fade', labelKey: 'anim.fade' },
  { id: 'slide', labelKey: 'anim.slide' },
  { id: 'scale', labelKey: 'anim.scale' },
  { id: 'flip', labelKey: 'anim.flip' },
] as const

export type AnimationId = (typeof ANIMATIONS)[number]['id']

const STORAGE_KEY = 'vc-animation'
const DEFAULT: AnimationId = 'fade'

function load(): AnimationId {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v && ANIMATIONS.some((a) => a.id === v)) return v as AnimationId
  } catch {
    /* localStorage nicht verfügbar -> Standard nutzen */
  }
  return DEFAULT
}

// Singleton: alle Komponenten teilen dieselbe Auswahl.
const animation = ref<AnimationId>(load())

watch(animation, (v) => {
  try {
    localStorage.setItem(STORAGE_KEY, v)
  } catch {
    /* Speichern nicht möglich -> ignorieren */
  }
})

/**
 * Der an <TransitionGroup name="…"> zu übergebende Übergangsname.
 * Für 'none' existieren bewusst keine CSS-Klassen -> sofortiger Wechsel.
 */
const transitionName = computed(() => `anim-${animation.value}`)

export function useAnimationPref() {
  return { animation, transitionName, animations: ANIMATIONS }
}
