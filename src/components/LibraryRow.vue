<script setup lang="ts">
import { ref, watch, computed, nextTick, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import { itemLength, isItemTrimmed, MIN_LENGTH, type LibraryItem } from '@/stores/library'
import { formatTimeMs, parseTimeInput } from '@/lib/timeFormat'
import { MEDIA_UNSUPPORTED } from '@/lib/mediaApi'
import type { TimelineEntry } from '@/lib/mergeTimeline'

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
  /** Lage im Gesamtvideo (Von/Bis, Standbild); `null`/fehlt = (noch) nicht bekannt. */
  entry?: TimelineEntry | null
  /** Erster Clip des Gesamtvideos? (Von ist dann immer 0) */
  first?: boolean
}>()

const emit = defineEmits<{
  (e: 'select'): void
  (e: 'include', on: boolean): void
  (e: 'start', sec: number): void
  (e: 'end', sec: number | null): void
  /** Von im Gesamtvideo; `null` = direkt nach dem vorigen Clip. */
  (e: 'at', sec: number | null): void
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

/** „Clip ab": Startpunkt innerhalb des Clips. */
const startInput = ref('')
/** Von/Bis: Zeit im Gesamtvideo. */
const atInput = ref('')
const endInput = ref('')
watch(
  () => props.item.start,
  (v) => (startInput.value = formatTimeMs(v)),
  { immediate: true },
)
watch(
  () => props.entry?.start,
  (v) => (atInput.value = v === undefined ? '' : formatTimeMs(v)),
  { immediate: true },
)
watch(
  () => props.entry?.end,
  (v) => (endInput.value = v === undefined ? '' : formatTimeMs(v)),
  { immediate: true },
)

const trimmed = computed(() => isItemTrimmed(props.item) || props.item.at !== null)
const usedLength = computed(() => itemLength(props.item))
const progressPct = computed(() => Math.round(props.item.progress * 100))
/** Fehlertext (veraltetes Backend übersetzt). */
const errorText = computed(() =>
  props.item.error === MEDIA_UNSUPPORTED ? t('errors.mediaUnsupported') : props.item.error,
)
/** Hinweis zur Lage: Standbild in der Lücke danach bzw. vom nächsten Clip abgeschnitten. */
const entryInfo = computed(() => {
  const e = props.entry
  if (!e) return ''
  if (e.hold > 1e-3) return t('append.holdInfo', { sec: formatTimeMs(e.hold) })
  if (usedLength.value - e.used > 1e-3) return t('append.cutInfo', { at: formatTimeMs(e.end) })
  return ''
})

/** Rückmeldung zur letzten Eingabe (statt die Eingabe still zu verwerfen). */
const rangeNote = ref('')

/**
 * Liest eine Zeit. „mm:ss:mmm" (Doppelpunkt statt Punkt vor den drei
 * Millisekunden-Ziffern) wird wie „mm:ss.mmm" verstanden.
 */
function readTime(raw: string): number | null {
  const s = raw.trim()
  return parseTimeInput(/^(\d{1,2}:)?\d{1,2}:\d{3}$/.test(s) ? s.replace(/:(\d{3})$/, '.$1') : s)
}

/** „Clip ab" (Zeit im Clip). */
function commitStart(): void {
  const raw = startInput.value.trim()
  const sec = readTime(raw)
  const dur = props.item.duration
  if (sec === null) {
    rangeNote.value = raw ? t('append.timeInvalid', { value: raw }) : ''
  } else {
    rangeNote.value =
      dur > 0 && sec > dur - MIN_LENGTH
        ? t('append.startBeyond', { value: formatTimeMs(sec), dur: formatTimeMs(dur) })
        : ''
    emit('start', sec)
  }
  startInput.value = formatTimeMs(props.item.start)
}

/** Von (Zeit im Gesamtvideo); leer = direkt nach dem vorigen Clip. */
function commitAt(): void {
  const raw = atInput.value.trim()
  const e = props.entry
  if (!raw) {
    rangeNote.value = ''
    emit('at', null)
  } else {
    const sec = readTime(raw)
    if (sec === null) {
      rangeNote.value = t('append.timeInvalid', { value: raw })
    } else {
      rangeNote.value =
        e && sec < e.minStart - 1e-3
          ? t('append.atBeforePrev', { value: formatTimeMs(sec), min: formatTimeMs(e.minStart) })
          : ''
      emit('at', sec)
    }
  }
  atInput.value = e ? formatTimeMs(e.start) : ''
}

/** Bis (Zeit im Gesamtvideo) -> Ende im Clip; leer = Clip bis zu seinem Ende. */
function commitEnd(): void {
  const raw = endInput.value.trim()
  const e = props.entry
  if (!raw) {
    rangeNote.value = ''
    emit('end', null)
  } else if (e) {
    const sec = readTime(raw)
    const dur = props.item.duration
    if (sec === null) {
      rangeNote.value = t('append.timeInvalid', { value: raw })
    } else if (sec < e.start + MIN_LENGTH) {
      rangeNote.value = t('append.endBeforeStart', { from: formatTimeMs(e.start) })
      emit('end', props.item.start + MIN_LENGTH)
    } else {
      const maxEnd = dur > 0 ? e.start + (dur - props.item.start) : Infinity
      rangeNote.value =
        sec - maxEnd > 1e-3
          ? t('append.endBeyond', {
              value: formatTimeMs(sec),
              max: formatTimeMs(maxEnd),
              len: formatTimeMs(dur - props.item.start),
            })
          : ''
      emit('end', props.item.start + (Math.min(sec, maxEnd) - e.start))
    }
  }
  endInput.value = e ? formatTimeMs(e.end) : ''
}

function resetRange(): void {
  rangeNote.value = ''
  emit('reset')
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
          {{ t('append.clipFrom') }} ⇤
        </button>
        <span class="player-time">{{ formatTimeMs(playerTime) }}</span>
        <button
          class="btn tiny"
          type="button"
          :disabled="disabled"
          :title="t('append.setTo')"
          @click="setFromPlayer('end')"
        >
          ⇥ {{ t('append.clipTo') }}
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
          v-model="atInput"
          class="time"
          type="text"
          inputmode="decimal"
          :placeholder="t('time.placeholder')"
          :title="t('append.fromHint')"
          :disabled="disabled || first || !entry"
          @change="commitAt"
          @keydown.enter.prevent="commitAt"
        />
      </label>
      <label class="range-field">
        <span>{{ t('append.to') }}</span>
        <input
          v-model="endInput"
          class="time"
          type="text"
          inputmode="decimal"
          :placeholder="t('time.placeholder')"
          :title="t('append.toHint')"
          :disabled="disabled || !entry"
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
        @click="resetRange"
      >
        ↺
      </button>
    </div>
    <div v-if="item.include" class="clip-from">
      <label class="clip-from-field">
        <span>{{ t('append.clipFrom') }}</span>
        <input
          v-model="startInput"
          class="time small"
          type="text"
          inputmode="decimal"
          :placeholder="t('time.placeholder')"
          :title="t('append.clipFromHint')"
          :disabled="disabled"
          @change="commitStart"
          @keydown.enter.prevent="commitStart"
        />
      </label>
      <small v-if="entryInfo" class="entry-info">{{ entryInfo }}</small>
    </div>
    <p v-if="item.include && rangeNote" class="range-note" role="status">{{ rangeNote }}</p>
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
.clip-from {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.clip-from-field {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--ds-text-2);
}
.time.small {
  width: 92px;
  padding: 3px 4px;
}
.entry-info {
  flex: 1;
  min-width: 0;
  font-size: var(--ds-text-xs);
  color: var(--ds-text-2);
}
.range-note {
  margin: 0;
  font-size: var(--ds-text-xs);
  line-height: 1.4;
  color: var(--ds-warning, var(--ds-danger));
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
