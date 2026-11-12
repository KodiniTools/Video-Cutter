<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { storeToRefs } from 'pinia'
import { useLibraryStore, seamKey, type LibraryItem, type SeamPreset } from '@/stores/library'
import { ANIMATIONS, useAnimationPref } from '@/composables/useAnimationPref'
import LibraryRow from './LibraryRow.vue'

/**
 * Liste „Meine Videos": Reihenfolge per Drag & Drop oder ↑↓ (= Reihenfolge
 * beim Zusammenfügen), Übergang je Nahtstelle zwischen zwei zusammenzufügenden
 * Videos, Markieren zum Bearbeiten und Löschen vom Server.
 */
defineProps<{
  disabled: boolean
}>()

const emit = defineEmits<{
  (e: 'remove', id: number): void
}>()

const { t } = useI18n()
const store = useLibraryStore()
const { items, selectedId, seamTransitions } = storeToRefs(store)
const { animation } = useAnimationPref()

// --- Übergang je Nahtstelle --------------------------------------------------
/** Name des globalen Übergangs (für die Option „Standard"). */
const globalAnimLabel = computed(() => {
  const a = ANIMATIONS.find((x) => x.id === animation.value)
  return t(a ? a.labelKey : 'anim.none')
})

/**
 * Nahtstelle hinter Eintrag i: zum nächsten zusammenzufügenden Video.
 * `null`, wenn Eintrag i nicht zusammengefügt wird oder keines mehr folgt.
 */
const seams = computed(() =>
  items.value.map((it, i) => {
    if (!it.include) return null
    const j = items.value.findIndex((x, k) => k > i && x.include)
    if (j < 0) return null
    return { key: seamKey(it, items.value[j]), a: i + 1, b: j + 1 }
  }),
)

function seamValue(key: string): string {
  return seamTransitions.value[key] ?? ''
}

function onSeamChange(key: string, ev: Event): void {
  const v = (ev.target as HTMLSelectElement).value
  store.setSeamTransition(key, v ? (v as SeamPreset) : null)
}

// --- Drag & Drop ----------------------------------------------------------
/** ID des gezogenen Videos (null = kein Ziehen aktiv). */
const dragId = ref<number | null>(null)
/** Einfügestelle in der Liste (0 … Länge), während gezogen wird. */
const dropIndex = ref<number | null>(null)

function resetDrag(): void {
  dragId.value = null
  dropIndex.value = null
}

/** Obere/untere Hälfte der Zielzeile entscheidet: davor oder dahinter einfügen. */
function onDragOver(ev: DragEvent, i: number): void {
  if (dragId.value === null) return
  ev.preventDefault()
  if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move'
  const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect()
  dropIndex.value = ev.clientY < rect.top + rect.height / 2 ? i : i + 1
}

function onDrop(ev: DragEvent): void {
  if (dragId.value === null) return
  ev.preventDefault()
  const id = dragId.value
  const target = dropIndex.value
  resetDrag()
  if (target === null) return
  const from = items.value.findIndex((it) => it.id === id)
  if (from < 0) return
  // move erwartet den Index in der Liste OHNE das gezogene Video.
  store.move(id, target > from ? target - 1 : target)
}

/** Markierung der Einfügestelle: Linie über der Zeile bzw. unter der letzten. */
function dropClass(i: number): Record<string, boolean> {
  const d = dropIndex.value
  return {
    'drop-before': d === i,
    'drop-after': d === items.value.length && i === items.value.length - 1,
  }
}

function keyOf(it: LibraryItem): number {
  return it.id
}
</script>

<template>
  <ol class="merge-list" @dragover.prevent @drop="onDrop">
    <template v-for="(it, i) in items" :key="keyOf(it)">
      <LibraryRow
        :class="dropClass(i)"
        :item="it"
        :index="i + 1"
        :selected="it.id === selectedId"
        :can-up="i > 0"
        :can-down="i < items.length - 1"
        :disabled="disabled"
        :dragging="dragId === it.id"
        @dragover="onDragOver($event, i)"
        @drag-start="dragId = it.id"
        @drag-end="resetDrag"
        @select="store.select(it.id)"
        @include="store.setInclude(it.id, $event)"
        @start="store.setStart(it.id, $event)"
        @end="store.setEnd(it.id, $event)"
        @reset="store.resetRange(it.id)"
        @move="store.moveBy(it.id, $event)"
        @retry="store.retry(it.id)"
        @remove="emit('remove', it.id)"
      />
      <li v-if="seams[i]" class="seam">
        <span class="seam-line" aria-hidden="true" />
        <select
          class="seam-select"
          :class="{ custom: seamValue(seams[i]!.key) !== '' }"
          :value="seamValue(seams[i]!.key)"
          :disabled="disabled"
          :aria-label="t('append.seam', { a: seams[i]!.a, b: seams[i]!.b })"
          :title="t('append.seam', { a: seams[i]!.a, b: seams[i]!.b })"
          @change="onSeamChange(seams[i]!.key, $event)"
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
/* Übergang zwischen zwei zusammenzufügenden Videos. */
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
