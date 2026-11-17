<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { useI18n } from 'vue-i18n'

/**
 * Regler mit Zahlenfeld (▲▼) daneben. Ersetzt ein `<input type="range">`:
 * Attribute und Ereignisse (`data-testid`, `@input`, `@change` …) landen
 * unverändert auf dem Regler. Das Zahlenfeld stellt den Regler und löst
 * dessen `input`- und `change`-Ereignis aus, der Aufrufer merkt keinen
 * Unterschied. Eine Eingabe im Zahlenfeld ist damit ein Rückgängig-Schritt.
 */
defineOptions({ inheritAttrs: false })

const props = withDefaults(
  defineProps<{
    value: number
    min: number | string
    max: number | string
    step: number | string
    /** Faktor für die Anzeige im Zahlenfeld, z. B. 100 für Anteile 0 … 1 als Prozent. */
    scale?: number
    disabled?: boolean
  }>(),
  { scale: 1, disabled: false },
)

const { t } = useI18n()
const range = ref<HTMLInputElement | null>(null)
const num = ref<HTMLInputElement | null>(null)

/** Rundet Rechenreste weg (0,1 + 0,2), ohne Nachkommastellen der Schritte zu verlieren. */
const tidy = (v: number) => Number(v.toFixed(4))
const shown = computed(() => tidy(props.value * props.scale))
const numMin = computed(() => tidy(Number(props.min) * props.scale))
const numMax = computed(() => tidy(Number(props.max) * props.scale))
const numStep = computed(() => tidy(Number(props.step) * props.scale))

function onNumber(): void {
  const field = num.value
  const slider = range.value
  if (!field || !slider) return
  const typed = field.value.trim() === '' ? Number.NaN : Number(field.value)
  // Unverändert (z. B. Enter und danach das `change` beim Verlassen): nichts auslösen.
  if (Number.isFinite(typed) && typed !== shown.value) {
    const wanted = Math.min(numMax.value, Math.max(numMin.value, typed)) / props.scale
    // Der Regler rundet selbst auf seine Schritte und Grenzen.
    slider.value = String(wanted)
    slider.dispatchEvent(new Event('input', { bubbles: true }))
    slider.dispatchEvent(new Event('change', { bubbles: true }))
  }
  // Abgelehnte oder gerundete Eingaben: beide Felder zeigen wieder den echten Wert.
  void nextTick(() => {
    if (num.value) num.value.value = String(shown.value)
    if (range.value) range.value.value = String(props.value)
  })
}
</script>

<template>
  <span class="range-spinner">
    <input
      ref="range"
      v-bind="$attrs"
      type="range"
      :min="min"
      :max="max"
      :step="step"
      :value="value"
      :disabled="disabled"
    />
    <input
      ref="num"
      class="num"
      type="number"
      :min="numMin"
      :max="numMax"
      :step="numStep"
      :value="shown"
      :disabled="disabled"
      :aria-label="t('timeline.exactValue')"
      :data-testid="$attrs['data-testid'] ? `${String($attrs['data-testid'])}-num` : undefined"
      @change="onNumber"
      @keydown.enter.prevent="onNumber"
      @keydown.stop
    />
  </span>
</template>

<style scoped>
.range-spinner {
  display: flex;
  align-items: center;
  gap: var(--ds-space-2);
  min-width: 0;
}
input[type='range'] {
  flex: 1;
  width: 100%;
  min-width: 0;
  accent-color: var(--ds-accent);
}
.num {
  flex: none;
  width: 4.4em;
  height: 26px;
  padding: 0 0 0 var(--ds-space-1);
  border: 1px solid var(--ds-border);
  border-radius: var(--ds-radius-sm);
  background: var(--ds-surface-0);
  color: var(--ds-text);
  font: inherit;
  font-size: var(--ds-text-sm);
  font-variant-numeric: tabular-nums;
}
/* ▲▼ immer zeigen, nicht erst beim Überfahren (Chromium blendet sie sonst aus). */
.num::-webkit-inner-spin-button {
  opacity: 1;
}
input:focus-visible {
  outline: none;
  box-shadow: var(--ds-focus-ring);
}
</style>
