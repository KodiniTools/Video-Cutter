<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { storeToRefs } from 'pinia'
import { useTextOverlayStore } from '@/stores/textOverlays'
import { formatTimeMs, parseTimeInput } from '@/lib/timeFormat'
import { frameCount, frameSeekTime, snapToFrame, stepFrames } from '@/lib/frameTime'
import FrameSpinner from './FrameSpinner.vue'
import { groupFonts, useCustomFonts } from '@/lib/customFonts'
import {
  FONT_OPTIONS,
  MAX_TEXT_LENGTH,
  MAX_TEXT_OVERLAYS,
  MAX_TEXT_SIZE,
  MIN_TEXT_SIZE,
  POSITION_PRESETS,
  TEXT_ANIMATIONS,
  TEXT_FONTS,
  TEXT_STYLES,
  isValidOverlay,
  type PositionPreset,
  type TextOverlayData,
} from '@/lib/textOverlay'

/**
 * Seitenleisten-Karte „Text": Texte an der aktuellen Stelle hinzufügen, Design
 * und Animation einstellen, einbrennen. Die Vorschau zeigt TextOverlayLayer.
 */
const props = defineProps<{
  duration: number
  currentTime: number
  busy: boolean
  /** Läuft gerade das Einbrennen? (Fortschritt im Button) */
  burning: boolean
  progressLabel: string
  canBurn: boolean
  /** Grafiken (Formen/Emojis), die beim Einbrennen mitkommen. */
  graphicCount?: number
  /** Ist mindestens eine dieser Grafiken ungültig? */
  graphicsInvalid?: boolean
  /** Bildrate des Videos; 0/fehlend = unbekannt (Schritte dann 10 ms). */
  fps?: number
}>()

const emit = defineEmits<{
  (e: 'add'): void
  (e: 'seek', sec: number): void
  /** Video anhalten und auf diese Zeit springen (Spinner/Eingabe von Von/Bis). */
  (e: 'scrub', sec: number): void
  (e: 'burn'): void
}>()

const { t } = useI18n()
const texts = useTextOverlayStore()
const { overlays, selected, selectedId, canAdd } = storeToRefs(texts)

// Eigene Schriften vom Server (einmal pro Sitzung).
const { fonts: customFonts, loadCustomFonts } = useCustomFonts()
const fontGroups = computed(() => groupFonts(customFonts.value))
onMounted(() => void loadCustomFonts())

const allValid = computed(
  () => !props.graphicsInvalid && overlays.value.every((o) => isValidOverlay(o, props.duration)),
)

function patch(p: Partial<TextOverlayData>): void {
  if (selected.value) texts.update(selected.value.id, p)
}

function pick(id: number): void {
  texts.select(id)
  const o = overlays.value.find((x) => x.id === id)
  if (o) emit('seek', frameSeekTime(o.start, fps.value))
}

// --- Frame-genaue Zeiten ----------------------------------------------------
// Von/Bis liegen immer auf Bildanfängen (siehe lib/frameTime): Vorschau und
// Einbrennen zeigen dann dieselben Bilder mit Text (start <= Bild < end).
const fps = computed(() => props.fps ?? 0)

/** Begrenzen auf [0, Dauer] und auf den Anfang des dort sichtbaren Bildes legen. */
function toFrame(sec: number): number {
  return snapToFrame(clampTime(sec), fps.value)
}

function setStart(sec: number, scrub: boolean): void {
  const v = toFrame(sec)
  patch({ start: v })
  if (scrub) emit('scrub', frameSeekTime(v, fps.value))
}

function setEnd(sec: number, scrub: boolean): void {
  const v = toFrame(sec)
  patch({ end: v })
  // Cursor = Bis zeigt das erste Bild OHNE Text (Ende ist exklusiv).
  if (scrub) emit('scrub', frameSeekTime(v, fps.value))
}

function stepStart(dir: 1 | -1): void {
  if (selected.value)
    setStart(stepFrames(selected.value.start, dir, fps.value, props.duration), true)
}

function stepEnd(dir: 1 | -1): void {
  if (selected.value) setEnd(stepFrames(selected.value.end, dir, fps.value, props.duration), true)
}

const stepUnit = computed(() => (fps.value > 0 ? t('text.frame.one') : t('text.frame.ms')))

/** „3,000 s · 75 Bilder" – Dauer des gewählten Textes. */
const durationLabel = computed(() => {
  const o = selected.value
  if (!o) return ''
  const sec = Math.max(0, o.end - o.start)
  const base = formatTimeMs(sec)
  return fps.value > 0
    ? `${base} · ${t('text.frame.count', { n: frameCount(o.start, o.end, fps.value) })}`
    : base
})

// Zeitfelder: Freitext (mm:ss.mmm) – übernommen bei Enter/Verlassen.
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

function commitFrom(): void {
  const v = parseTimeInput(fromInput.value)
  if (v === null || !selected.value) {
    fromInput.value = selected.value ? formatTimeMs(selected.value.start) : ''
    return
  }
  setStart(v, true)
  // Gleicher Wert nach dem Einrasten -> Watch feuert nicht, Feld trotzdem normalisieren.
  fromInput.value = formatTimeMs(selected.value.start)
}

function commitTo(): void {
  const v = parseTimeInput(toInput.value)
  if (v === null || !selected.value) {
    toInput.value = selected.value ? formatTimeMs(selected.value.end) : ''
    return
  }
  setEnd(v, true)
  toInput.value = formatTimeMs(selected.value.end)
}

function placeAt(preset: PositionPreset): void {
  patch({ x: 0.5, y: POSITION_PRESETS[preset] })
}

const activePreset = computed<PositionPreset | null>(() => {
  const o = selected.value
  if (!o || Math.abs(o.x - 0.5) > 0.001) return null
  const hit = (Object.keys(POSITION_PRESETS) as PositionPreset[]).find(
    (k) => Math.abs(POSITION_PRESETS[k] - o.y) < 0.001,
  )
  return hit ?? null
})

// --- Exakte Position (X/Y in % des Bildes, Mittelpunkt des Textes) ----------
const AXES = ['x', 'y'] as const
type Axis = (typeof AXES)[number]

/** Prozent mit einer Nachkommastelle (Anzeige/Eingabe). */
function percent(axis: Axis): number {
  return selected.value ? Math.round(selected.value[axis] * 1000) / 10 : 0
}

function setPercent(axis: Axis, value: number): void {
  if (!Number.isFinite(value)) return
  const v = Math.min(100, Math.max(0, value)) / 100
  patch(axis === 'x' ? { x: v } : { y: v })
}

/** Zahlenfeld: übernehmen bei Enter/Verlassen; Unsinn -> alter Wert. */
function commitPercent(axis: Axis, ev: Event): void {
  const el = ev.target as HTMLInputElement
  const v = Number(el.value.replace(',', '.'))
  if (el.value.trim() === '' || !Number.isFinite(v)) {
    el.value = String(percent(axis))
    return
  }
  setPercent(axis, v)
  el.value = String(percent(axis))
}

function nudge(axis: Axis, delta: number): void {
  setPercent(axis, percent(axis) + delta)
}

const sizePercent = computed(() =>
  selected.value ? Math.round(selected.value.size * 1000) / 10 : 0,
)

function preview(text: string): string {
  const line = text.split('\n')[0] ?? ''
  return line.length > 28 ? `${line.slice(0, 27)}…` : line
}
</script>

<template>
  <section class="card text-panel">
    <div class="card-head">
      <h3 class="panel-title">{{ t('text.title') }}</h3>
      <span v-if="overlays.length" class="count">{{ overlays.length }}</span>
    </div>

    <button
      class="btn block add"
      type="button"
      :disabled="!canAdd || busy"
      :title="t('text.addHint')"
      @click="emit('add')"
    >
      {{ t('text.add') }}
    </button>
    <p v-if="!canAdd && overlays.length >= MAX_TEXT_OVERLAYS" class="hint warn">
      {{ t('text.limit', { max: MAX_TEXT_OVERLAYS }) }}
    </p>

    <ul v-if="overlays.length" class="text-list">
      <li
        v-for="(o, i) in overlays"
        :key="o.id"
        class="text-row"
        :class="{ active: o.id === selectedId, invalid: !isValidOverlay(o, duration) }"
      >
        <button class="text-pick" type="button" @click="pick(o.id)">
          <span class="text-index">{{ i + 1 }}</span>
          <span class="text-label">
            <b>{{ preview(o.text) || '—' }}</b>
            <small>{{ formatTimeMs(o.start) }} – {{ formatTimeMs(o.end) }}</small>
          </span>
        </button>
        <button
          class="btn tiny remove"
          type="button"
          :disabled="busy"
          :aria-label="t('text.remove')"
          :title="t('text.remove')"
          @click="texts.remove(o.id)"
        >
          ✕
        </button>
      </li>
    </ul>
    <p v-else class="hint">{{ t('text.empty') }}</p>

    <!-- Bearbeiten des gewählten Textes -->
    <div v-if="selected" class="editor-fields">
      <label class="field-col">
        <span class="field-label">{{ t('text.content') }}</span>
        <textarea
          class="input text-area"
          rows="2"
          :maxlength="MAX_TEXT_LENGTH"
          :value="selected.text"
          :disabled="busy"
          @input="patch({ text: ($event.target as HTMLTextAreaElement).value })"
        ></textarea>
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
              @change="commitFrom"
              @keydown.enter.prevent="commitFrom"
            />
            <FrameSpinner
              :disabled="busy"
              :up-label="`${t('text.from')}: +1 ${stepUnit}`"
              :down-label="`${t('text.from')}: −1 ${stepUnit}`"
              @step="stepStart"
            />
            <button
              class="btn tiny"
              type="button"
              :disabled="busy"
              :title="t('text.toPlayhead')"
              :aria-label="`${t('text.from')}: ${t('text.toPlayhead')}`"
              @click="setStart(currentTime, false)"
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
              @change="commitTo"
              @keydown.enter.prevent="commitTo"
            />
            <FrameSpinner
              :disabled="busy"
              :up-label="`${t('text.to')}: +1 ${stepUnit}`"
              :down-label="`${t('text.to')}: −1 ${stepUnit}`"
              @step="stepEnd"
            />
            <button
              class="btn tiny"
              type="button"
              :disabled="busy"
              :title="t('text.toPlayhead')"
              :aria-label="`${t('text.to')}: ${t('text.toPlayhead')}`"
              @click="setEnd(currentTime, false)"
            >
              ⏱
            </button>
          </span>
        </label>
      </div>
      <p class="field-row duration-row">
        <span class="field-label">{{ t('text.frame.duration') }}</span>
        <span class="field-value">{{ durationLabel }}</span>
      </p>
      <p class="hint">
        {{
          fps > 0
            ? t('text.frame.hint', { fps: fps.toFixed(fps % 1 ? 2 : 0) })
            : t('text.frame.hintMs')
        }}
      </p>
      <p v-if="!isValidOverlay(selected, duration)" class="hint warn">{{ t('text.invalid') }}</p>

      <div class="field-col">
        <span class="field-label">{{ t('text.position') }}</span>
        <div class="seg-buttons" role="group" :aria-label="t('text.position')">
          <button
            v-for="p in ['top', 'center', 'bottom'] as const"
            :key="p"
            class="btn tiny"
            :class="{ on: activePreset === p }"
            type="button"
            :disabled="busy"
            :aria-pressed="activePreset === p"
            @click="placeAt(p)"
          >
            {{ t(`text.positions.${p}`) }}
          </button>
        </div>
        <div v-for="axis in AXES" :key="axis" class="pos-row">
          <span class="pos-axis">{{ axis.toUpperCase() }}</span>
          <input
            class="range"
            type="range"
            min="0"
            max="100"
            step="0.1"
            :value="percent(axis)"
            :disabled="busy"
            :aria-label="t(`text.pos.${axis}`)"
            @input="setPercent(axis, Number(($event.target as HTMLInputElement).value))"
          />
          <button
            class="btn tiny step"
            type="button"
            :disabled="busy"
            :title="t('text.pos.minus')"
            :aria-label="`${t(`text.pos.${axis}`)} ${t('text.pos.minus')}`"
            @click="nudge(axis, -0.5)"
          >
            −
          </button>
          <input
            class="input pos-num"
            type="number"
            min="0"
            max="100"
            step="0.1"
            :value="percent(axis)"
            :disabled="busy"
            :aria-label="`${t(`text.pos.${axis}`)} (%)`"
            @change="commitPercent(axis, $event)"
            @keydown.enter.prevent="commitPercent(axis, $event)"
          />
          <button
            class="btn tiny step"
            type="button"
            :disabled="busy"
            :title="t('text.pos.plus')"
            :aria-label="`${t(`text.pos.${axis}`)} ${t('text.pos.plus')}`"
            @click="nudge(axis, 0.5)"
          >
            +
          </button>
        </div>
        <p class="hint">{{ t('text.dragHint') }}</p>
      </div>

      <label class="field-col">
        <span class="field-label">{{ t('text.font') }}</span>
        <select
          class="input"
          :value="selected.font"
          :disabled="busy"
          @change="
            patch({ font: ($event.target as HTMLSelectElement).value as typeof selected.font })
          "
        >
          <optgroup :label="t('text.fontsBuiltin')">
            <option v-for="f in TEXT_FONTS" :key="f" :value="f">{{ FONT_OPTIONS[f].label }}</option>
          </optgroup>
          <optgroup v-for="g in fontGroups" :key="g.group" :label="g.group">
            <option v-for="f in g.fonts" :key="f.key" :value="f.key">
              {{ g.group }} {{ f.label }}
            </option>
          </optgroup>
        </select>
      </label>

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
          <option v-for="a in TEXT_ANIMATIONS" :key="a" :value="a">
            {{ t(`text.animations.${a}`) }}
          </option>
        </select>
      </label>

      <div class="field-col">
        <div class="field-row">
          <span class="field-label">{{ t('text.size') }}</span>
          <span class="field-value">{{ sizePercent }} %</span>
        </div>
        <input
          class="range"
          type="range"
          :min="MIN_TEXT_SIZE * 1000"
          :max="MAX_TEXT_SIZE * 1000"
          step="5"
          :value="Math.round(selected.size * 1000)"
          :disabled="busy"
          :aria-label="t('text.size')"
          @input="patch({ size: Number(($event.target as HTMLInputElement).value) / 1000 })"
        />
      </div>

      <div class="field-col">
        <span class="field-label">{{ t('text.style') }}</span>
        <div class="seg-buttons" role="group" :aria-label="t('text.style')">
          <button
            v-for="s in TEXT_STYLES"
            :key="s"
            class="btn tiny"
            :class="{ on: selected.style === s }"
            type="button"
            :disabled="busy"
            :aria-pressed="selected.style === s"
            @click="patch({ style: s })"
          >
            {{ t(`text.styles.${s}`) }}
          </button>
        </div>
      </div>

      <div class="grid-2">
        <label class="color-field">
          <input
            type="color"
            :value="selected.color"
            :disabled="busy"
            @input="patch({ color: ($event.target as HTMLInputElement).value })"
          />
          <span class="field-label">{{ t('text.color') }}</span>
        </label>
        <label class="color-field" :class="{ off: selected.style === 'none' }">
          <input
            type="color"
            :value="selected.accent"
            :disabled="busy || selected.style === 'none'"
            @input="patch({ accent: ($event.target as HTMLInputElement).value })"
          />
          <span class="field-label">{{ t('text.accent') }}</span>
        </label>
      </div>
    </div>

    <button
      v-if="overlays.length"
      class="btn primary block burn"
      type="button"
      :disabled="!canBurn || !allValid || busy"
      :title="t('text.burnHint')"
      @click="emit('burn')"
    >
      <template v-if="burning">{{ progressLabel }}</template>
      <template v-else-if="graphicCount">{{
        t('graphics.burnCount', { n: overlays.length + graphicCount })
      }}</template>
      <template v-else>{{ t('text.burnCount', { n: overlays.length }) }}</template>
    </button>
    <p v-if="overlays.length" class="hint">{{ t('text.burnHint') }}</p>
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
/* Von/Bis untereinander: Zeitfeld + ▲▼ + ⏱ brauchen die volle Breite. */
.time-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 8px;
}
.grid-2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.time-row {
  display: flex;
  align-items: center;
  gap: 4px;
}
.duration-row {
  margin: 0;
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
</style>
