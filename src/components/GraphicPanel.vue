<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { storeToRefs } from 'pinia'
import { useGraphicOverlayStore } from '@/stores/graphicOverlays'
import { formatTimeMs, parseTimeInput } from '@/lib/timeFormat'
import {
  EMOJI_PRESETS,
  GRAPHIC_ANIMATIONS,
  GRAPHIC_SYMBOLS,
  MAX_EMOJI_LENGTH,
  MAX_GRAPHICS,
  MAX_GRAPHIC_H,
  MAX_GRAPHIC_W,
  MAX_STROKE,
  MIN_GRAPHIC_SIZE,
  SYMBOL_NAMES,
  hasColors,
  hasFill,
  hasHeight,
  isValidGraphic,
  type GraphicData,
  type GraphicKind,
  type GraphicOverlay,
  type GraphicSymbol,
} from '@/lib/graphicOverlay'

/**
 * Seitenleisten-Karte „Formen & Emojis": Formen, Linien/Pfeile, Symbole und
 * Emojis an der aktuellen Stelle hinzufügen, gestalten und (zusammen mit den
 * Texten) einbrennen. Die Vorschau zeigt GraphicOverlayLayer.
 */
const props = defineProps<{
  duration: number
  currentTime: number
  busy: boolean
  burning: boolean
  progressLabel: string
  canBurn: boolean
  /** Anzahl der Texte, die beim Einbrennen mitkommen. */
  textCount: number
  /** Sind auch alle Texte gültig? */
  textsValid: boolean
}>()

const emit = defineEmits<{
  (e: 'add', kind: GraphicKind, extra: Partial<Pick<GraphicData, 'symbol' | 'emoji'>>): void
  (e: 'seek', sec: number): void
  (e: 'burn'): void
}>()

const { t } = useI18n()
const graphics = useGraphicOverlayStore()
const { overlays, selected, selectedId, canAdd } = storeToRefs(graphics)

const SHAPES: { kind: GraphicKind; icon: string }[] = [
  { kind: 'rect', icon: '▭' },
  { kind: 'ellipse', icon: '◯' },
  { kind: 'bubble', icon: '🗨' },
  { kind: 'line', icon: '╱' },
  { kind: 'arrow', icon: '➝' },
]

const allValid = computed(
  () => props.textsValid && overlays.value.every((o) => isValidGraphic(o, props.duration)),
)
const total = computed(() => overlays.value.length + props.textCount)

function patch(p: Partial<GraphicData>): void {
  if (selected.value) graphics.update(selected.value.id, p)
}

function pick(id: number): void {
  graphics.select(id)
  const o = overlays.value.find((x) => x.id === id)
  if (o) emit('seek', o.start)
}

// Eigenes Emoji (beliebiges Zeichen inkl. Kombinationen wie 👍🏽).
const customEmoji = ref('')
function addCustomEmoji(): void {
  const e = customEmoji.value.trim()
  if (!e) return
  emit('add', 'emoji', { emoji: e })
  customEmoji.value = ''
}

// Zeitfelder wie bei Texten: Freitext (mm:ss.mmm), übernommen bei Enter/Verlassen.
const fromInput = ref('')
const toInput = ref('')
watch(
  () => [selected.value?.start, selected.value?.end] as const,
  ([s, e]) => {
    fromInput.value = s !== undefined ? formatTimeMs(s) : ''
    toInput.value = e !== undefined ? formatTimeMs(e) : ''
  },
  { immediate: true },
)

function clampTime(sec: number): number {
  return Math.max(0, props.duration > 0 ? Math.min(props.duration, sec) : sec)
}

function commitTime(which: 'start' | 'end'): void {
  const input = which === 'start' ? fromInput : toInput
  const v = parseTimeInput(input.value)
  if (v === null || !selected.value) {
    input.value = selected.value ? formatTimeMs(selected.value[which]) : ''
    return
  }
  patch(which === 'start' ? { start: clampTime(v) } : { end: clampTime(v) })
}

// --- Zahlen-Regler (Anzeige in %, Grad) --------------------------------------
const AXES = ['x', 'y'] as const
type Axis = (typeof AXES)[number]

function pct(v: number): number {
  return Math.round(v * 1000) / 10
}

function setPercent(key: Axis | 'w' | 'h', value: number): void {
  if (!Number.isFinite(value)) return
  patch({ [key]: value / 100 } as Partial<GraphicData>)
}

function commitPercent(axis: Axis, ev: Event): void {
  const el = ev.target as HTMLInputElement
  const v = Number(el.value.replace(',', '.'))
  if (el.value.trim() !== '' && Number.isFinite(v)) setPercent(axis, Math.min(100, Math.max(0, v)))
  el.value = String(selected.value ? pct(selected.value[axis]) : 0)
}

function commitRotation(ev: Event): void {
  const el = ev.target as HTMLInputElement
  const v = Number(el.value.replace(',', '.'))
  if (el.value.trim() !== '' && Number.isFinite(v)) patch({ rotation: v })
  el.value = String(selected.value?.rotation ?? 0)
}

const ROTATIONS = [0, 45, 90, 135, 180, -135, -90, -45] as const

function sizeLabel(o: GraphicOverlay): string {
  if (o.kind === 'line' || o.kind === 'arrow') return t('graphics.length')
  if (hasHeight(o.kind)) return t('graphics.width')
  return t('graphics.size')
}

function rowLabel(o: GraphicOverlay): string {
  if (o.kind === 'emoji') return o.emoji || '—'
  if (o.kind === 'symbol') return t(`graphics.symbols.${o.symbol}`)
  return t(`graphics.kinds.${o.kind}`)
}

function symbolPath(s: GraphicSymbol): string {
  return GRAPHIC_SYMBOLS[s].path
}
</script>

<template>
  <section class="card text-panel">
    <div class="card-head">
      <h3 class="panel-title">{{ t('graphics.title') }}</h3>
      <span v-if="overlays.length" class="count">{{ overlays.length }}</span>
    </div>
    <p class="hint">{{ t('graphics.addHint') }}</p>

    <!-- Hinzufügen -->
    <div class="field-col">
      <span class="field-label">{{ t('graphics.shapes') }}</span>
      <div class="pick-grid">
        <button
          v-for="s in SHAPES"
          :key="s.kind"
          class="btn tiny pick"
          type="button"
          :disabled="!canAdd || busy"
          :title="t(`graphics.kinds.${s.kind}`)"
          :aria-label="t(`graphics.kinds.${s.kind}`)"
          @click="emit('add', s.kind, {})"
        >
          <span aria-hidden="true">{{ s.icon }}</span>
        </button>
      </div>
    </div>
    <div class="field-col">
      <span class="field-label">{{ t('graphics.symbolsTitle') }}</span>
      <div class="pick-grid">
        <button
          v-for="s in SYMBOL_NAMES"
          :key="s"
          class="btn tiny pick"
          type="button"
          :disabled="!canAdd || busy"
          :title="t(`graphics.symbols.${s}`)"
          :aria-label="t(`graphics.symbols.${s}`)"
          @click="emit('add', 'symbol', { symbol: s })"
        >
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path
              :d="symbolPath(s)"
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
    <div class="field-col">
      <span class="field-label">{{ t('graphics.emojis') }}</span>
      <div class="pick-grid emoji-grid">
        <button
          v-for="e in EMOJI_PRESETS"
          :key="e"
          class="btn tiny pick emoji"
          type="button"
          :disabled="!canAdd || busy"
          :aria-label="e"
          @click="emit('add', 'emoji', { emoji: e })"
        >
          {{ e }}
        </button>
      </div>
      <div class="time-row">
        <input
          v-model="customEmoji"
          class="input"
          type="text"
          :maxlength="MAX_EMOJI_LENGTH"
          :placeholder="t('graphics.customEmoji')"
          :aria-label="t('graphics.customEmoji')"
          :disabled="!canAdd || busy"
          @keydown.enter.prevent="addCustomEmoji"
        />
        <button
          class="btn tiny"
          type="button"
          :disabled="!canAdd || busy || !customEmoji.trim()"
          @click="addCustomEmoji"
        >
          +
        </button>
      </div>
    </div>
    <p v-if="!canAdd && overlays.length >= MAX_GRAPHICS" class="hint warn">
      {{ t('graphics.limit', { max: MAX_GRAPHICS }) }}
    </p>

    <ul v-if="overlays.length" class="text-list">
      <li
        v-for="(o, i) in overlays"
        :key="o.id"
        class="text-row"
        :class="{ active: o.id === selectedId, invalid: !isValidGraphic(o, duration) }"
      >
        <button class="text-pick" type="button" @click="pick(o.id)">
          <span class="text-index">{{ i + 1 }}</span>
          <span class="text-label">
            <b>{{ rowLabel(o) }}</b>
            <small>{{ formatTimeMs(o.start) }} – {{ formatTimeMs(o.end) }}</small>
          </span>
        </button>
        <button
          class="btn tiny"
          type="button"
          :disabled="busy || !canAdd"
          :aria-label="t('graphics.duplicate')"
          :title="t('graphics.duplicate')"
          @click="graphics.duplicate(o.id)"
        >
          ⧉
        </button>
        <button
          class="btn tiny remove"
          type="button"
          :disabled="busy"
          :aria-label="t('graphics.remove')"
          :title="t('graphics.remove')"
          @click="graphics.remove(o.id)"
        >
          ✕
        </button>
      </li>
    </ul>

    <!-- Bearbeiten der gewählten Grafik -->
    <div v-if="selected" class="editor-fields">
      <div v-if="selected.kind === 'symbol'" class="field-col">
        <span class="field-label">{{ t('graphics.symbol') }}</span>
        <div class="pick-grid">
          <button
            v-for="s in SYMBOL_NAMES"
            :key="s"
            class="btn tiny pick"
            :class="{ on: selected.symbol === s }"
            type="button"
            :disabled="busy"
            :aria-pressed="selected.symbol === s"
            :title="t(`graphics.symbols.${s}`)"
            :aria-label="t(`graphics.symbols.${s}`)"
            @click="patch({ symbol: s })"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <path
                :d="symbolPath(s)"
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
      <label v-if="selected.kind === 'emoji'" class="field-col">
        <span class="field-label">{{ t('graphics.emoji') }}</span>
        <input
          class="input emoji-input"
          type="text"
          :maxlength="MAX_EMOJI_LENGTH"
          :value="selected.emoji"
          :disabled="busy"
          @input="patch({ emoji: ($event.target as HTMLInputElement).value })"
        />
      </label>

      <div class="time-grid">
        <label class="field-col">
          <span class="field-label">{{ t('text.from') }}</span>
          <span class="time-row">
            <input
              v-model="fromInput"
              class="input time"
              type="text"
              inputmode="decimal"
              :disabled="busy"
              @change="commitTime('start')"
              @keydown.enter.prevent="commitTime('start')"
            />
            <button
              class="btn tiny"
              type="button"
              :disabled="busy"
              :title="t('text.toPlayhead')"
              :aria-label="`${t('text.from')}: ${t('text.toPlayhead')}`"
              @click="patch({ start: clampTime(currentTime) })"
            >
              ⏱
            </button>
          </span>
        </label>
        <label class="field-col">
          <span class="field-label">{{ t('text.to') }}</span>
          <span class="time-row">
            <input
              v-model="toInput"
              class="input time"
              type="text"
              inputmode="decimal"
              :disabled="busy"
              @change="commitTime('end')"
              @keydown.enter.prevent="commitTime('end')"
            />
            <button
              class="btn tiny"
              type="button"
              :disabled="busy"
              :title="t('text.toPlayhead')"
              :aria-label="`${t('text.to')}: ${t('text.toPlayhead')}`"
              @click="patch({ end: clampTime(currentTime) })"
            >
              ⏱
            </button>
          </span>
        </label>
      </div>
      <p v-if="!isValidGraphic(selected, duration)" class="hint warn">
        {{ t('graphics.invalid') }}
      </p>

      <div class="field-col">
        <span class="field-label">{{ t('text.position') }}</span>
        <div v-for="axis in AXES" :key="axis" class="pos-row">
          <span class="pos-axis">{{ axis.toUpperCase() }}</span>
          <input
            class="range"
            type="range"
            min="0"
            max="100"
            step="0.1"
            :value="pct(selected[axis])"
            :disabled="busy"
            :aria-label="t(`text.pos.${axis}`)"
            @input="setPercent(axis, Number(($event.target as HTMLInputElement).value))"
          />
          <input
            class="input pos-num"
            type="number"
            min="0"
            max="100"
            step="0.1"
            :value="pct(selected[axis])"
            :disabled="busy"
            :aria-label="`${t(`text.pos.${axis}`)} (%)`"
            @change="commitPercent(axis, $event)"
            @keydown.enter.prevent="commitPercent(axis, $event)"
          />
        </div>
        <p class="hint">{{ t('graphics.dragHint') }}</p>
      </div>

      <div class="field-col">
        <div class="field-row">
          <span class="field-label">{{ sizeLabel(selected) }}</span>
          <span class="field-value">{{ pct(selected.w) }} %</span>
        </div>
        <input
          class="range"
          type="range"
          :min="MIN_GRAPHIC_SIZE * 1000"
          :max="MAX_GRAPHIC_W * 1000"
          step="5"
          :value="Math.round(selected.w * 1000)"
          :disabled="busy"
          :aria-label="sizeLabel(selected)"
          @input="setPercent('w', Number(($event.target as HTMLInputElement).value) / 10)"
        />
      </div>
      <div v-if="hasHeight(selected.kind)" class="field-col">
        <div class="field-row">
          <span class="field-label">{{ t('graphics.height') }}</span>
          <span class="field-value">{{ pct(selected.h) }} %</span>
        </div>
        <input
          class="range"
          type="range"
          :min="MIN_GRAPHIC_SIZE * 1000"
          :max="MAX_GRAPHIC_H * 1000"
          step="5"
          :value="Math.round(selected.h * 1000)"
          :disabled="busy"
          :aria-label="t('graphics.height')"
          @input="setPercent('h', Number(($event.target as HTMLInputElement).value) / 10)"
        />
      </div>
      <p class="hint">{{ t('graphics.sizeHint') }}</p>

      <div class="field-col">
        <div class="pos-row">
          <span class="field-label grow">{{ t('graphics.rotation') }}</span>
          <input
            class="input pos-num"
            type="number"
            min="-180"
            max="180"
            step="1"
            :value="selected.rotation"
            :disabled="busy"
            :aria-label="`${t('graphics.rotation')} (°)`"
            @change="commitRotation"
            @keydown.enter.prevent="commitRotation"
          />
          <span class="field-label">°</span>
        </div>
        <input
          class="range"
          type="range"
          min="-180"
          max="180"
          step="1"
          :value="selected.rotation"
          :disabled="busy"
          :aria-label="t('graphics.rotation')"
          @input="patch({ rotation: Number(($event.target as HTMLInputElement).value) })"
        />
        <div class="seg-buttons" role="group" :aria-label="t('graphics.rotation')">
          <button
            v-for="r in ROTATIONS"
            :key="r"
            class="btn tiny"
            :class="{ on: selected.rotation === r }"
            type="button"
            :disabled="busy"
            :aria-pressed="selected.rotation === r"
            @click="patch({ rotation: r })"
          >
            {{ r }}°
          </button>
        </div>
      </div>

      <template v-if="hasColors(selected.kind)">
        <div class="field-col">
          <label class="color-field">
            <input
              type="color"
              :value="selected.stroke"
              :disabled="busy"
              @input="patch({ stroke: ($event.target as HTMLInputElement).value })"
            />
            <span class="field-label grow">{{
              selected.kind === 'line' || selected.kind === 'arrow'
                ? t('graphics.lineColor')
                : t('graphics.strokeColor')
            }}</span>
            <span class="field-value">{{ pct(selected.strokeWidth) }} %</span>
          </label>
          <input
            class="range"
            type="range"
            min="0"
            :max="MAX_STROKE * 1000"
            step="1"
            :value="Math.round(selected.strokeWidth * 1000)"
            :disabled="busy"
            :aria-label="t('graphics.strokeWidth')"
            @input="
              patch({ strokeWidth: Number(($event.target as HTMLInputElement).value) / 1000 })
            "
          />
        </div>
        <div v-if="hasFill(selected.kind)" class="field-col">
          <label class="color-field">
            <input
              type="color"
              :value="selected.fill"
              :disabled="busy"
              @input="patch({ fill: ($event.target as HTMLInputElement).value })"
            />
            <span class="field-label grow">{{
              selected.kind === 'symbol' ? t('graphics.symbolColor') : t('graphics.fillColor')
            }}</span>
            <span class="field-value">{{ Math.round(selected.fillOpacity * 100) }} %</span>
          </label>
          <input
            class="range"
            type="range"
            min="0"
            max="100"
            step="5"
            :value="Math.round(selected.fillOpacity * 100)"
            :disabled="busy"
            :aria-label="t('graphics.fillOpacity')"
            @input="patch({ fillOpacity: Number(($event.target as HTMLInputElement).value) / 100 })"
          />
        </div>
        <div v-if="selected.kind === 'rect'" class="field-col">
          <div class="field-row">
            <span class="field-label">{{ t('graphics.radius') }}</span>
            <span class="field-value">{{ Math.round(selected.radius * 200) }} %</span>
          </div>
          <input
            class="range"
            type="range"
            min="0"
            max="50"
            step="1"
            :value="Math.round(selected.radius * 100)"
            :disabled="busy"
            :aria-label="t('graphics.radius')"
            @input="patch({ radius: Number(($event.target as HTMLInputElement).value) / 100 })"
          />
        </div>
      </template>

      <label class="field-col">
        <span class="field-label">{{ t('text.animation') }}</span>
        <select
          class="input"
          :value="selected.animation"
          :disabled="busy"
          @change="
            patch({
              animation: ($event.target as HTMLSelectElement).value as typeof selected.animation,
            })
          "
        >
          <option v-for="a in GRAPHIC_ANIMATIONS" :key="a" :value="a">
            {{ t(`text.animations.${a}`) }}
          </option>
        </select>
      </label>
    </div>

    <button
      v-if="overlays.length"
      class="btn primary block burn"
      type="button"
      :disabled="!canBurn || !allValid || busy"
      :title="t('graphics.burnHint')"
      @click="emit('burn')"
    >
      <template v-if="burning">{{ progressLabel }}</template>
      <template v-else>{{ t('graphics.burnCount', { n: total }) }}</template>
    </button>
    <p v-if="overlays.length" class="hint">{{ t('graphics.burnHint') }}</p>
  </section>
</template>

<style scoped>
.card {
  border: 1px solid var(--ds-border);
  border-radius: var(--ds-radius-md);
  padding: 12px;
  background: var(--ds-surface-1);
}
.text-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.card-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.panel-title {
  margin: 0;
  font-size: var(--ds-text-sm);
  color: var(--ds-text-2);
}
.count {
  display: inline-grid;
  place-items: center;
  min-width: 20px;
  height: 20px;
  padding: 0 6px;
  border-radius: var(--ds-radius-full);
  background: var(--ds-accent);
  color: var(--ds-on-accent);
  font-size: var(--ds-text-xs);
  font-weight: var(--ds-weight-semibold);
}
.hint {
  margin: 0;
  font-size: var(--ds-text-xs);
  color: var(--ds-text-2);
}
.hint.warn {
  color: var(--ds-danger);
}

.btn {
  appearance: none;
  border: 1px solid var(--ds-border-strong);
  background: var(--ds-surface-2);
  color: var(--ds-text);
  padding: 9px 14px;
  border-radius: var(--ds-radius-md);
  font-size: var(--ds-text-md);
  cursor: pointer;
}
.btn:hover {
  border-color: var(--ds-accent);
}
.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.btn:focus-visible {
  outline: none;
  box-shadow: var(--ds-focus-ring);
}
.btn.tiny {
  padding: 4px 8px;
  font-size: var(--ds-text-sm);
}
.btn.tiny.on {
  border-color: var(--ds-accent);
  background: var(--ds-accent-soft);
  font-weight: var(--ds-weight-semibold);
}
.btn.block {
  width: 100%;
  text-align: center;
  border-color: var(--ds-accent);
  font-weight: var(--ds-weight-semibold);
}
.btn.block:hover:not(:disabled) {
  background: var(--ds-accent-soft);
}
.btn.primary {
  background: var(--ds-accent);
  color: var(--ds-on-accent);
}
.btn.primary:hover:not(:disabled) {
  background: var(--ds-accent-hover);
  border-color: var(--ds-accent-hover);
}

.text-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  /* Viele (KI-)Untertitel: Liste scrollt statt die Seitenleiste zu sprengen. */
  max-height: 320px;
  overflow-y: auto;
}
.text-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px 4px 4px;
  border: 1px solid var(--ds-border);
  border-radius: var(--ds-radius-md);
  background: var(--ds-surface-2);
}
.text-row.active {
  border-color: var(--ds-accent);
}
.text-row.invalid {
  border-color: var(--ds-danger);
}
.text-pick {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px;
  border: 0;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
.text-pick:focus-visible {
  outline: none;
  box-shadow: var(--ds-focus-ring);
  border-radius: var(--ds-radius-sm);
}
.text-index {
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  flex: none;
  border-radius: 50%;
  background: var(--ds-accent);
  color: var(--ds-on-accent);
  font-size: var(--ds-text-xs);
  font-weight: var(--ds-weight-semibold);
}
.text-label {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.text-label b {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--ds-text-sm);
}
.text-label small {
  color: var(--ds-text-2);
  font-size: var(--ds-text-xs);
  font-variant-numeric: tabular-nums;
}

.editor-fields {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-top: 10px;
  border-top: 1px dashed var(--ds-border);
}
.field-col {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.field-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.field-label {
  font-size: var(--ds-text-sm);
  color: var(--ds-text-2);
}
.field-value {
  font-size: var(--ds-text-sm);
  font-weight: var(--ds-weight-semibold);
  font-variant-numeric: tabular-nums;
}
.input {
  width: 100%;
  min-width: 0;
  padding: 6px 8px;
  border: 1px solid var(--ds-border-strong);
  border-radius: var(--ds-radius-sm);
  background: var(--ds-surface-0);
  color: var(--ds-text);
  font: inherit;
  font-size: var(--ds-text-sm);
}
.input:focus-visible {
  outline: none;
  border-color: var(--ds-accent);
  box-shadow: var(--ds-focus-ring);
}
.text-area {
  resize: vertical;
}
.time-grid,
.grid-2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.time-row {
  display: flex;
  gap: 4px;
}
.input.time {
  font-variant-numeric: tabular-nums;
}
.seg-buttons {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.pos-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.pos-axis {
  width: 14px;
  flex: none;
  font-size: var(--ds-text-sm);
  font-weight: var(--ds-weight-semibold);
  color: var(--ds-text-2);
}
.pos-row .range {
  flex: 1;
  min-width: 0;
}
.input.pos-num {
  width: 64px;
  flex: none;
  padding: 4px 6px;
  font-variant-numeric: tabular-nums;
}
.btn.tiny.step {
  flex: none;
  padding: 2px 7px;
}
.range {
  width: 100%;
  accent-color: var(--ds-accent);
}
.color-field {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
}
.color-field.off {
  opacity: 0.5;
}
.color-field input {
  width: 32px;
  height: 28px;
  padding: 0;
  border: 1px solid var(--ds-border-strong);
  border-radius: var(--ds-radius-sm);
  background: transparent;
  cursor: pointer;
}
.pick-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.btn.tiny.pick {
  display: inline-grid;
  place-items: center;
  min-width: 34px;
  height: 32px;
  padding: 2px 6px;
  font-size: var(--ds-text-lg);
  line-height: 1;
}
.btn.tiny.pick.emoji {
  font-family: 'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', sans-serif;
}
.emoji-input {
  font-size: var(--ds-text-lg);
}
.grow {
  flex: 1;
}
</style>
