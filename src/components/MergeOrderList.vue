<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { storeToRefs } from 'pinia'
import {
  useVideoEditorStore,
  mergeItemKey,
  seamKey,
  type MergeItem,
  type SeamPreset,
} from '@/stores/videoEditor'
import { ANIMATIONS, useAnimationPref } from '@/composables/useAnimationPref'
import { formatTimeMs } from '@/lib/timeFormat'
import AppendClipRow from './AppendClipRow.vue'

/**
 * Gesamtreihenfolge beim Zusammenfügen: Teile des Hauptvideos (fest, in
 * Zeitreihenfolge) und angehängte Videos (per Drag & Drop oder ▲▼ frei
 * davor, dazwischen oder dahinter platzierbar).
 */
defineProps<{
  disabled: boolean
}>()

const { t } = useI18n()
const store = useVideoEditorStore()
const { mergeItems, mainParts, operation, seamTransitions } = storeToRefs(store)
const { animation } = useAnimationPref()

const multiPart = computed(() => mainParts.value.length > 1)
/** Gesamtlänge des Hauptvideos im Ergebnis (Summe der Teile). */
const mainTotal = computed(() => mainParts.value.reduce((s, r) => s + r.duration, 0))

const keyOf = mergeItemKey

// --- Übergang je Nahtstelle --------------------------------------------------
/** Name des globalen Übergangs (für die Option „Standard"). */
const globalAnimLabel = computed(() => {
  const a = ANIMATIONS.find((x) => x.id === animation.value)
  return t(a ? a.labelKey : 'anim.none')
})

/** Gewählter Übergang zwischen Eintrag i und i+1 ('' = Standard). */
function seamValue(i: number): string {
  const items = mergeItems.value
  return seamTransitions.value[seamKey(items[i], items[i + 1])] ?? ''
}

function onSeamChange(i: number, ev: Event): void {
  const items = mergeItems.value
  const v = (ev.target as HTMLSelectElement).value
  store.setSeamTransition(seamKey(items[i], items[i + 1]), v ? (v as SeamPreset) : null)
}

// --- Drag & Drop ----------------------------------------------------------
/** ID des gezogenen Videos (null = kein Ziehen aktiv). */
const dragId = ref<number | null>(null)
/** Einfügestelle in der vollständigen Liste (0 … Länge), während gezogen wird. */
const dropIndex = ref<number | null>(null)

function onDragStart(id: number): void {
  dragId.value = id
}

function resetDrag(): void {
  dragId.value = null
  dropIndex.value = null
}

/** Obere/untere Hälfte der Zielzeile entscheidet: davor oder dahinter einfügen. */
function onDragOver(ev: DragEvent, i: number): void {
  if (dragId.value === null) return
  ev.preventDefault()
  if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move'
  const el = ev.currentTarget as HTMLElement
  const rect = el.getBoundingClientRect()
  dropIndex.value = ev.clientY < rect.top + rect.height / 2 ? i : i + 1
}

function onDrop(ev: DragEvent): void {
  if (dragId.value === null) return
  ev.preventDefault()
  const id = dragId.value
  const target = dropIndex.value
  resetDrag()
  if (target === null) return
  const from = mergeItems.value.findIndex((it) => it.kind === 'append' && it.clip.id === id)
  if (from < 0) return
  // moveMergeItem erwartet den Index in der Liste OHNE das gezogene Video.
  store.moveMergeItem(id, target > from ? target - 1 : target)
}

/** Markierung der Einfügestelle: Linie über der Zeile bzw. unter der letzten. */
function dropClass(i: number): Record<string, boolean> {
  const d = dropIndex.value
  return {
    'drop-before': d === i,
    'drop-after': d === mergeItems.value.length && i === mergeItems.value.length - 1,
  }
}

function mainLabel(it: Extract<MergeItem, { kind: 'main' }>): string {
  if (!multiPart.value) return t('append.main')
  return operation.value === 'remove'
    ? t('append.rest', { n: it.index + 1 })
    : t('append.part', { n: it.index + 1 })
}
</script>

<template>
  <ol class="merge-list" @dragover.prevent @drop="onDrop">
    <template v-for="(it, i) in mergeItems" :key="keyOf(it)">
      <li
        v-if="it.kind === 'main'"
        class="segment-row main"
        :class="dropClass(i)"
        @dragover="onDragOver($event, i)"
      >
        <span class="segment-index">{{ i + 1 }}</span>
        <span class="segment-time">
          {{ mainLabel(it) }}
          <small v-if="multiPart && it.range">
            ({{ formatTimeMs(it.range.start) }} –
            {{ formatTimeMs(it.range.start + it.range.duration) }})
          </small>
          <small v-else-if="mainTotal > 0">({{ formatTimeMs(mainTotal) }})</small>
        </span>
      </li>
      <AppendClipRow
        v-else
        :class="dropClass(i)"
        :clip="it.clip"
        :index="i + 1"
        :can-up="i > 0"
        :can-down="i < mergeItems.length - 1"
        :disabled="disabled"
        :dragging="dragId === it.clip.id"
        @dragover="onDragOver($event, i)"
        @drag-start="onDragStart(it.clip.id)"
        @drag-end="resetDrag"
        @start="store.setAppendStart(it.clip.id, $event)"
        @end="store.setAppendEnd(it.clip.id, $event)"
        @reset="store.resetAppendRange(it.clip.id)"
        @position="store.setAppendPosition(it.clip.id, $event)"
        @move="store.moveAppendClip(it.clip.id, $event)"
        @remove="store.removeAppendClip(it.clip.id)"
      />
      <li v-if="i < mergeItems.length - 1" class="seam">
        <span class="seam-line" aria-hidden="true" />
        <select
          class="seam-select"
          :class="{ custom: seamValue(i) !== '' }"
          :value="seamValue(i)"
          :disabled="disabled"
          :aria-label="t('append.seam', { a: i + 1, b: i + 2 })"
          :title="t('append.seam', { a: i + 1, b: i + 2 })"
          @change="onSeamChange(i, $event)"
        >
          <option value="">{{ t('append.seamDefault', { name: globalAnimLabel }) }}</option>
          <option v-for="a in ANIMATIONS" :key="a.id" :value="a.id">{{ t(a.labelKey) }}</option>
        </select>
        <span class="seam-line" aria-hidden="true" />
      </li>
    </template>
  </ol>
</template>

<style scoped>
.merge-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.segment-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border: 1px dashed var(--ds-border);
  border-radius: var(--ds-radius-md);
  background: var(--ds-surface-2);
}
.segment-index {
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--ds-accent);
  color: var(--ds-on-accent);
  font-size: var(--ds-text-xs);
  font-weight: var(--ds-weight-semibold);
  flex: none;
}
.segment-time {
  flex: 1;
  font-size: var(--ds-text-md);
  font-variant-numeric: tabular-nums;
}
.segment-time small {
  color: var(--ds-text-2);
}
/* Übergang zwischen zwei Einträgen. */
.seam {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: -2px 0;
}
.seam-line {
  flex: 1;
  border-top: 1px dashed var(--ds-border);
}
.seam-select {
  max-width: 70%;
  padding: 2px 6px;
  border: 1px solid var(--ds-border);
  border-radius: var(--ds-radius-full);
  background: var(--ds-surface-1);
  color: var(--ds-text-2);
  font-size: var(--ds-text-xs);
  cursor: pointer;
}
.seam-select.custom {
  border-color: var(--ds-accent);
  color: var(--ds-text);
  font-weight: var(--ds-weight-semibold);
}
.seam-select:focus-visible {
  outline: none;
  box-shadow: var(--ds-focus-ring);
}
/* Einfügemarke beim Ziehen. */
.drop-before {
  box-shadow: 0 -3px 0 0 var(--ds-accent);
}
.drop-after {
  box-shadow: 0 3px 0 0 var(--ds-accent);
}
</style>
