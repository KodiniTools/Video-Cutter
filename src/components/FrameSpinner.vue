<script setup lang="ts">
import { onBeforeUnmount } from 'vue'

/**
 * ▲▼-Spinner (wie an den Start/Ende-Feldern): ein Klick = ein Schritt,
 * Gedrückthalten wiederholt. Was ein Schritt ist (1 Bild, 10 ms …), entscheidet
 * der Aufrufer über das `step`-Ereignis (+1 / −1).
 */
const props = defineProps<{
  /** Beschriftung (Tooltip/Screenreader) für ▲ und ▼. */
  upLabel: string
  downLabel: string
  disabled?: boolean
}>()

const emit = defineEmits<{ (e: 'step', dir: 1 | -1): void }>()

let holdDelay: ReturnType<typeof setTimeout> | null = null
let holdTimer: ReturnType<typeof setInterval> | null = null

function stop(): void {
  if (holdDelay) clearTimeout(holdDelay)
  if (holdTimer) clearInterval(holdTimer)
  holdDelay = null
  holdTimer = null
}

function start(dir: 1 | -1): void {
  stop()
  if (props.disabled) return
  emit('step', dir)
  holdDelay = setTimeout(() => {
    holdTimer = setInterval(() => {
      if (props.disabled) stop()
      else emit('step', dir)
    }, 90)
  }, 350)
}

onBeforeUnmount(stop)
</script>

<template>
  <span class="frame-spinner" role="group">
    <button
      class="spin"
      type="button"
      :disabled="disabled"
      :title="upLabel"
      :aria-label="upLabel"
      @pointerdown.prevent="start(1)"
      @pointerup="stop"
      @pointerleave="stop"
      @pointercancel="stop"
      @keydown.enter.prevent="emit('step', 1)"
      @keydown.space.prevent="emit('step', 1)"
    >
      ▲
    </button>
    <button
      class="spin"
      type="button"
      :disabled="disabled"
      :title="downLabel"
      :aria-label="downLabel"
      @pointerdown.prevent="start(-1)"
      @pointerup="stop"
      @pointerleave="stop"
      @pointercancel="stop"
      @keydown.enter.prevent="emit('step', -1)"
      @keydown.space.prevent="emit('step', -1)"
    >
      ▼
    </button>
  </span>
</template>

<style scoped>
.frame-spinner {
  display: inline-flex;
  flex-direction: column;
  flex: none;
}
.spin {
  width: 26px;
  height: 16px;
  padding: 0;
  display: grid;
  place-items: center;
  border: 1px solid var(--ds-border-strong);
  background: var(--ds-surface-2);
  color: var(--ds-text);
  cursor: pointer;
  font-size: 9px;
  line-height: 1;
  touch-action: manipulation;
}
.spin:first-child {
  border-radius: var(--ds-radius-sm) var(--ds-radius-sm) 0 0;
  border-bottom: none;
}
.spin:last-child {
  border-radius: 0 0 var(--ds-radius-sm) var(--ds-radius-sm);
}
.spin:hover:not(:disabled) {
  border-color: var(--ds-accent);
}
.spin:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.spin:focus-visible {
  outline: none;
  box-shadow: var(--ds-focus-ring);
}
</style>
