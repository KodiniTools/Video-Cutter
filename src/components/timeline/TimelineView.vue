<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import TimelineClip from './TimelineClip.vue'
import { formatTimeMs } from '@/lib/timeFormat'
import { MAX_ZOOM, MIN_ZOOM, useTimelineStore } from '@/stores/timeline'
import { fitZoom, pxToTime, rulerTicks, timeToPx } from '@/timeline/layout'
import { timeToSeconds, type TrackKind } from '@/timeline/model'

/**
 * Mehrspur-Timeline: Lineal, Spuren mit Clips, Abspielkopf, Zoom und Auswahl.
 * Bearbeiten per Maus (Ziehen, Trimmen) folgt im nächsten Schritt.
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

// --- Auswahl -----------------------------------------------------------------

function onSelect(id: string, toggle: boolean): void {
  if (toggle) store.toggleSelected(id)
  else store.select([id])
}
</script>

<template>
  <section class="timeline" data-testid="timeline">
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
      <span class="time" data-testid="timeline-time">{{ timeText }}</span>
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
      <button type="button" class="tool wide" :disabled="store.duration <= 0" @click="fit">
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
              @select="onSelect"
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
.spacer {
  flex: 1;
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
