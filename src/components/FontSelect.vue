<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ensureFontFace, groupFonts, useCustomFonts } from '@/lib/customFonts'
import { FONT_OPTIONS, TEXT_FONTS, fontPreview, type TextFont } from '@/lib/textOverlay'

/**
 * Schriftauswahl, bei der jede Schrift in sich selbst gezeigt wird. Ein
 * natives `<select>` kann das nicht verlässlich (macOS/Mobil ignorieren
 * `font-family` an `<option>`), deshalb eine eigene Liste mit Tastatur-
 * bedienung (▲▼, Pos1/Ende, Enter, Esc) und ARIA-Rollen einer Listbox.
 * Eigene Schriften kommen von GET /api/fonts; ihre Dateien werden erst beim
 * Öffnen der Liste geladen.
 */
// Attribute (data-testid, aria-*) gehören an den Knopf, nicht an den Rahmen.
defineOptions({ inheritAttrs: false })

const props = withDefaults(defineProps<{ value: string; disabled?: boolean }>(), {
  disabled: false,
})
const emit = defineEmits<{ (e: 'change', value: TextFont): void }>()

const { t } = useI18n()
const { fonts, loadCustomFonts } = useCustomFonts()
onMounted(() => void loadCustomFonts())

interface Item {
  key: TextFont
  label: string
  css: string
}

const groups = computed<{ group: string; items: Item[] }[]>(() => [
  {
    group: t('text.fontsBuiltin'),
    items: TEXT_FONTS.map((f) => ({
      key: f,
      label: FONT_OPTIONS[f].label,
      css: FONT_OPTIONS[f].css,
    })),
  },
  ...groupFonts(fonts.value).map((g) => ({
    group: g.group,
    items: g.fonts.map((f) => ({
      key: f.key as TextFont,
      label: `${g.group} ${f.label}`,
      css: f.css,
    })),
  })),
])
const flat = computed(() => groups.value.flatMap((g) => g.items))

/** Aktuelle Schrift; fontPreview registriert eine eigene Schrift für die Anzeige. */
const current = computed(() => {
  const p = fontPreview(props.value as TextFont)
  return { label: p.label, css: p.css }
})

const open = ref(false)
const active = ref(0)
const root = ref<HTMLElement | null>(null)
const list = ref<HTMLElement | null>(null)
const uid = `font-select-${Math.random().toString(36).slice(2, 9)}`

const optionId = (i: number) => `${uid}-${i}`

function scrollToActive(): void {
  void nextTick(() => {
    const el = list.value?.querySelector<HTMLElement>(`#${optionId(active.value)}`)
    el?.scrollIntoView?.({ block: 'nearest' })
  })
}

function show(): void {
  if (props.disabled || open.value) return
  // Alle Schriften der Liste für die Anzeige laden (einmal pro Sitzung).
  for (const f of fonts.value) ensureFontFace(f)
  const i = flat.value.findIndex((it) => it.key === props.value)
  active.value = i >= 0 ? i : 0
  open.value = true
  scrollToActive()
}

function hide(): void {
  open.value = false
}

function choose(i: number): void {
  const it = flat.value[i]
  hide()
  if (it && it.key !== props.value) emit('change', it.key)
}

function move(to: number): void {
  const n = flat.value.length
  if (!n) return
  active.value = Math.min(n - 1, Math.max(0, to))
  scrollToActive()
}

function onKey(e: KeyboardEvent): void {
  if (props.disabled) return
  if (!open.value) {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
      e.preventDefault()
      show()
    }
    return
  }
  switch (e.key) {
    case 'ArrowDown':
      e.preventDefault()
      move(active.value + 1)
      break
    case 'ArrowUp':
      e.preventDefault()
      move(active.value - 1)
      break
    case 'Home':
      e.preventDefault()
      move(0)
      break
    case 'End':
      e.preventDefault()
      move(flat.value.length - 1)
      break
    case 'Enter':
    case ' ':
      e.preventDefault()
      choose(active.value)
      break
    case 'Escape':
      e.preventDefault()
      e.stopPropagation()
      hide()
      break
    case 'Tab':
      hide()
      break
  }
}

/** Klick außerhalb schließt die Liste. */
function onDocPointer(e: PointerEvent): void {
  if (open.value && root.value && !root.value.contains(e.target as Node)) hide()
}
onMounted(() => document.addEventListener('pointerdown', onDocPointer, true))
onBeforeUnmount(() => document.removeEventListener('pointerdown', onDocPointer, true))

/** Index jedes Eintrags in der flachen Liste (für Tastatur/ARIA). */
const indexOf = (key: string) => flat.value.findIndex((it) => it.key === key)
</script>

<template>
  <div ref="root" class="font-select" :class="{ open }">
    <button
      v-bind="$attrs"
      type="button"
      class="trigger"
      role="combobox"
      aria-haspopup="listbox"
      :aria-expanded="open"
      :aria-controls="`${uid}-list`"
      :aria-activedescendant="open ? optionId(active) : undefined"
      :disabled="disabled"
      :style="{ fontFamily: `'${current.css}'` }"
      @click="open ? hide() : show()"
      @keydown="onKey"
    >
      <span class="current">{{ current.label }}</span>
      <span class="caret" aria-hidden="true">▾</span>
    </button>
    <div
      v-if="open"
      :id="`${uid}-list`"
      ref="list"
      class="list"
      role="listbox"
      :aria-label="t('text.font')"
      data-testid="font-list"
    >
      <div v-for="g in groups" :key="g.group" role="group" :aria-label="g.group">
        <div class="group" aria-hidden="true">{{ g.group }}</div>
        <div
          v-for="it in g.items"
          :id="optionId(indexOf(it.key))"
          :key="it.key"
          class="option"
          role="option"
          :data-font="it.key"
          :aria-selected="it.key === value"
          :class="{ active: indexOf(it.key) === active, selected: it.key === value }"
          :style="{ fontFamily: `'${it.css}'` }"
          @pointerenter="active = indexOf(it.key)"
          @mousedown.prevent
          @click="choose(indexOf(it.key))"
        >
          {{ it.label }}
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.font-select {
  position: relative;
  min-width: 0;
}
.trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--ds-space-2);
  width: 100%;
  padding: var(--ds-space-2);
  border: 1px solid var(--ds-border);
  border-radius: var(--ds-radius-md);
  background: var(--ds-surface-2);
  color: var(--ds-text);
  font-size: var(--ds-text-md);
  line-height: 1.3;
  text-align: left;
  cursor: pointer;
}
.trigger:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.trigger:focus-visible {
  outline: none;
  box-shadow: var(--ds-focus-ring);
}
.current {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.caret {
  flex: none;
  font-family: var(--ds-font-sans);
  font-size: var(--ds-text-xs, var(--ds-text-sm));
  color: var(--ds-text-2);
}
.list {
  position: absolute;
  z-index: 50;
  top: calc(100% + 2px);
  left: 0;
  min-width: 100%;
  width: max-content;
  max-width: min(22rem, 90vw);
  max-height: 20rem;
  overflow-y: auto;
  padding: var(--ds-space-1) 0;
  border: 1px solid var(--ds-border);
  border-radius: var(--ds-radius-md);
  background: var(--ds-surface-1);
  color: var(--ds-text);
  box-shadow: var(--ds-shadow-overlay);
}
.group {
  padding: var(--ds-space-1) var(--ds-space-2) 0;
  font-family: var(--ds-font-sans);
  font-size: var(--ds-text-xs, var(--ds-text-sm));
  font-weight: var(--ds-weight-semibold);
  color: var(--ds-text-2);
}
.option {
  padding: var(--ds-space-1) var(--ds-space-3);
  font-size: 1.15rem;
  line-height: 1.4;
  white-space: nowrap;
  cursor: pointer;
}
.option.active {
  background: var(--ds-surface-3);
}
.option.selected {
  color: var(--ds-accent);
}
</style>
