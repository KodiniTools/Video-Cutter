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
const DURATION_KEY = 'vc-animation-duration'
const DEFAULT: AnimationId = 'fade'
/** Grenzen der Übergangsdauer in Sekunden. */
export const MIN_DURATION = 1
export const MAX_DURATION = 10
const DEFAULT_DURATION = 2

function load(): AnimationId {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v && ANIMATIONS.some((a) => a.id === v)) return v as AnimationId
  } catch {
    /* localStorage nicht verfügbar -> Standard nutzen */
  }
  return DEFAULT
}

function clampDuration(v: number): number {
  if (!Number.isFinite(v)) return DEFAULT_DURATION
  return Math.min(MAX_DURATION, Math.max(MIN_DURATION, Math.round(v)))
}

function loadDuration(): number {
  try {
    const v = localStorage.getItem(DURATION_KEY)
    if (v !== null) return clampDuration(Number(v))
  } catch {
    /* localStorage nicht verfügbar -> Standard nutzen */
  }
  return DEFAULT_DURATION
}

// Singleton: alle Komponenten teilen dieselbe Auswahl.
const animation = ref<AnimationId>(load())
/** Übergangsdauer in Sekunden (gleichmäßig auf beide Clips), 1–10. */
const duration = ref<number>(loadDuration())

watch(animation, (v) => {
  try {
    localStorage.setItem(STORAGE_KEY, v)
  } catch {
    /* Speichern nicht möglich -> ignorieren */
  }
})

watch(duration, (v) => {
  const c = clampDuration(v)
  if (c !== v) {
    duration.value = c
    return
  }
  try {
    localStorage.setItem(DURATION_KEY, String(c))
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
  return { animation, duration, transitionName, animations: ANIMATIONS }
}
