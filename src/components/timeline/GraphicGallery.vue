<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  EMOJI_PRESETS,
  GRAPHIC_SYMBOLS,
  MAX_EMOJI_LENGTH,
  SYMBOL_NAMES,
  type GraphicSymbol,
} from '@/lib/graphicOverlay'
import type { TimelineGraphicKind } from '@/timeline/graphics'

/**
 * Galerie „+ Form / Emoji“ der Timeline: Formen und Linien, Symbole und
 * Emojis als Kacheln (wie im bisherigen Editor). Ein Klick legt das Element
 * am Abspielkopf an; die Einstellungen stehen danach neben der Vorschau.
 */
const emit = defineEmits<{
  (e: 'add', kind: TimelineGraphicKind, extra: { symbol?: GraphicSymbol; emoji?: string }): void
}>()

const { t } = useI18n()

const SHAPES: { kind: TimelineGraphicKind; icon: string }[] = [
  { kind: 'rect', icon: '▭' },
  { kind: 'ellipse', icon: '◯' },
  { kind: 'bubble', icon: '🗨' },
  { kind: 'line', icon: '╱' },
  { kind: 'arrow', icon: '➝' },
]

const open = ref(false)
const root = ref<HTMLElement | null>(null)
const toggle = ref<HTMLButtonElement | null>(null)
const panel = ref<HTMLElement | null>(null)
const customEmoji = ref('')
/** Lage im Fenster: unter dem Knopf, wenn dort Platz ist – sonst darüber. */
const place = ref<{ left: string; top: string }>({ left: '0px', top: '0px' })

const GAP = 4
const EDGE = 8

function position(): void {
  const btn = toggle.value?.getBoundingClientRect()
  const box = panel.value?.getBoundingClientRect()
  if (!btn || !box) return
  const below = btn.bottom + GAP
  const fitsBelow = below + box.height <= window.innerHeight - EDGE
  const top = fitsBelow ? below : Math.max(EDGE, btn.top - GAP - box.height)
  const left = Math.max(EDGE, Math.min(btn.left, window.innerWidth - EDGE - box.width))
  place.value = { left: `${left}px`, top: `${top}px` }
}

function pick(kind: TimelineGraphicKind, extra: { symbol?: GraphicSymbol; emoji?: string }): void {
  emit('add', kind, extra)
  open.value = false
}

function addCustomEmoji(): void {
  const e = customEmoji.value.trim()
  if (!e) return
  customEmoji.value = ''
  pick('emoji', { emoji: e })
}

function close(focusToggle: boolean): void {
  open.value = false
  if (focusToggle) toggle.value?.focus()
}

/** Klick außerhalb schließt die Galerie. */
function onOutside(event: PointerEvent): void {
  if (root.value && !root.value.contains(event.target as Node)) open.value = false
}

/** Die Seite scrollt oder ändert die Größe: Galerie schließen (sie hinge sonst in der Luft). */
function onViewportChange(event: Event): void {
  if (event.type === 'scroll' && panel.value?.contains(event.target as Node)) return
  open.value = false
}

function listen(on: boolean): void {
  const fn = on ? 'addEventListener' : 'removeEventListener'
  document[fn]('pointerdown', onOutside as EventListener, true)
  window[fn]('scroll', onViewportChange, true)
  window[fn]('resize', onViewportChange)
}

watch(open, (now) => {
  listen(now)
  if (now) void nextTick(position)
})
onBeforeUnmount(() => listen(false))
</script>

<template>
  <span ref="root" class="gallery" @keydown.esc.stop.prevent="close(true)">
    <button
      ref="toggle"
      type="button"
      class="toggle"
      data-testid="timeline-add-graphic"
      aria-haspopup="dialog"
      :aria-expanded="open"
      :title="t('timeline.addGraphicTitle')"
      @click="open = !open"
    >
      {{ t('timeline.addGraphic') }} <span aria-hidden="true">▾</span>
    </button>
    <div
      v-if="open"
      ref="panel"
      class="panel"
      :style="place"
      role="dialog"
      data-testid="graphic-gallery"
      :aria-label="t('timeline.addGraphicTitle')"
    >
      <div class="group">
        <span class="label">{{ t('graphics.shapes') }}</span>
        <div class="grid">
          <button
            v-for="s in SHAPES"
            :key="s.kind"
            type="button"
            class="pick"
            :data-pick="s.kind"
            :title="t(`graphics.kinds.${s.kind}`)"
            :aria-label="t(`graphics.kinds.${s.kind}`)"
            @click="pick(s.kind, {})"
          >
            <span aria-hidden="true">{{ s.icon }}</span>
          </button>
        </div>
      </div>
      <div class="group">
        <span class="label">{{ t('graphics.symbolsTitle') }}</span>
        <div class="grid">
          <button
            v-for="s in SYMBOL_NAMES"
            :key="s"
            type="button"
            class="pick"
            :data-pick="`symbol:${s}`"
            :title="t(`graphics.symbols.${s}`)"
            :aria-label="t(`graphics.symbols.${s}`)"
            @click="pick('symbol', { symbol: s })"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <path
                :d="GRAPHIC_SYMBOLS[s].path"
                :fill="GRAPHIC_SYMBOLS[s].stroke ? 'none' : 'currentColor'"
                :stroke="GRAPHIC_SYMBOLS[s].stroke ? 'currentColor' : 'none'"
                stroke-width="3"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </button>
        </div>
      </div>
      <div class="group">
        <span class="label">{{ t('graphics.emojis') }}</span>
        <div class="grid">
          <button
            v-for="e in EMOJI_PRESETS"
            :key="e"
            type="button"
            class="pick emoji"
            :data-pick="`emoji:${e}`"
            :aria-label="e"
            @click="pick('emoji', { emoji: e })"
          >
            {{ e }}
          </button>
        </div>
        <div class="custom">
          <input
            v-model="customEmoji"
            class="input"
            type="text"
            data-testid="graphic-gallery-emoji"
            :maxlength="MAX_EMOJI_LENGTH"
            :placeholder="t('graphics.customEmoji')"
            :aria-label="t('graphics.customEmoji')"
            @keydown.enter.prevent.stop="addCustomEmoji"
            @keydown.stop
          />
          <button
            type="button"
            class="pick"
            data-testid="graphic-gallery-emoji-add"
            :disabled="!customEmoji.trim()"
            :aria-label="t('graphics.customEmoji')"
            @click="addCustomEmoji"
          >
            +
          </button>
        </div>
      </div>
    </div>
  </span>
</template>

<style scoped>
.gallery {
  position: relative;
  display: inline-flex;
}
.toggle {
  height: var(--ds-control-sm);
  padding: 0 var(--ds-space-3);
  border: 1px solid var(--ds-border);
  border-radius: var(--ds-radius-md);
  background: var(--ds-surface-2);
  color: var(--ds-text);
  font-size: var(--ds-text-sm);
  cursor: pointer;
}
.toggle:hover,
.toggle[aria-expanded='true'] {
  border-color: var(--ds-accent);
}
.toggle:focus-visible,
.pick:focus-visible,
.input:focus-visible {
  outline: none;
  box-shadow: var(--ds-focus-ring);
}
.panel {
  position: fixed;
  z-index: 50;
  max-height: calc(100vh - 16px);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: var(--ds-space-3);
  width: min(340px, 90vw);
  padding: var(--ds-space-3);
  border: 1px solid var(--ds-border-strong);
  border-radius: var(--ds-radius-lg);
  background: var(--ds-surface-1);
  box-shadow: 0 8px 24px rgb(0 0 0 / 0.18);
}
.group {
  display: flex;
  flex-direction: column;
  gap: var(--ds-space-1);
}
.label {
  font-size: var(--ds-text-sm);
  color: var(--ds-text-2);
}
.grid {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.pick {
  display: inline-grid;
  place-items: center;
  min-width: 34px;
  height: 32px;
  padding: 2px 6px;
  border: 1px solid var(--ds-border);
  border-radius: var(--ds-radius-md);
  background: var(--ds-surface-2);
  color: var(--ds-text);
  font-size: var(--ds-text-lg);
  line-height: 1;
  cursor: pointer;
}
.pick:hover:not(:disabled) {
  border-color: var(--ds-accent);
}
.pick:disabled {
  opacity: 0.45;
  cursor: default;
}
.custom {
  display: flex;
  gap: 4px;
  margin-top: 4px;
}
.input {
  flex: 1;
  min-width: 0;
  height: 32px;
  padding: 0 var(--ds-space-2);
  border: 1px solid var(--ds-border);
  border-radius: var(--ds-radius-md);
  background: var(--ds-surface-0);
  color: var(--ds-text);
  font-size: var(--ds-text-lg);
}
</style>
