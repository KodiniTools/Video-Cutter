<script setup lang="ts">
import { computed, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import RangeSpinner from './RangeSpinner.vue'
import {
  EMOJI_PRESETS,
  GRAPHIC_LOOPS,
  hasColors,
  hasFill,
  hasHeight,
  imageHeight,
  defaultGraphic,
  MAX_CROP,
  MAX_EMOJI_LENGTH,
  MAX_GRAPHIC_H,
  MAX_GRAPHIC_W,
  MAX_STROKE,
  MIN_GRAPHIC_SIZE,
  MIN_IMAGE_OPACITY,
  SYMBOL_NAMES,
} from '@/lib/graphicOverlay'
import { hasImageAsset } from '@/lib/imageAssets'
import {
  ANIM_SPEEDS,
  animParts,
  animPatch,
  formatAnimSpeed,
  IN_ANIMATIONS,
  OUT_ANIMATIONS,
  type AnimParts,
  type InAnimation,
  type OutAnimation,
} from '@/lib/textOverlay'
import { useTimelineStore } from '@/stores/timeline'
import { clipGraphic, loopSpeedOf } from '@/timeline/graphics'
import OverlayKeys from './OverlayKeys.vue'
import { graphicMotionAt, withGraphicChange, type GraphicMotion } from '@/timeline/graphicKeys'

/**
 * Einstellungen des markierten Grafik-Clips (Form, Symbol, Emoji). Jede
 * Änderung geht ins Dokument; die Vorschau zeichnet das Bild neu und rendert
 * den betroffenen Abschnitt. Ziehen eines Reglers zählt als ein
 * Rückgängig-Schritt.
 */

const { t, locale } = useI18n()
const store = useTimelineStore()

/** Der Grafik-Clip, wenn genau einer markiert ist. */
const clip = computed(() => {
  const [only, ...rest] = store.selectedClips
  return only && rest.length === 0 && only.kind === 'graphic' ? only : null
})
/** Vollständige Einstellungen in gültigen Grenzen. */
const g = computed(() => (clip.value ? clipGraphic(clip.value.data) : null))
/** Standardwerte der Art (Ziel der Knöpfe ↺). */
const defaults = computed(() => defaultGraphic(g.value?.kind ?? 'rect'))

const isLine = computed(() => g.value?.kind === 'line' || g.value?.kind === 'arrow')
const sizeLabel = computed(() => {
  if (isLine.value) return t('graphics.length')
  return g.value && (hasHeight(g.value.kind) || g.value.kind === 'image')
    ? t('graphics.width')
    : t('graphics.size')
})
const isImage = computed(() => g.value?.kind === 'image')
/** Bild-Clip, dessen Bild nicht (mehr) im Browser liegt. */
const imageMissing = computed(() => !!g.value && isImage.value && !hasImageAsset(g.value.image))
const CROP_SIDES = [
  { key: 'cropL', label: 'left' },
  { key: 'cropR', label: 'right' },
  { key: 'cropT', label: 'top' },
  { key: 'cropB', label: 'bottom' },
] as const
const cropped = computed(
  () => !!g.value && (g.value.cropL || g.value.cropR || g.value.cropT || g.value.cropB) > 0,
)
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

/** Grafiken kennen keine Schreibmaschine. */
const GRAPHIC_IN_ANIMATIONS = IN_ANIMATIONS.filter((a) => a !== 'typewriter')

/** Ein- und Ausblenden getrennt (ältere Grafiken werden passend gedeutet). */
const anim = computed(() => animParts(clip.value?.data ?? {}))

/** Tempo der Dauer-Animation (ohne eigenes: das Tempo des Einblendens, wie bisher). */
const loopSpeed = computed(() => loopSpeedOf(clip.value?.data ?? {}))

/**
 * Schreibt immer alle vier Felder, damit Ein- und Ausblenden unabhängig
 * bleiben – und hält das Tempo der Dauer-Animation fest, damit es sich mit
 * dem Tempo des Einblendens nicht mehr mitändert.
 */
function setAnim(change: Partial<AnimParts>): void {
  set({ ...animPatch({ ...anim.value, ...change }), loopSpeed: loopSpeed.value })
}

const value = (e: Event) => (e.target as HTMLInputElement | HTMLSelectElement).value
const number = (e: Event) => Number(value(e))
const checked = (e: Event) => (e.target as HTMLInputElement).checked
const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

function onEmoji(e: Event): void {
  const el = e.target as HTMLInputElement
  const text = Array.from(el.value).slice(0, MAX_EMOJI_LENGTH).join('')
  if (text !== el.value) el.value = text
  edit({ emoji: text })
}

// --- Mitte am Abspielkopf (mit Keyframes: der Wert an dieser Stelle) -----------

/** Zeit im Clip, an der der Abspielkopf steht (in den Clip geholt). */
const offset = computed(() => {
  const c = clip.value
  return c ? Math.min(c.duration, Math.max(0, store.playhead - c.start)) : 0
})
const motion = computed<GraphicMotion>(() =>
  clip.value ? graphicMotionAt(clip.value, offset.value) : { x: 0.5, y: 0.5, scale: 1 },
)

/** Mitte ändern: mit Keyframes im Keyframe am Abspielkopf. */
function editMotion(patch: Partial<GraphicMotion>): void {
  const c = clip.value
  if (c) edit(withGraphicChange(c, offset.value, patch))
}

onBeforeUnmount(commit)
</script>

<template>
  <section v-if="clip && g" class="inspector" data-testid="graphic-inspector" @focusout="commit">
    <h3>{{ t('timeline.graphicInspector', { kind: t(`graphics.kinds.${g.kind}`) }) }}</h3>

    <p v-if="imageMissing" class="warn" role="alert">{{ t('timeline.imageMissing') }}</p>
    <label v-if="g.kind === 'symbol'" class="field">
      <span>{{ t('graphics.symbol') }}</span>
      <select
        :value="g.symbol"
        data-testid="graphic-symbol"
        @change="set({ symbol: value($event) })"
      >
        <option v-for="s in SYMBOL_NAMES" :key="s" :value="s">
          {{ t(`graphics.symbols.${s}`) }}
        </option>
      </select>
    </label>
    <template v-if="g.kind === 'emoji'">
      <label class="field">
        <span>{{ t('graphics.emoji') }}</span>
        <input
          type="text"
          :value="g.emoji"
          :placeholder="t('graphics.customEmoji')"
          data-testid="graphic-emoji"
          @input="onEmoji"
          @change="commit"
        />
      </label>
      <div class="emojis">
        <button
          v-for="e in EMOJI_PRESETS"
          :key="e"
          type="button"
          :aria-pressed="g.emoji === e"
          :aria-label="e"
          @click="set({ emoji: e })"
        >
          {{ e }}
        </button>
      </div>
    </template>

    <div class="row">
      <label class="field">
        <span>
          {{ sizeLabel }} {{ percent(g.w) }} %<template v-if="isImage">
            · {{ t('graphics.height') }} {{ percent(imageHeight(g)) }} %</template
          >
        </span>
        <RangeSpinner
          :scale="100"
          :min="MIN_GRAPHIC_SIZE"
          :max="MAX_GRAPHIC_W"
          step="0.005"
          :value="g.w"
          :reset="defaults.w"
          data-testid="graphic-w"
          @input="edit({ w: number($event) })"
          @change="commit"
        />
      </label>
      <label v-if="hasHeight(g.kind)" class="field">
        <span>{{ t('graphics.height') }} {{ percent(g.h) }} %</span>
        <RangeSpinner
          :scale="100"
          :min="MIN_GRAPHIC_SIZE"
          :max="MAX_GRAPHIC_H"
          step="0.005"
          :value="g.h"
          :reset="defaults.h"
          data-testid="graphic-h"
          @input="edit({ h: number($event) })"
          @change="commit"
        />
      </label>
    </div>
    <label class="field">
      <span>{{ t('graphics.rotation') }} {{ Math.round(g.rotation) }}°</span>
      <RangeSpinner
        min="-180"
        max="180"
        step="1"
        :value="g.rotation"
        :reset="0"
        data-testid="graphic-rotation"
        @input="edit({ rotation: number($event) })"
        @change="commit"
      />
    </label>

    <template v-if="hasColors(g.kind)">
      <div class="row">
        <label class="field color">
          <span>
            {{
              isLine
                ? t('graphics.lineColor')
                : isImage
                  ? t('graphics.image.border')
                  : t('graphics.strokeColor')
            }}
          </span>
          <input
            type="color"
            :value="g.stroke"
            data-testid="graphic-stroke"
            @change="set({ stroke: value($event) })"
          />
        </label>
        <label class="field">
          <span>{{ t('graphics.strokeWidth') }} {{ percent(g.strokeWidth) }} %</span>
          <RangeSpinner
            :scale="100"
            min="0"
            :max="MAX_STROKE"
            step="0.001"
            :value="g.strokeWidth"
            :reset="defaults.strokeWidth"
            data-testid="graphic-stroke-width"
            @input="edit({ strokeWidth: number($event) })"
            @change="commit"
          />
        </label>
      </div>
      <div v-if="hasFill(g.kind)" class="row">
        <label class="field color">
          <span>
            {{ g.kind === 'symbol' ? t('graphics.symbolColor') : t('graphics.fillColor') }}
          </span>
          <input
            type="color"
            :value="g.fill"
            data-testid="graphic-fill"
            @change="set({ fill: value($event) })"
          />
        </label>
        <label class="field">
          <span>{{ t('graphics.fillOpacity') }} {{ Math.round(g.fillOpacity * 100) }} %</span>
          <RangeSpinner
            :scale="100"
            min="0"
            max="1"
            step="0.05"
            :value="g.fillOpacity"
            :reset="defaults.fillOpacity"
            data-testid="graphic-fill-opacity"
            @input="edit({ fillOpacity: number($event) })"
            @change="commit"
          />
        </label>
      </div>
      <label v-if="g.kind === 'rect' || isImage" class="field">
        <span>{{ t('graphics.radius') }} {{ Math.round(g.radius * 100) }} %</span>
        <RangeSpinner
          :scale="100"
          min="0"
          max="0.5"
          step="0.01"
          :value="g.radius"
          :reset="defaults.radius"
          data-testid="graphic-radius"
          @input="edit({ radius: number($event) })"
          @change="commit"
        />
      </label>
    </template>

    <template v-if="isImage">
      <label class="field">
        <span>{{ t('graphics.image.opacity') }} {{ Math.round(g.opacity * 100) }} %</span>
        <RangeSpinner
          :scale="100"
          :min="MIN_IMAGE_OPACITY"
          max="1"
          step="0.01"
          :value="g.opacity"
          :reset="1"
          data-testid="graphic-opacity"
          @input="edit({ opacity: number($event) })"
          @change="commit"
        />
      </label>
      <div class="crop">
        <span>{{ t('graphics.image.crop') }}</span>
        <label v-for="c in CROP_SIDES" :key="c.key" class="crop-row">
          <span>{{ t(`graphics.image.sides.${c.label}`) }}</span>
          <RangeSpinner
            :scale="100"
            min="0"
            :max="MAX_CROP"
            step="0.005"
            :value="g[c.key]"
            :reset="0"
            :data-testid="`graphic-${c.key}`"
            @input="edit({ [c.key]: number($event) })"
            @change="commit"
          />
          <span class="crop-value">{{ percent(g[c.key]) }} %</span>
        </label>
        <button
          v-if="cropped"
          type="button"
          class="plain"
          @click="set({ cropL: 0, cropR: 0, cropT: 0, cropB: 0 })"
        >
          {{ t('graphics.image.cropReset') }}
        </button>
      </div>
      <div class="row">
        <label class="check">
          <input
            type="checkbox"
            :checked="g.flipX"
            data-testid="graphic-flip"
            @change="set({ flipX: checked($event) })"
          />
          <span>{{ t('graphics.image.flip') }}</span>
        </label>
        <label class="check">
          <input
            type="checkbox"
            :checked="g.shadow"
            data-testid="graphic-shadow"
            @change="set({ shadow: checked($event) })"
          />
          <span>{{ t('graphics.image.shadow') }}</span>
        </label>
      </div>
    </template>

    <div class="row">
      <label class="field">
        <span>{{ t('text.animIn') }}</span>
        <select
          :value="anim.in"
          data-testid="graphic-animation"
          @change="setAnim({ in: value($event) as InAnimation })"
        >
          <option v-for="a in GRAPHIC_IN_ANIMATIONS" :key="a" :value="a">
            {{ t(`text.inAnimations.${a}`) }}
          </option>
        </select>
      </label>
      <label class="field">
        <span>{{ t('text.animOut') }}</span>
        <select
          :value="anim.out"
          data-testid="graphic-anim-out"
          @change="setAnim({ out: value($event) as OutAnimation })"
        >
          <option v-for="a in OUT_ANIMATIONS" :key="a" :value="a">
            {{ t(`text.outAnimations.${a}`) }}
          </option>
        </select>
      </label>
      <label class="field">
        <span>{{ t('graphics.loop') }}</span>
        <select :value="g.loop" data-testid="graphic-loop" @change="set({ loop: value($event) })">
          <option v-for="l in GRAPHIC_LOOPS" :key="l" :value="l">
            {{ t(`graphics.loops.${l}`) }}
          </option>
        </select>
      </label>
    </div>
    <div class="row">
      <label class="field">
        <span>{{ t('graphics.animInSpeed') }}</span>
        <select
          :value="anim.inSpeed"
          :disabled="anim.in === 'none'"
          data-testid="graphic-anim-speed"
          @change="setAnim({ inSpeed: number($event) })"
        >
          <option v-for="s in ANIM_SPEEDS" :key="s" :value="s">
            {{ formatAnimSpeed(s, locale) }}
          </option>
        </select>
      </label>
      <label class="field">
        <span>{{ t('text.animOutSpeed') }}</span>
        <select
          :value="anim.outSpeed"
          :disabled="anim.out === 'none'"
          data-testid="graphic-anim-out-speed"
          @change="setAnim({ outSpeed: number($event) })"
        >
          <option v-for="s in ANIM_SPEEDS" :key="s" :value="s">
            {{ formatAnimSpeed(s, locale) }}
          </option>
        </select>
      </label>
      <label class="field">
        <span>{{ t('graphics.loopSpeed') }}</span>
        <select
          :value="loopSpeed"
          :disabled="g.loop === 'none'"
          data-testid="graphic-loop-speed"
          @change="set({ loopSpeed: number($event) })"
        >
          <option v-for="s in ANIM_SPEEDS" :key="s" :value="s">
            {{ formatAnimSpeed(s, locale) }}
          </option>
        </select>
      </label>
    </div>

    <div class="row">
      <label class="field">
        <span>{{ t('text.pos.x') }} {{ percent(motion.x) }} %</span>
        <RangeSpinner
          :scale="100"
          min="0"
          max="1"
          step="0.005"
          :value="motion.x"
          :reset="0.5"
          data-testid="graphic-x"
          @input="editMotion({ x: clamp01(number($event)) })"
          @change="commit"
        />
      </label>
      <label class="field">
        <span>{{ t('text.pos.y') }} {{ percent(motion.y) }} %</span>
        <RangeSpinner
          :scale="100"
          min="0"
          max="1"
          step="0.005"
          :value="motion.y"
          :reset="0.5"
          data-testid="graphic-y"
          @input="editMotion({ y: clamp01(number($event)) })"
          @change="commit"
        />
      </label>
    </div>
    <p class="hint">{{ t('timeline.graphicInspectorHint') }}</p>

    <OverlayKeys :clip="clip" prefix="graphic" :hint="t('timeline.graphicKeys.hint')" />
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
input[type='text'],
select {
  width: 100%;
  padding: var(--ds-space-2);
  border: 1px solid var(--ds-border);
  border-radius: var(--ds-radius-md);
  background: var(--ds-surface-2);
  color: var(--ds-text);
  font: inherit;
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
select:focus-visible,
input:focus-visible,
button:focus-visible {
  outline: none;
  box-shadow: var(--ds-focus-ring);
}
.emojis {
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
}
.emojis button {
  width: var(--ds-control-sm);
  height: var(--ds-control-sm);
  padding: 0;
  border: 1px solid transparent;
  border-radius: var(--ds-radius-md);
  background: none;
  font-size: var(--ds-text-md, var(--ds-text-sm));
  cursor: pointer;
}
.emojis button:hover,
.emojis button[aria-pressed='true'] {
  border-color: var(--ds-accent);
  background: var(--ds-surface-2);
}
.crop {
  display: flex;
  flex-direction: column;
  gap: var(--ds-space-1, 4px);
  color: var(--ds-text-2);
}
.crop-row {
  display: grid;
  grid-template-columns: 4.5em 1fr 3.5em;
  align-items: center;
  gap: var(--ds-space-2);
}
.crop-value {
  font-variant-numeric: tabular-nums;
  text-align: right;
}
.check {
  display: inline-flex;
  align-items: center;
  gap: var(--ds-space-2);
  color: var(--ds-text-2);
  cursor: pointer;
}
.plain {
  align-self: flex-start;
  padding: 0;
  border: 0;
  background: none;
  color: var(--ds-link);
  font: inherit;
  cursor: pointer;
  text-decoration: underline;
}
.warn {
  margin: 0;
  color: var(--ds-danger);
}
.hint {
  margin: 0;
  color: var(--ds-text-2);
  font-size: var(--ds-text-xs, var(--ds-text-sm));
}
</style>
