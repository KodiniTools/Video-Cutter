<script setup lang="ts">
import { ref, watch, computed, nextTick, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import { itemLength, isItemTrimmed, type LibraryItem } from '@/stores/library'
import { formatTimeMs, parseTimeInput } from '@/lib/timeFormat'
import { MEDIA_UNSUPPORTED } from '@/lib/mediaApi'

/**
 * Eine Zeile der Liste „Meine Videos": Vorschaubild, Name/Dauer, Markieren
 * (Bearbeiten im Haupt-Editor), „Zusammenfügen"-Häkchen, verwendeter Bereich
 * (Von/Bis), Sortieren (Griff zum Ziehen, ↑↓) und Löschen vom Server.
 * Aufklappbarer Mini-Player, um Von/Bis an der Wiedergabeposition zu setzen.
 */
const props = defineProps<{
  item: LibraryItem
  /** Laufende Nummer in der Liste. */
  index: number
  /** Im Haupt-Editor geöffnet? */
  selected: boolean
  canUp: boolean
  canDown: boolean
  disabled: boolean
  /** Wird diese Zeile gerade gezogen? (nur Optik) */
  dragging?: boolean
}>()

const emit = defineEmits<{
  (e: 'select'): void
  (e: 'include', on: boolean): void
  (e: 'start', sec: number): void
  (e: 'end', sec: number | null): void
  (e: 'reset'): void
  (e: 'move', delta: number): void
  (e: 'remove'): void
  (e: 'retry'): void
  (e: 'drag-start', ev: DragEvent): void
  (e: 'drag-end'): void
}>()

const rowEl = ref<HTMLLIElement | null>(null)

// --- Vorschau --------------------------------------------------------------
// Eine Blob-URL je Datei. Ersetzt ein Schnitt-Ergebnis die Datei, wird die
// alte URL freigegeben; beim Entfernen der Zeile ebenso.
const fileUrl = ref('')
watch(
  () => props.item.file,
  (f) => {
    const old = fileUrl.value
    fileUrl.value = URL.createObjectURL(f)
    if (old) URL.revokeObjectURL(old)
  },
  { immediate: true },
)
onBeforeUnmount(() => {
  if (fileUrl.value) URL.revokeObjectURL(fileUrl.value)
})

/** Vorschaubild = Bild am Startpunkt (Media-Fragment, lädt nur Metadaten). */
const thumbSrc = computed(() => `${fileUrl.value}#t=${props.item.start.toFixed(3)}`)

const previewOpen = ref(false)
const player = ref<HTMLVideoElement | null>(null)
/** Aktuelle Position im Mini-Player (Sekunden). */
const playerTime = ref(0)
/** Spielt nur den gewählten Bereich ab und hält am Ende an. */
let stopAt: number | null = null

/** Ende des verwendeten Bereichs (Dateiende, falls ungekürzt/unbekannt). */
const rangeEnd = computed(() => props.item.end ?? (props.item.duration || Infinity))

async function togglePreview(): Promise<void> {
  previewOpen.value = !previewOpen.value
  stopAt = null
  if (!previewOpen.value) return
  await nextTick()
  if (player.value) player.value.currentTime = props.item.start
}

function onPlayerTime(): void {
  const el = player.value
  if (!el) return
  playerTime.value = el.currentTime
  if (stopAt !== null && el.currentTime >= stopAt) {
    el.pause()
    el.currentTime = stopAt
    stopAt = null
  }
}

function playRange(): void {
  const el = player.value
  if (!el) return
  el.currentTime = props.item.start
  stopAt = Number.isFinite(rangeEnd.value) ? rangeEnd.value : null
  // Ältere Browser liefern kein Promise zurück.
  const p = el.play() as Promise<void> | undefined
  p?.catch(() => {
    /* Autoplay blockiert – Nutzer kann manuell starten. */
  })
}

function setFromPlayer(which: 'start' | 'end'): void {
  const el = player.value
  if (!el) return
  stopAt = null
  if (which === 'start') emit('start', el.currentTime)
  else emit('end', el.currentTime)
}

/** Nur der Griff ist ziehbar (Eingabefelder bleiben normal bedienbar). */
function onHandleDragStart(ev: DragEvent): void {
  if (props.disabled) {
    ev.preventDefault()
    return
  }
  if (ev.dataTransfer) {
    ev.dataTransfer.effectAllowed = 'move'
    // Firefox startet das Ziehen nur mit gesetzten Daten.
    ev.dataTransfer.setData('text/plain', String(props.item.id))
    if (rowEl.value) ev.dataTransfer.setDragImage(rowEl.value, 16, 16)
  }
  emit('drag-start', ev)
}

const { t } = useI18n()

const startInput = ref('')
const endInput = ref('')
watch(
  () => props.item.start,
  (v) => (startInput.value = formatTimeMs(v)),
  { immediate: true },
)
// Ende leer = „bis zum Dateiende"; Platzhalter zeigt dann die Gesamtdauer.
watch(
  () => props.item.end,
  (v) => (endInput.value = v === null ? '' : formatTimeMs(v)),
  { immediate: true },
)

const endPlaceholder = computed(() =>
  props.item.duration > 0 ? formatTimeMs(props.item.duration) : t('append.toEnd'),
)
const trimmed = computed(() => isItemTrimmed(props.item))
const usedLength = computed(() => itemLength(props.item))
const progressPct = computed(() => Math.round(props.item.progress * 100))
/** Fehlertext (veraltetes Backend übersetzt). */
const errorText = computed(() =>
  props.item.error === MEDIA_UNSUPPORTED ? t('errors.mediaUnsupported') : props.item.error,
)

function commitStart(): void {
  const sec = parseTimeInput(startInput.value)
  if (sec !== null) emit('start', sec)
  startInput.value = formatTimeMs(props.item.start)
}

function commitEnd(): void {
  const raw = endInput.value.trim()
  if (!raw) {
    emit('end', null)
    return
  }
  const sec = parseTimeInput(raw)
  if (sec !== null) emit('end', sec)
  endInput.value = props.item.end === null ? '' : formatTimeMs(props.item.end)
}
</script>

<template>
  <li
    ref="rowEl"
    class="append-row"
    :class="{ dragging, selected, failed: item.status === 'error' }"
  >
    <div class="row-head">
      <span
        class="drag-handle"
        :class="{ disabled }"
        :draggable="!disabled"
        role="img"
        :aria-label="t('append.drag')"
        :title="t('append.drag')"
        @dragstart="onHandleDragStart"
        @dragend="emit('drag-end')"
        >⠿</span
      >
      <span class="segment-index">{{ index }}</span>
      <button
        class="thumb-btn"
        type="button"
        :aria-expanded="previewOpen"
        :aria-label="previewOpen ? t('append.hidePreview') : t('append.preview')"
        :title="previewOpen ? t('append.hidePreview') : t('append.preview')"
        @click="togglePreview"
      >
        <video class="thumb" :src="thumbSrc" muted playsinline preload="metadata" tabindex="-1" />
        <span class="thumb-icon" aria-hidden="true">{{ previewOpen ? '▴' : '▶' }}</span>
      </button>
      <button
        class="info"
        type="button"
        :aria-pressed="selected"
        :title="`${item.name} – ${selected ? t('library.selected') : t('library.select')}`"
        :disabled="disabled"
        @click="emit('select')"
      >
        <span class="name">{{ item.name }}</span>
        <small v-if="item.status === 'uploading'" class="status">
          {{ t('library.uploading', { pct: progressPct }) }}
        </small>
        <small v-else-if="item.status === 'error'" class="status error">{{ errorText }}</small>
        <small v-else-if="usedLength > 0">
          {{ formatTimeMs(usedLength) }}
          <template v-if="trimmed"> / {{ formatTimeMs(item.duration) }}</template>
          <template v-if="selected"> · {{ t('library.inEditor') }}</template>
        </small>
      </button>
      <button
        class="btn tiny remove"
        type="button"
        :disabled="disabled"
        :aria-label="t('library.delete')"
        :title="t('library.delete')"
        @click="emit('remove')"
      >
        🗑
      </button>
    </div>

    <div
      v-if="item.status === 'uploading'"
      class="upload-bar"
      role="progressbar"
      :aria-valuenow="progressPct"
    >
      <div class="upload-fill" :style="{ width: `${progressPct}%` }"></div>
    </div>
    <button
      v-if="item.status === 'error'"
      class="btn tiny ghost retry"
      type="button"
      :disabled="disabled"
      @click="emit('retry')"
    >
      ↻ {{ t('library.retry') }}
    </button>

    <div v-if="previewOpen" class="preview">
      <video
        ref="player"
        class="player"
        :src="fileUrl"
        controls
        playsinline
        preload="metadata"
        @timeupdate="onPlayerTime"
        @seeked="onPlayerTime"
      />
      <div class="preview-actions">
        <button
          class="btn tiny"
          type="button"
          :disabled="disabled"
          :title="t('append.setFrom')"
          @click="setFromPlayer('start')"
        >
          {{ t('append.from') }} ⇤
        </button>
        <span class="player-time">{{ formatTimeMs(playerTime) }}</span>
        <button
          class="btn tiny"
          type="button"
          :disabled="disabled"
          :title="t('append.setTo')"
          @click="setFromPlayer('end')"
        >
          ⇥ {{ t('append.to') }}
        </button>
        <button
          class="btn tiny ghost"
          type="button"
          :title="t('append.playRange')"
          @click="playRange"
        >
          {{ t('append.playRange') }}
        </button>
      </div>
    </div>

    <div class="row-foot">
      <label class="include">
        <input
          type="checkbox"
          :checked="item.include"
          :disabled="disabled"
          @change="emit('include', ($event.target as HTMLInputElement).checked)"
        />
        <span>{{ t('library.include') }}</span>
      </label>
      <button
        class="btn tiny"
        type="button"
        :disabled="!canUp || disabled"
        :aria-label="t('append.up')"
        :title="t('append.up')"
        @click="emit('move', -1)"
      >
        ↑
      </button>
      <button
        class="btn tiny"
        type="button"
        :disabled="!canDown || disabled"
        :aria-label="t('append.down')"
        :title="t('append.down')"
        @click="emit('move', 1)"
      >
        ↓
      </button>
    </div>

    <div v-if="item.include" class="range">
      <label class="range-field">
        <span>{{ t('append.from') }}</span>
        <input
          v-model="startInput"
          class="time"
          type="text"
          inputmode="decimal"
          :placeholder="t('time.placeholder')"
          :disabled="disabled"
          @change="commitStart"
          @keydown.enter.prevent="commitStart"
        />
      </label>
      <label class="range-field">
        <span>{{ t('append.to') }}</span>
        <input
          v-model="endInput"
          class="time"
          type="text"
          inputmode="decimal"
          :placeholder="endPlaceholder"
          :disabled="disabled"
          @change="commitEnd"
          @keydown.enter.prevent="commitEnd"
        />
      </label>
      <button
        class="btn tiny ghost"
        type="button"
        :disabled="!trimmed || disabled"
        :title="t('append.full')"
        :aria-label="t('append.full')"
        @click="emit('reset')"
      >
        ↺
      </button>
    </div>
  </li>
</template>

<style scoped>
.append-row {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid var(--ds-border);
  border-radius: var(--ds-radius-md);
  background: var(--ds-surface-2);
}
.append-row.dragging {
  opacity: 0.45;
}
.drag-handle {
  flex: none;
  padding: 2px 2px;
  color: var(--ds-text-2);
  font-size: var(--ds-text-md);
  line-height: 1;
  cursor: grab;
  user-select: none;
}
.drag-handle:active {
  cursor: grabbing;
}
.drag-handle.disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.thumb-btn {
  position: relative;
  flex: none;
  width: 44px;
  height: 28px;
  padding: 0;
  border: 1px solid var(--ds-border-strong);
  border-radius: var(--ds-radius-sm);
  overflow: hidden;
  background: #000;
  cursor: pointer;
}
.thumb-btn:focus-visible {
  outline: none;
  box-shadow: var(--ds-focus-ring);
}
.thumb {
  width: 100%;
  height: 100%;
  object-fit: cover;
  pointer-events: none;
  display: block;
}
.thumb-icon {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: #fff;
  font-size: 11px;
  text-shadow: 0 0 3px rgba(0, 0, 0, 0.8);
}
.preview {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.player {
  width: 100%;
  max-height: 180px;
  border-radius: var(--ds-radius-sm);
  background: #000;
}
.preview-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.player-time {
  flex: 1;
  text-align: center;
  font-family: var(--ds-font-mono);
  font-size: var(--ds-text-xs);
  font-variant-numeric: tabular-nums;
  color: var(--ds-text-2);
}
.row-head {
  display: flex;
  align-items: center;
  gap: 6px;
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
.info {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  font-size: var(--ds-text-md);
}
.name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.info small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ds-text-2);
  font-variant-numeric: tabular-nums;
}
.append-row.selected {
  border-color: var(--ds-accent);
  box-shadow: 0 0 0 1px var(--ds-accent);
}
.append-row.failed {
  border-color: var(--ds-danger);
}
.info {
  appearance: none;
  border: none;
  background: transparent;
  color: inherit;
  padding: 0;
  text-align: left;
  cursor: pointer;
}
.info:focus-visible {
  outline: none;
  box-shadow: var(--ds-focus-ring);
}
.info:disabled {
  cursor: not-allowed;
}
.status.error {
  color: var(--ds-danger);
  white-space: normal;
}
.upload-bar {
  height: 4px;
  border-radius: var(--ds-radius-full);
  background: var(--ds-surface-1);
  overflow: hidden;
}
.upload-fill {
  height: 100%;
  background: var(--ds-accent);
  transition: width 0.2s;
}
.retry {
  align-self: flex-start;
}
.row-foot {
  display: flex;
  align-items: center;
  gap: 6px;
}
.include {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--ds-text-xs);
  color: var(--ds-text-2);
  cursor: pointer;
}
.range {
  display: flex;
  align-items: flex-end;
  gap: 6px;
}
.range-field {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  font-size: 10px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--ds-text-2);
}
.time {
  width: 100%;
  min-width: 0;
  padding: 5px 6px;
  border: 1px solid var(--ds-border-strong);
  border-radius: var(--ds-radius-sm);
  background: var(--ds-surface-1);
  color: var(--ds-text);
  font-family: var(--ds-font-mono);
  font-size: var(--ds-text-xs);
  font-variant-numeric: tabular-nums;
  text-align: center;
  text-transform: none;
  letter-spacing: normal;
}
.time:focus-visible {
  outline: none;
  box-shadow: var(--ds-focus-ring);
  border-color: var(--ds-accent);
}
.btn {
  appearance: none;
  border: 1px solid var(--ds-border-strong);
  background: var(--ds-surface-2);
  color: var(--ds-text);
  border-radius: var(--ds-radius-md);
  cursor: pointer;
}
.btn.tiny {
  padding: 4px 8px;
  font-size: var(--ds-text-md);
  line-height: 1;
}
.btn.ghost {
  background: transparent;
}
.btn:hover:not(:disabled) {
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
</style>
