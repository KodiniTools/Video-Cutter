<script setup lang="ts">
import { computed, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  ANIM_SPEEDS,
  DEFAULT_TEXT_STYLE,
  FONT_OPTIONS,
  formatAnimSpeed,
  MAX_TEXT_LENGTH,
  MAX_TEXT_SIZE,
  MIN_TEXT_SIZE,
  POSITION_PRESETS,
  TEXT_ANIMATIONS,
  TEXT_FONTS,
  TEXT_STYLES,
  type PositionPreset,
} from '@/lib/textOverlay'
import { useTimelineStore } from '@/stores/timeline'

/**
 * Einstellungen des markierten Text-Clips. Jede Änderung geht ins Dokument,
 * die Vorschau rendert den betroffenen Abschnitt neu. Tippen und Ziehen eines
 * Reglers zählen zusammen als ein Rückgängig-Schritt.
 */

/** Wie auf dem Server: höchstens so viele Zeilen je Text. */
const MAX_TEXT_LINES = 6

const { t, locale } = useI18n()
const store = useTimelineStore()

/** Der Text-Clip, wenn genau einer markiert ist. */
const clip = computed(() => {
  const [only, ...rest] = store.selectedClips
  return only && rest.length === 0 && only.kind === 'text' ? only : null
})

const str = (key: string, fallback: string) => {
  const v = clip.value?.data[key]
  return typeof v === 'string' ? v : fallback
}
const num = (key: string, fallback: number) => {
  const v = clip.value?.data[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

const text = computed(() => str('text', ''))
const font = computed(() => str('font', DEFAULT_TEXT_STYLE.font))
const size = computed(() => num('size', DEFAULT_TEXT_STYLE.size))
const color = computed(() => str('color', DEFAULT_TEXT_STYLE.color))
const style = computed(() => str('style', DEFAULT_TEXT_STYLE.style))
const accent = computed(() => str('accent', DEFAULT_TEXT_STYLE.accent))
const animation = computed(() => str('animation', DEFAULT_TEXT_STYLE.animation))
const animSpeed = computed(() => num('animSpeed', 1))
const x = computed(() => num('x', DEFAULT_TEXT_STYLE.x))
const y = computed(() => num('y', DEFAULT_TEXT_STYLE.y))
const percent = (v: number) => Math.round(v * 1000) / 10

let editing = false

/** Änderung übernehmen; bis `commit` zählt alles als ein Schritt. */
function edit(patch: Record<string, unknown>): void {
  const id = clip.value?.id
  if (!id) return
  if (!editing) {
    store.beginGesture()
    editing = true
  }
  store.updateClipData(id, patch)
}

function commit(): void {
  if (!editing) return
  editing = false
  store.endGesture()
}

/** Einzelne Auswahl (Liste, Farbe, Knopf): sofort ein eigener Schritt. */
function set(patch: Record<string, unknown>): void {
  commit()
  const id = clip.value?.id
  if (id) store.updateClipData(id, patch)
}

const value = (e: Event) => (e.target as HTMLInputElement | HTMLSelectElement).value

function onText(e: Event): void {
  const el = e.target as HTMLTextAreaElement
  const lines = el.value.split('\n')
  // Mehr Zeilen nähme der Server nicht an.
  if (lines.length > MAX_TEXT_LINES) el.value = lines.slice(0, MAX_TEXT_LINES).join('\n')
  edit({ text: el.value })
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

function preset(name: PositionPreset): void {
  set({ x: 0.5, y: POSITION_PRESETS[name] })
}

onBeforeUnmount(commit)
</script>

<template>
  <section v-if="clip" class="inspector" data-testid="text-inspector" @focusout="commit">
    <h3>{{ t('timeline.textInspector') }}</h3>
    <label class="field">
      <span>{{ t('text.content') }}</span>
      <textarea
        rows="3"
        :maxlength="MAX_TEXT_LENGTH"
        :value="text"
        data-testid="text-content"
        @input="onText"
        @change="commit"
      ></textarea>
    </label>
    <div class="row">
      <label class="field">
        <span>{{ t('text.font') }}</span>
        <select :value="font" data-testid="text-font" @change="set({ font: value($event) })">
          <option v-for="f in TEXT_FONTS" :key="f" :value="f">{{ FONT_OPTIONS[f].label }}</option>
        </select>
      </label>
      <label class="field">
        <span>{{ t('text.size') }} {{ percent(size) }} %</span>
        <input
          type="range"
          :min="MIN_TEXT_SIZE"
          :max="MAX_TEXT_SIZE"
          step="0.005"
          :value="size"
          data-testid="text-size"
          @input="edit({ size: Number(value($event)) })"
          @change="commit"
        />
      </label>
    </div>
    <div class="row">
      <label class="field">
        <span>{{ t('text.style') }}</span>
        <select :value="style" data-testid="text-style" @change="set({ style: value($event) })">
          <option v-for="s in TEXT_STYLES" :key="s" :value="s">{{ t(`text.styles.${s}`) }}</option>
        </select>
      </label>
      <label class="field color">
        <span>{{ t('text.color') }}</span>
        <input
          type="color"
          :value="color"
          data-testid="text-color"
          @change="set({ color: value($event) })"
        />
      </label>
      <label class="field color">
        <span>{{ t('text.accent') }}</span>
        <input
          type="color"
          :value="accent"
          data-testid="text-accent"
          @change="set({ accent: value($event) })"
        />
      </label>
    </div>
    <div class="row">
      <label class="field">
        <span>{{ t('text.animation') }}</span>
        <select
          :value="animation"
          data-testid="text-animation"
          @change="set({ animation: value($event) })"
        >
          <option v-for="a in TEXT_ANIMATIONS" :key="a" :value="a">
            {{ t(`text.animations.${a}`) }}
          </option>
        </select>
      </label>
      <label class="field">
        <span>{{ t('text.animSpeed') }}</span>
        <select
          :value="animSpeed"
          :disabled="animation === 'none'"
          @change="set({ animSpeed: Number(value($event)) })"
        >
          <option v-for="s in ANIM_SPEEDS" :key="s" :value="s">
            {{ formatAnimSpeed(s, locale) }}
          </option>
        </select>
      </label>
    </div>
    <div class="row">
      <label class="field">
        <span>{{ t('text.pos.x') }} {{ percent(x) }} %</span>
        <input
          type="range"
          min="0"
          max="1"
          step="0.005"
          :value="x"
          data-testid="text-x"
          @input="edit({ x: clamp01(Number(value($event))) })"
          @change="commit"
        />
      </label>
      <label class="field">
        <span>{{ t('text.pos.y') }} {{ percent(y) }} %</span>
        <input
          type="range"
          min="0"
          max="1"
          step="0.005"
          :value="y"
          data-testid="text-y"
          @input="edit({ y: clamp01(Number(value($event))) })"
          @change="commit"
        />
      </label>
    </div>
    <div class="presets">
      <span>{{ t('text.position') }}</span>
      <button
        v-for="name in ['top', 'center', 'bottom'] as const"
        :key="name"
        type="button"
        :data-testid="`text-pos-${name}`"
        @click="preset(name)"
      >
        {{ t(`text.positions.${name}`) }}
      </button>
    </div>
    <p class="hint">{{ t('timeline.textInspectorHint') }}</p>
  </section>
</template>

<style scoped>
.inspector {
  display: flex;
  flex-direction: column;
  gap: var(--ds-space-3);
  padding: var(--ds-space-4);
  border: 1px solid var(--ds-border);
  border-radius: var(--ds-radius-lg);
  background: var(--ds-surface-1);
  font-size: var(--ds-text-sm);
}
h3 {
  margin: 0;
  font-size: var(--ds-text-md, var(--ds-text-sm));
  font-weight: var(--ds-weight-semibold);
}
.row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--ds-space-3);
}
.field {
  display: flex;
  flex: 1 1 120px;
  flex-direction: column;
  gap: var(--ds-space-1, 4px);
  min-width: 0;
  color: var(--ds-text-2);
}
.field.color {
  flex: 0 0 auto;
}
textarea,
select {
  width: 100%;
  padding: var(--ds-space-2);
  border: 1px solid var(--ds-border);
  border-radius: var(--ds-radius-md);
  background: var(--ds-surface-2);
  color: var(--ds-text);
  font: inherit;
}
textarea {
  resize: vertical;
}
input[type='range'] {
  width: 100%;
  accent-color: var(--ds-accent);
}
input[type='color'] {
  width: var(--ds-control-sm);
  height: var(--ds-control-sm);
  padding: 2px;
  border: 1px solid var(--ds-border);
  border-radius: var(--ds-radius-md);
  background: var(--ds-surface-2);
  cursor: pointer;
}
.presets {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--ds-space-2);
  color: var(--ds-text-2);
}
.presets button {
  height: var(--ds-control-sm);
  padding: 0 var(--ds-space-3);
  border: 1px solid var(--ds-border);
  border-radius: var(--ds-radius-md);
  background: var(--ds-surface-2);
  color: var(--ds-text);
  cursor: pointer;
}
.presets button:hover {
  border-color: var(--ds-accent);
}
textarea:focus-visible,
select:focus-visible,
input:focus-visible,
button:focus-visible {
  outline: none;
  box-shadow: var(--ds-focus-ring);
}
.hint {
  margin: 0;
  color: var(--ds-text-2);
  font-size: var(--ds-text-xs, var(--ds-text-sm));
}
</style>
