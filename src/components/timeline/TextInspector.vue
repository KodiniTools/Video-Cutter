<script setup lang="ts">
import { computed, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import RangeSpinner from './RangeSpinner.vue'
import FontSelect from '@/components/FontSelect.vue'
import {
  ANIM_SPEEDS,
  DEFAULT_TEXT_STYLE,
  formatAnimSpeed,
  MAX_TEXT_LENGTH,
  MAX_TEXT_SIZE,
  MIN_TEXT_SIZE,
  POSITION_PRESETS,
  TEXT_ANIMATIONS,
  TEXT_STYLES,
  type PositionPreset,
} from '@/lib/textOverlay'
import { useTimelineStore } from '@/stores/timeline'
import { useTextDefaultStore } from '@/stores/textDefault'
import { matchesTextDefault, textDefaultPatches } from '@/timeline/textDefault'
import OverlayKeys from './OverlayKeys.vue'
import { graphicMotionAt, withGraphicChange } from '@/timeline/graphicKeys'

/**
 * Einstellungen des markierten Text-Clips. Jede Änderung geht ins Dokument,
 * die Vorschau rendert den betroffenen Abschnitt neu. Tippen und Ziehen eines
 * Reglers zählen zusammen als ein Rückgängig-Schritt.
 */

/** Wie auf dem Server: höchstens so viele Zeilen je Text. */
const MAX_TEXT_LINES = 6

const { t, locale } = useI18n()
const fontLabelId = `text-font-label-${Math.random().toString(36).slice(2, 9)}`
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
/** Zeit im Clip, an der der Abspielkopf steht (in den Clip geholt). */
const offset = computed(() => {
  const c = clip.value
  return c ? Math.min(c.duration, Math.max(0, store.playhead - c.start)) : 0
})
/** Mitte am Abspielkopf (mit Keyframes: der Wert an dieser Stelle). */
const motion = computed(() =>
  clip.value
    ? graphicMotionAt(clip.value, offset.value)
    : { x: DEFAULT_TEXT_STYLE.x, y: DEFAULT_TEXT_STYLE.y, scale: 1 },
)
const x = computed(() => motion.value.x)
const y = computed(() => motion.value.y)
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

/** Mitte ändern: mit Keyframes im Keyframe am Abspielkopf. */
const place = (at: { x?: number; y?: number }) =>
  clip.value ? withGraphicChange(clip.value, offset.value, at) : {}

function preset(name: PositionPreset): void {
  set(place({ x: 0.5, y: POSITION_PRESETS[name] }))
}

// --- Text-Standard -----------------------------------------------------------

const textDefault = useTextDefaultStore()

/** Vollständige Einstellungen des markierten Textes (fehlende Felder = Vorgabe). */
const currentStyle = computed<Record<string, unknown>>(() => ({
  ...DEFAULT_TEXT_STYLE,
  animSpeed: 1,
  ...clip.value?.data,
}))

/** Entspricht der markierte Text dem gespeicherten Standard? */
const isDefault = computed(
  () => !!textDefault.value && matchesTextDefault(currentStyle.value, textDefault.value),
)
/** Weicht irgendein Text vom Standard ab? */
const othersDiffer = computed(
  () => !!textDefault.value && textDefaultPatches(store.doc, textDefault.value).length > 0,
)

/** Gespeicherten Standard auf alle Texte anwenden (ein Rückgängig-Schritt). */
function applyDefaultToAll(): void {
  commit()
  const def = textDefault.value
  if (!def) return
  const patches = textDefaultPatches(store.doc, def)
  if (patches.length > 0) store.updateClipsData(patches)
}

/** Diesen Text als Standard speichern; alle anderen Texte übernehmen ihn. */
function saveDefault(): void {
  commit()
  if (clip.value && textDefault.save(currentStyle.value)) applyDefaultToAll()
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
      <div class="field">
        <span :id="fontLabelId">{{ t('text.font') }}</span>
        <FontSelect
          :value="font"
          :aria-labelledby="fontLabelId"
          data-testid="text-font"
          @change="set({ font: $event })"
        />
      </div>
      <label class="field">
        <span>{{ t('text.size') }} {{ percent(size) }} %</span>
        <RangeSpinner
          :scale="100"
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
        <RangeSpinner
          :scale="100"
          min="0"
          max="1"
          step="0.005"
          :value="x"
          data-testid="text-x"
          @input="edit(place({ x: clamp01(Number(value($event))) }))"
          @change="commit"
        />
      </label>
      <label class="field">
        <span>{{ t('text.pos.y') }} {{ percent(y) }} %</span>
        <RangeSpinner
          :scale="100"
          min="0"
          max="1"
          step="0.005"
          :value="y"
          data-testid="text-y"
          @input="edit(place({ y: clamp01(Number(value($event))) }))"
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
    <div class="default" data-testid="text-default">
      <span class="default-title">{{ t('timeline.textDefault.title') }}</span>
      <div class="presets">
        <button
          type="button"
          data-testid="text-default-save"
          :disabled="isDefault"
          :title="t('timeline.textDefault.saveTitle')"
          @click="saveDefault"
        >
          {{ t(textDefault.value ? 'timeline.textDefault.update' : 'timeline.textDefault.save') }}
        </button>
        <button
          v-if="textDefault.value"
          type="button"
          data-testid="text-default-apply"
          :disabled="!othersDiffer"
          :title="t('timeline.textDefault.applyTitle')"
          @click="applyDefaultToAll"
        >
          {{ t('timeline.textDefault.apply') }}
        </button>
        <button
          v-if="textDefault.value"
          type="button"
          data-testid="text-default-clear"
          :title="t('timeline.textDefault.clearTitle')"
          @click="textDefault.clear()"
        >
          {{ t('timeline.textDefault.clear') }}
        </button>
      </div>
      <p class="hint" data-testid="text-default-status">
        {{
          t(
            !textDefault.value
              ? 'timeline.textDefault.none'
              : isDefault
                ? 'timeline.textDefault.active'
                : 'timeline.textDefault.differs',
          )
        }}
      </p>
    </div>
    <OverlayKeys :clip="clip" prefix="text" :hint="t('timeline.textKeys.hint')" />
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
/* Direkt im Feld-Stapel: natürliche Höhe (die Basis oben gilt nur in Zeilen). */
.inspector > .field {
  flex: none;
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
.presets button:hover:not(:disabled) {
  border-color: var(--ds-accent);
}
.presets button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
textarea:focus-visible,
select:focus-visible,
input:focus-visible,
button:focus-visible {
  outline: none;
  box-shadow: var(--ds-focus-ring);
}
.default {
  display: flex;
  flex-direction: column;
  gap: var(--ds-space-2);
  padding-top: var(--ds-space-3);
  border-top: 1px solid var(--ds-border);
}
.default-title {
  font-size: var(--ds-text-sm);
  font-weight: var(--ds-weight-semibold);
}
.hint {
  margin: 0;
  color: var(--ds-text-2);
  font-size: var(--ds-text-xs, var(--ds-text-sm));
}
</style>
