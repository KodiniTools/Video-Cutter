<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import TimelineClip, { type ClipGrab } from './TimelineClip.vue'
import { formatTimeMs } from '@/lib/timeFormat'
import { MAX_ZOOM, MIN_ZOOM, useTimelineStore } from '@/stores/timeline'
import { fitZoom, pxToTime, rulerTicks, timeToPx } from '@/timeline/layout'
import {
  findClip,
  frameTime,
  MICROS_PER_SECOND,
  timeToSeconds,
  type OpError,
  type Time,
  type TrackKind,
} from '@/timeline/model'

/**
 * Mehrspur-Timeline: Lineal, Spuren mit Clips, Abspielkopf, Zoom und Auswahl.
 * Clips lassen sich ziehen (auch auf eine andere Spur gleicher Art), an den
 * Rändern trimmen, am Abspielkopf teilen und löschen – per Maus und Tastatur.
 */
const { t } = useI18n()
const store = useTimelineStore()

/** Breite der Spalte mit den Spurnamen (px). */
const HEADER_WIDTH = 96
/** Freier Platz hinter dem letzten Clip (px). */
const TAIL = 240
const TRACK_HEIGHT: Record<TrackKind, number> = { video: 56, audio: 44, overlay: 32 }
const ZOOM_STEP = 1.5

const scroller = ref<HTMLDivElement | null>(null)
const viewportWidth = ref(800)
const scrollLeft = ref(0)
let observer: ResizeObserver | null = null

const laneViewport = computed(() => Math.max(100, viewportWidth.value - HEADER_WIDTH))
const contentWidth = computed(() =>
  Math.ceil(Math.max(timeToPx(store.duration, store.zoom) + TAIL, laneViewport.value)),
)
const playheadLeft = computed(() => HEADER_WIDTH + timeToPx(store.playhead, store.zoom))

/** Nur die Striche im sichtbaren Bereich (lange Timelines hätten sonst Zehntausende). */
const ticks = computed(() =>
  rulerTicks(
    store.zoom,
    pxToTime(scrollLeft.value - 200, store.zoom),
    pxToTime(Math.min(contentWidth.value, scrollLeft.value + laneViewport.value + 200), store.zoom),
  ).map((tick) => ({ ...tick, left: timeToPx(tick.time, store.zoom) })),
)

const timeText = computed(
  () =>
    `${formatTimeMs(timeToSeconds(store.playhead))} / ${formatTimeMs(timeToSeconds(store.duration))}`,
)

function measure(): void {
  const el = scroller.value
  if (!el) return
  if (el.clientWidth > 0) viewportWidth.value = el.clientWidth
  scrollLeft.value = el.scrollLeft
}

// Der Scroll-Bereich entsteht erst mit der ersten Spur: Breite dann messen und beobachten.
watch(
  scroller,
  (el) => {
    observer?.disconnect()
    observer = null
    if (!el) return
    measure()
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(measure)
      observer.observe(el)
    }
  },
  { immediate: true, flush: 'post' },
)
onBeforeUnmount(() => observer?.disconnect())

// --- Abspielkopf -------------------------------------------------------------

function seekFromEvent(event: PointerEvent): void {
  const ruler = event.currentTarget as HTMLElement
  store.seek(pxToTime(event.clientX - ruler.getBoundingClientRect().left, store.zoom))
}

function onRulerDown(event: PointerEvent): void {
  if (event.button !== 0) return
  ;(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId)
  seekFromEvent(event)
}

function onRulerMove(event: PointerEvent): void {
  // Nur bei gedrückter Haupttaste (Ziehen über das Lineal).
  if (event.buttons & 1) seekFromEvent(event)
}

// --- Zoom ----------------------------------------------------------------------

/** Zoom ändern und die Stelle unter `anchorPx` (im sichtbaren Bereich) festhalten. */
function zoomTo(next: number, anchorPx = 0): void {
  const el = scroller.value
  const before = store.zoom
  store.setZoom(next)
  if (!el || store.zoom === before) return
  const target = (el.scrollLeft + anchorPx) * (store.zoom / before) - anchorPx
  void nextTick(() => {
    el.scrollLeft = Math.max(0, target)
    measure()
  })
}

function onWheel(event: WheelEvent): void {
  if (!event.ctrlKey && !event.metaKey) return
  event.preventDefault()
  const el = scroller.value
  const anchor = el
    ? Math.max(0, event.clientX - el.getBoundingClientRect().left - HEADER_WIDTH)
    : 0
  zoomTo(store.zoom * (event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP), anchor)
}

function fit(): void {
  store.setZoom(fitZoom(store.duration, laneViewport.value, MIN_ZOOM, MAX_ZOOM))
  void nextTick(() => {
    if (scroller.value) scroller.value.scrollLeft = 0
    measure()
  })
}

// --- Auswahl und Ziehen ----------------------------------------------------

/** Ab so vielen Pixeln Bewegung gilt ein gedrückter Zeiger als Ziehen. */
const DRAG_THRESHOLD = 3

interface Drag {
  id: string
  mode: ClipGrab
  pointerId: number
  startX: number
  startScroll: number
  /** Zeit des gegriffenen Rands bzw. Clip-Beginns beim Greifen. */
  origin: Time
  active: boolean
}
let drag: Drag | null = null
const dragging = ref(false)

function onGrab(id: string, mode: ClipGrab, event: PointerEvent): void {
  root.value?.focus({ preventScroll: true })
  const toggle = event.ctrlKey || event.metaKey || event.shiftKey
  if (toggle) return store.selectClip(id, true)
  if (!store.selection.includes(id)) store.selectClip(id)
  const loc = findClip(store.doc, id)
  if (!loc || loc.track.locked) return
  const clip = loc.clip
  drag = {
    id,
    mode,
    pointerId: event.pointerId,
    startX: event.clientX,
    startScroll: scroller.value?.scrollLeft ?? 0,
    origin: mode === 'end' ? clip.start + clip.duration : clip.start,
    active: false,
  }
  window.addEventListener('pointermove', onDragMove)
  window.addEventListener('pointerup', onDragEnd)
  window.addEventListener('pointercancel', onDragCancel)
}

function onDragMove(event: PointerEvent): void {
  if (!drag) return
  const scrolled = (scroller.value?.scrollLeft ?? 0) - drag.startScroll
  const dx = event.clientX - drag.startX + scrolled
  if (!drag.active) {
    if (Math.abs(dx) < DRAG_THRESHOLD) return
    drag.active = true
    dragging.value = true
    store.beginGesture()
  }
  const time = drag.origin + Math.round((dx / store.zoom) * MICROS_PER_SECOND)
  if (drag.mode === 'move') store.dragClipTo(drag.id, time, trackAt(event))
  else store.dragTrimTo(drag.id, drag.mode, time)
}

/** Spur unter dem Zeiger (für das Ziehen auf eine andere Spur). */
function trackAt(event: PointerEvent): string | undefined {
  if (typeof document.elementFromPoint !== 'function') return undefined
  const el = document.elementFromPoint(event.clientX, event.clientY)
  return el?.closest<HTMLElement>('[data-track]')?.dataset.track
}

function stopDrag(): void {
  window.removeEventListener('pointermove', onDragMove)
  window.removeEventListener('pointerup', onDragEnd)
  window.removeEventListener('pointercancel', onDragCancel)
  drag = null
  dragging.value = false
}

function onDragEnd(): void {
  if (drag?.active) store.endGesture()
  stopDrag()
}

function onDragCancel(): void {
  if (drag?.active) store.cancelGesture()
  stopDrag()
}

onBeforeUnmount(onDragCancel)

// --- Befehle (Knöpfe und Tastatur) ------------------------------------------

const root = ref<HTMLElement | null>(null)
/** Warum der letzte Befehl nichts bewirkt hat (kurzer Hinweis in der Leiste). */
const hint = ref('')

const HINTS: Partial<Record<OpError, string>> = {
  'track-locked': 'timeline.hint.locked',
  'too-short': 'timeline.hint.tooShort',
  'invalid-time': 'timeline.hint.nothingAtPlayhead',
  overlap: 'timeline.hint.overlap',
}

function run(command: () => boolean): void {
  if (command()) hint.value = ''
  else {
    const key = store.lastError ? HINTS[store.lastError] : undefined
    hint.value = key ? t(key) : ''
  }
}

const split = () => run(() => store.splitAtPlayhead())
const remove = (ripple: boolean) => run(() => store.removeSelection({ ripple }))

const canSplit = computed(() => store.splitTargets.length > 0)

function stepPlayhead(frames: number): void {
  const fps = store.doc.settings.fps
  const index = Math.round((store.playhead * fps) / MICROS_PER_SECOND) + frames
  store.seek(frameTime(Math.max(0, index), fps))
}

function onKeydown(event: KeyboardEvent): void {
  const mod = event.ctrlKey || event.metaKey
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key
  let handled = true
  if (key === 'Escape') {
    if (drag) onDragCancel()
    else store.select([])
  } else if (mod && key === 'z') {
    if (event.shiftKey) store.redo()
    else store.undo()
  } else if (mod && key === 'y') store.redo()
  else if (mod && key === 'a') store.selectAll()
  else if (mod || event.altKey) handled = false
  else if (key === 'Delete' || key === 'Backspace') remove(event.shiftKey)
  else if (key === 's') split()
  else if (key === 'ArrowLeft')
    stepPlayhead(event.shiftKey ? -Math.round(store.doc.settings.fps) : -1)
  else if (key === 'ArrowRight')
    stepPlayhead(event.shiftKey ? Math.round(store.doc.settings.fps) : 1)
  else if (key === 'Home') store.seek(0)
  else if (key === 'End') store.seek(store.duration)
  else handled = false
  if (handled) event.preventDefault()
}
</script>

<template>
  <section
    ref="root"
    class="timeline"
    :class="{ dragging }"
    data-testid="timeline"
    tabindex="0"
    :aria-label="t('timeline.label')"
    @keydown="onKeydown"
  >
    <div class="toolbar">
      <button
        type="button"
        class="tool"
        :disabled="!store.canUndo"
        :title="t('timeline.undo')"
        :aria-label="t('timeline.undo')"
        @click="store.undo()"
      >
        ↶
      </button>
      <button
        type="button"
        class="tool"
        :disabled="!store.canRedo"
        :title="t('timeline.redo')"
        :aria-label="t('timeline.redo')"
        @click="store.redo()"
      >
        ↷
      </button>
      <button
        type="button"
        class="tool wide"
        data-testid="timeline-split"
        :disabled="!canSplit"
        :title="t('timeline.splitTitle')"
        @click="split"
      >
        {{ t('timeline.split') }}
      </button>
      <button
        type="button"
        class="tool wide"
        data-testid="timeline-delete"
        :disabled="!store.selection.length"
        :title="t('timeline.removeTitle')"
        @click="remove(false)"
      >
        {{ t('timeline.remove') }}
      </button>
      <button
        type="button"
        class="tool wide"
        data-testid="timeline-ripple-delete"
        :disabled="!store.selection.length"
        :title="t('timeline.rippleRemoveTitle')"
        @click="remove(true)"
      >
        {{ t('timeline.rippleRemove') }}
      </button>
      <label class="snap" :title="t('timeline.snapTitle')">
        <input v-model="store.snapping" type="checkbox" data-testid="timeline-snap" />
        {{ t('timeline.snap') }}
      </label>
      <span class="time" data-testid="timeline-time">{{ timeText }}</span>
      <span v-if="hint" class="hint" role="status">{{ hint }}</span>
      <span class="spacer"></span>
      <button
        type="button"
        class="tool"
        :disabled="store.zoom <= MIN_ZOOM"
        :title="t('timeline.zoomOut')"
        :aria-label="t('timeline.zoomOut')"
        @click="zoomTo(store.zoom / ZOOM_STEP)"
      >
        −
      </button>
      <button
        type="button"
        class="tool"
        :disabled="store.zoom >= MAX_ZOOM"
        :title="t('timeline.zoomIn')"
        :aria-label="t('timeline.zoomIn')"
        @click="zoomTo(store.zoom * ZOOM_STEP)"
      >
        +
      </button>
      <button
        type="button"
        class="tool wide"
        data-testid="timeline-fit"
        :disabled="store.duration <= 0"
        @click="fit"
      >
        {{ t('timeline.fit') }}
      </button>
    </div>

    <p v-if="!store.doc.tracks.length" class="empty">{{ t('timeline.empty') }}</p>

    <div v-else ref="scroller" class="scroller" @scroll="measure" @wheel="onWheel">
      <div class="grid" :style="{ width: `${HEADER_WIDTH + contentWidth}px` }">
        <div class="row ruler-row">
          <div class="head corner" :style="{ width: `${HEADER_WIDTH}px` }"></div>
          <div
            class="ruler"
            data-testid="timeline-ruler"
            :style="{ width: `${contentWidth}px` }"
            @pointerdown="onRulerDown"
            @pointermove="onRulerMove"
          >
            <span
              v-for="tick in ticks"
              :key="tick.time"
              class="tick"
              :class="{ major: tick.major }"
              :style="{ left: `${tick.left}px` }"
            >
              <span v-if="tick.label" class="tick-label">{{ tick.label }}</span>
            </span>
          </div>
        </div>

        <div
          v-for="track in store.doc.tracks"
          :key="track.id"
          class="row track"
          :data-kind="track.kind"
          :data-track="track.id"
          :style="{ height: `${TRACK_HEIGHT[track.kind]}px` }"
        >
          <div class="head" :style="{ width: `${HEADER_WIDTH}px` }">
            <span class="track-name">{{ track.name }}</span>
            <span class="track-kind">{{ t(`timeline.kind.${track.kind}`) }}</span>
          </div>
          <div
            class="lane"
            :style="{ width: `${contentWidth}px` }"
            @pointerdown.self="store.select([])"
          >
            <TimelineClip
              v-for="clip in track.clips"
              :key="clip.id"
              :clip="clip"
              :zoom="store.zoom"
              :height="TRACK_HEIGHT[track.kind]"
              :selected="store.selection.includes(clip.id)"
              :locked="track.locked"
              @grab="onGrab"
            />
          </div>
        </div>

        <div
          class="playhead"
          data-testid="timeline-playhead"
          :style="{ left: `${playheadLeft}px` }"
        ></div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.timeline {
  display: flex;
  flex-direction: column;
  gap: var(--ds-space-2);
  padding: var(--ds-space-3);
  border: 1px solid var(--ds-border);
  border-radius: var(--ds-radius-lg);
  background: var(--ds-surface-1);
}
.toolbar {
  display: flex;
  align-items: center;
  gap: var(--ds-space-2);
}
.timeline:focus-visible {
  outline: none;
  box-shadow: var(--ds-focus-ring);
}
.timeline.dragging,
.timeline.dragging :deep(.clip) {
  cursor: grabbing;
}
.spacer {
  flex: 1;
}
.snap {
  display: inline-flex;
  align-items: center;
  gap: var(--ds-space-1);
  font-size: var(--ds-text-sm);
  color: var(--ds-text-2);
  cursor: pointer;
}
.hint {
  font-size: var(--ds-text-sm);
  color: var(--ds-danger);
}
.toolbar {
  flex-wrap: wrap;
}
.tool {
  min-width: var(--ds-control-sm);
  height: var(--ds-control-sm);
  padding: 0 var(--ds-space-2);
  border: 1px solid var(--ds-border);
  border-radius: var(--ds-radius-md);
  background: var(--ds-surface-2);
  color: var(--ds-text);
  cursor: pointer;
}
.tool.wide {
  padding: 0 var(--ds-space-3);
  font-size: var(--ds-text-sm);
}
.tool:hover:not(:disabled) {
  border-color: var(--ds-accent);
}
.tool:disabled {
  opacity: 0.45;
  cursor: default;
}
.tool:focus-visible {
  outline: none;
  box-shadow: var(--ds-focus-ring);
}
.time {
  margin-left: var(--ds-space-2);
  font-family: var(--ds-font-mono);
  font-size: var(--ds-text-sm);
  font-variant-numeric: tabular-nums;
  color: var(--ds-text-2);
}
.empty {
  margin: 0;
  padding: var(--ds-space-6);
  border: 1px dashed var(--ds-border);
  border-radius: var(--ds-radius-md);
  color: var(--ds-text-2);
  font-size: var(--ds-text-sm);
  text-align: center;
}
.scroller {
  overflow-x: auto;
  overflow-y: hidden;
  border: 1px solid var(--ds-border);
  border-radius: var(--ds-radius-md);
  background: var(--ds-surface-0);
}
.grid {
  position: relative;
}
.row {
  display: flex;
}
.row + .row {
  border-top: 1px solid var(--ds-border);
}
.head {
  position: sticky;
  left: 0;
  z-index: 3;
  flex: none;
  display: flex;
  flex-direction: column;
  justify-content: center;
  padding: 0 var(--ds-space-2);
  border-right: 1px solid var(--ds-border);
  background: var(--ds-surface-2);
  box-sizing: border-box;
}
.track-name {
  font-size: var(--ds-text-sm);
  font-weight: var(--ds-weight-semibold);
}
.track-kind {
  font-size: var(--ds-text-xs);
  color: var(--ds-text-3);
}
.ruler-row {
  height: 28px;
}
.ruler {
  position: relative;
  flex: none;
  cursor: pointer;
  touch-action: none;
  user-select: none;
}
.tick {
  position: absolute;
  bottom: 0;
  height: 6px;
  border-left: 1px solid var(--ds-border-strong);
}
.tick.major {
  height: 12px;
}
.tick-label {
  position: absolute;
  bottom: 12px;
  left: 3px;
  font-size: var(--ds-text-xs);
  font-variant-numeric: tabular-nums;
  color: var(--ds-text-2);
  white-space: nowrap;
}
.lane {
  position: relative;
  flex: none;
}
.playhead {
  position: absolute;
  top: 0;
  bottom: 0;
  z-index: 2;
  width: 2px;
  margin-left: -1px;
  background: var(--vc-playhead);
  pointer-events: none;
}
</style>
