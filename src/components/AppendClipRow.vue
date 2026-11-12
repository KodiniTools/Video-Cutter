<script setup lang="ts">
import { ref, watch, computed, nextTick, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  appendClipLength,
  isAppendTrimmed,
  type AppendClip,
  type AppendPosition,
} from '@/stores/videoEditor'
import { formatTimeMs, parseTimeInput } from '@/lib/timeFormat'

/**
 * Eine Zeile der Liste „Videos anhängen": Name, Position (davor/danach),
 * verwendeter Bereich (Von/Bis) sowie Sortieren (Griff zum Ziehen, ▲▼) und Entfernen.
 * Vorschaubild am Startpunkt; aufklappbarer Mini-Player, um Von/Bis an der
 * aktuellen Wiedergabeposition zu setzen.
 */
const props = defineProps<{
  clip: AppendClip
  /** Laufende Nummer in der Gesamtreihenfolge. */
  index: number
  canUp: boolean
  canDown: boolean
  disabled: boolean
  /** Wird diese Zeile gerade gezogen? (nur Optik) */
  dragging?: boolean
}>()

const emit = defineEmits<{
  (e: 'start', sec: number): void
  (e: 'end', sec: number | null): void
  (e: 'reset'): void
  (e: 'position', pos: AppendPosition): void
  (e: 'move', delta: number): void
  (e: 'remove'): void
  (e: 'drag-start', ev: DragEvent): void
  (e: 'drag-end'): void
}>()

const rowEl = ref<HTMLLIElement | null>(null)

// --- Vorschau --------------------------------------------------------------
// Eine Blob-URL je Zeile (die Datei eines Eintrags ändert sich nie; Zeilen
// sind per clip.id verschlüsselt). Wird beim Entfernen der Zeile freigegeben.
const fileUrl = URL.createObjectURL(props.clip.file)
onBeforeUnmount(() => URL.revokeObjectURL(fileUrl))

/** Vorschaubild = Bild am Startpunkt (Media-Fragment, lädt nur Metadaten). */
const thumbSrc = computed(() => `${fileUrl}#t=${props.clip.start.toFixed(3)}`)

const previewOpen = ref(false)
const player = ref<HTMLVideoElement | null>(null)
/** Aktuelle Position im Mini-Player (Sekunden). */
const playerTime = ref(0)
/** Spielt nur den gewählten Bereich ab und hält am Ende an. */
let stopAt: number | null = null

/** Ende des verwendeten Bereichs (Dateiende, falls ungekürzt/unbekannt). */
const rangeEnd = computed(() => props.clip.end ?? (props.clip.duration || Infinity))

async function togglePreview(): Promise<void> {
  previewOpen.value = !previewOpen.value
  stopAt = null
  if (!previewOpen.value) return
  await nextTick()
  if (player.value) player.value.currentTime = props.clip.start
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
  el.currentTime = props.clip.start
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
    ev.dataTransfer.setData('text/plain', String(props.clip.id))
    if (rowEl.value) ev.dataTransfer.setDragImage(rowEl.value, 16, 16)
  }
  emit('drag-start', ev)
}

const { t } = useI18n()

const startInput = ref('')
const endInput = ref('')
watch(
  () => props.clip.start,
  (v) => (startInput.value = formatTimeMs(v)),
  { immediate: true },
)
// Ende leer = „bis zum Dateiende"; Platzhalter zeigt dann die Gesamtdauer.
watch(
  () => props.clip.end,
  (v) => (endInput.value = v === null ? '' : formatTimeMs(v)),
  { immediate: true },
)

const endPlaceholder = computed(() =>
  props.clip.duration > 0 ? formatTimeMs(props.clip.duration) : t('append.toEnd'),
)
const trimmed = computed(() => isAppendTrimmed(props.clip))
const usedLength = computed(() => appendClipLength(props.clip))

function commitStart(): void {
  const sec = parseTimeInput(startInput.value)
  if (sec !== null) emit('start', sec)
  startInput.value = formatTimeMs(props.clip.start)
}

function commitEnd(): void {
  const raw = endInput.value.trim()
  if (!raw) {
    emit('end', null)
    return
  }
  const sec = parseTimeInput(raw)
  if (sec !== null) emit('end', sec)
  endInput.value = props.clip.end === null ? '' : formatTimeMs(props.clip.end)
}
</script>

<template>
  <li ref="rowEl" class="append-row" :class="{ dragging }">
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
      <span class="info" :title="clip.file.name">
        <span class="name">{{ clip.file.name }}</span>
        <small v-if="usedLength > 0">
          {{ formatTimeMs(usedLength) }}
          <template v-if="trimmed"> / {{ formatTimeMs(clip.duration) }}</template>
        </small>
      </span>
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
      <button
        class="btn tiny"
        type="button"
        :disabled="disabled"
        :aria-label="t('append.remove')"
        :title="t('append.remove')"
        @click="emit('remove')"
      >
        ✕
      </button>
    </div>

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

    <div class="position" role="radiogroup" :aria-label="t('append.position')">
      <button
        v-for="pos in ['before', 'after'] as const"
        :key="pos"
        class="seg-btn"
        :class="{ active: clip.position === pos }"
        type="button"
        role="radio"
        :aria-checked="clip.position === pos"
        :disabled="disabled"
        @click="emit('position', pos)"
      >
        {{ pos === 'before' ? t('append.before') : t('append.after') }}
      </button>
    </div>

    <div class="range">
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
  color: var(--ds-text-2);
  font-variant-numeric: tabular-nums;
}
.position {
  display: flex;
  border: 1px solid var(--ds-border-strong);
  border-radius: var(--ds-radius-md);
  overflow: hidden;
}
.seg-btn {
  flex: 1;
  padding: 5px 8px;
  border: none;
  background: transparent;
  color: var(--ds-text-2);
  font-size: var(--ds-text-xs);
  cursor: pointer;
}
.seg-btn + .seg-btn {
  border-left: 1px solid var(--ds-border-strong);
}
.seg-btn.active {
  background: var(--ds-accent-soft);
  color: var(--ds-text);
  font-weight: var(--ds-weight-semibold);
}
.seg-btn:disabled {
  cursor: not-allowed;
}
.seg-btn:focus-visible {
  outline: none;
  box-shadow: var(--ds-focus-ring);
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
