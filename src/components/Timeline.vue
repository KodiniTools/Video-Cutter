<script setup lang="ts">
import { ref, computed } from 'vue'
import { formatDisplayTime } from '@/lib/ffmpegCommand'

const props = defineProps<{
  duration: number
  start: number
  end: number
  current: number
}>()

const emit = defineEmits<{
  (e: 'update:start', v: number): void
  (e: 'update:end', v: number): void
  (e: 'seek', v: number): void
}>()

const track = ref<HTMLDivElement | null>(null)
type DragTarget = 'start' | 'end' | null
const dragging = ref<DragTarget>(null)

const pct = (t: number) => (props.duration > 0 ? (t / props.duration) * 100 : 0)
const startPct = computed(() => pct(props.start))
const endPct = computed(() => pct(props.end))
const currentPct = computed(() => pct(props.current))
const rangeStyle = computed(() => ({
  left: `${startPct.value}%`,
  width: `${Math.max(0, endPct.value - startPct.value)}%`,
}))

function timeFromClientX(clientX: number): number {
  const el = track.value
  if (!el || props.duration <= 0) return 0
  const rect = el.getBoundingClientRect()
  const ratio = (clientX - rect.left) / rect.width
  return Math.min(props.duration, Math.max(0, ratio * props.duration))
}

function onHandleDown(target: 'start' | 'end', ev: PointerEvent): void {
  ev.preventDefault()
  ev.stopPropagation()
  dragging.value = target
  ;(ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId)
}

function onPointerMove(ev: PointerEvent): void {
  if (!dragging.value) return
  const t = timeFromClientX(ev.clientX)
  if (dragging.value === 'start') emit('update:start', t)
  else emit('update:end', t)
  // Vorschau live auf die gezogene Griff-Position setzen.
  emit('seek', t)
}

function onPointerUp(): void {
  dragging.value = null
}

function onTrackDown(ev: PointerEvent): void {
  if (dragging.value) return
  emit('seek', timeFromClientX(ev.clientX))
}

// Tastaturbedienung der Griffe (1 s Schritt, 5 s mit Shift).
function nudge(target: 'start' | 'end', dir: -1 | 1, ev: KeyboardEvent): void {
  const step = ev.shiftKey ? 5 : 1
  const v = (target === 'start' ? props.start : props.end) + dir * step
  if (target === 'start') emit('update:start', v)
  else emit('update:end', v)
  // Vorschau live mitführen.
  emit('seek', v)
}
</script>

<template>
  <div
    class="timeline"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointerleave="onPointerUp"
  >
    <div ref="track" class="track" @pointerdown="onTrackDown">
      <div class="range" :style="rangeStyle"></div>
      <div class="playhead" :style="{ left: `${currentPct}%` }"></div>

      <button
        class="handle handle-start"
        type="button"
        :style="{ left: `${startPct}%` }"
        :aria-label="`Startpunkt ${formatDisplayTime(start)}`"
        @pointerdown="onHandleDown('start', $event)"
        @keydown.left.prevent="nudge('start', -1, $event)"
        @keydown.right.prevent="nudge('start', 1, $event)"
      ></button>

      <button
        class="handle handle-end"
        type="button"
        :style="{ left: `${endPct}%` }"
        :aria-label="`Endpunkt ${formatDisplayTime(end)}`"
        @pointerdown="onHandleDown('end', $event)"
        @keydown.left.prevent="nudge('end', -1, $event)"
        @keydown.right.prevent="nudge('end', 1, $event)"
      ></button>
    </div>

    <div class="scale">
      <span>{{ formatDisplayTime(0) }}</span>
      <span>{{ formatDisplayTime(duration) }}</span>
    </div>
  </div>
</template>

<style scoped>
.timeline {
  width: 100%;
  user-select: none;
  touch-action: none;
}

.track {
  position: relative;
  height: 40px;
  border-radius: 8px;
  background: var(--vc-track-bg);
  cursor: pointer;
  overflow: visible;
}

.range {
  position: absolute;
  top: 0;
  bottom: 0;
  background: var(--vc-accent-soft);
  border-top: 2px solid var(--vc-accent);
  border-bottom: 2px solid var(--vc-accent);
  pointer-events: none;
}

.playhead {
  position: absolute;
  top: -4px;
  bottom: -4px;
  width: 2px;
  background: var(--vc-playhead);
  transform: translateX(-1px);
  pointer-events: none;
}

.handle {
  position: absolute;
  top: 50%;
  width: 14px;
  height: 52px;
  padding: 0;
  transform: translate(-50%, -50%);
  border: none;
  border-radius: 5px;
  background: var(--vc-accent);
  cursor: ew-resize;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.4);
}

.handle::after {
  content: '';
  position: absolute;
  inset: 0;
  margin: auto;
  width: 2px;
  height: 20px;
  background: rgba(255, 255, 255, 0.75);
  border-radius: 2px;
}

.handle:focus-visible {
  outline: 2px solid var(--vc-focus);
  outline-offset: 2px;
}

.scale {
  display: flex;
  justify-content: space-between;
  margin-top: 6px;
  font-size: 12px;
  color: var(--vc-text-dim);
  font-variant-numeric: tabular-nums;
}
</style>
