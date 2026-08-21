<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue'

const props = defineProps<{
  /** Beschriftung des Buttons (aktuelle Auswahl). */
  label: string
  /** Überschrift im Menü + Button-Title. */
  title?: string
  disabled?: boolean
  /** Ausrichtung des Menüs relativ zum Button. */
  align?: 'left' | 'right'
}>()

const open = ref(false)
const root = ref<HTMLElement | null>(null)

function toggle(): void {
  if (!props.disabled) open.value = !open.value
}
function close(): void {
  open.value = false
}
function onDocPointerDown(e: PointerEvent): void {
  if (open.value && root.value && !root.value.contains(e.target as Node)) open.value = false
}
function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') open.value = false
}

onMounted(() => {
  document.addEventListener('pointerdown', onDocPointerDown)
  document.addEventListener('keydown', onKey)
})
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocPointerDown)
  document.removeEventListener('keydown', onKey)
})
</script>

<template>
  <div ref="root" class="dropdown">
    <button
      class="menu-trigger"
      type="button"
      :disabled="disabled"
      :aria-haspopup="true"
      :aria-expanded="open"
      :title="title"
      @click="toggle"
    >
      <span v-if="title" class="menu-kicker">{{ title }}</span>
      <span class="menu-label">{{ label }}</span>
      <span class="menu-caret" aria-hidden="true">▾</span>
    </button>
    <div
      v-if="open"
      class="menu-panel"
      :class="align === 'right' ? 'align-right' : 'align-left'"
      role="menu"
    >
      <slot :close="close" />
    </div>
  </div>
</template>

<style scoped>
.dropdown {
  position: relative;
}
.menu-trigger {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border: 1px solid var(--vc-border);
  border-radius: 9px;
  background: var(--vc-surface);
  color: var(--vc-text);
  font-size: 14px;
  cursor: pointer;
  transition:
    border-color 0.15s,
    background 0.15s;
}
.menu-trigger:hover:not(:disabled) {
  border-color: var(--vc-accent);
}
.menu-trigger:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.menu-trigger:focus-visible {
  outline: 2px solid var(--vc-focus);
  outline-offset: 2px;
}
.menu-kicker {
  font-size: 11px;
  color: var(--vc-text-dim);
  text-transform: uppercase;
  letter-spacing: 0.03em;
}
.menu-label {
  font-weight: 600;
}
.menu-caret {
  color: var(--vc-text-dim);
  font-size: 11px;
}

.menu-panel {
  position: absolute;
  top: calc(100% + 6px);
  z-index: 30;
  min-width: 240px;
  max-width: 320px;
  padding: 6px;
  border: 1px solid var(--vc-border);
  border-radius: 10px;
  background: var(--vc-surface);
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.2);
}
.align-left {
  left: 0;
}
.align-right {
  right: 0;
}
</style>
