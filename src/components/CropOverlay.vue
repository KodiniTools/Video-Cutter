<script setup lang="ts">
import { ref, watch, onBeforeUnmount } from 'vue'
import type { CropRect } from '@/stores/videoEditor'
import { MIN_CROP_RATIO } from '@/stores/videoEditor'
import { containedVideoBox } from '@/lib/cropGeometry'

const props = defineProps<{
  modelValue: CropRect
  disabled?: boolean
  /** Das Video-Element, dessen sichtbare Box exakt nachgebildet wird. */
  target: HTMLVideoElement | null
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', v: CropRect): void
}>()

const root = ref<HTMLDivElement | null>(null)

// Die tatsächlich SICHTBARE Bildfläche nachbilden – nicht die Element-Box:
// `.player` hat `width:100%` + `max-height`, daher ist die Box oft breiter
// (oder höher) als das Bild, und das Video sitzt zentriert mit schwarzen
// Rändern darin (`object-fit: contain`). Läge der Overlay auf der ganzen Box,
// wären die Anteilswerte gegenüber dem Bildinhalt verschoben und falsch
// skaliert – der Server schneidet dann einen anderen Bereich aus.
const box = ref({ left: 0, top: 0, width: 0, height: 0 })
let observer: ResizeObserver | null = null
let observed: HTMLVideoElement | null = null

function measure(): void {
  const el = props.target
  if (!el) return
  box.value = containedVideoBox(
    { left: el.offsetLeft, top: el.offsetTop, width: el.offsetWidth, height: el.offsetHeight },
    el.videoWidth,
    el.videoHeight,
  )
}

// Intrinsische Größe ändert sich beim Laden (loadedmetadata) und bei einem
// Quellenwechsel (`resize`-Media-Event) -> neu messen.
const MEDIA_EVENTS = ['loadedmetadata', 'resize'] as const

function detach(): void {
  observer?.disconnect()
  observer = null
  if (observed) {
    for (const ev of MEDIA_EVENTS) observed.removeEventListener(ev, measure)
    observed = null
  }
}

watch(
  () => props.target,
  (el) => {
    detach()
    if (!el) return
    observed = el
    for (const ev of MEDIA_EVENTS) el.addEventListener(ev, measure)
    observer = new ResizeObserver(measure)
    observer.observe(el)
    measure()
  },
  { immediate: true },
)

onBeforeUnmount(detach)

type Handle = 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'sw' | 'se'
type DragMode = 'move' | Handle | null

const dragMode = ref<DragMode>(null)
let dragStartX = 0
let dragStartY = 0
let dragStartRect: CropRect = { x: 0, y: 0, width: 0, height: 0 }

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v))
}

function startDrag(mode: DragMode, ev: PointerEvent): void {
  if (props.disabled || !mode) return
  ev.preventDefault()
  ev.stopPropagation()
  dragMode.value = mode
  dragStartX = ev.clientX
  dragStartY = ev.clientY
  dragStartRect = { ...props.modelValue }
  ;(ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId)
}

/** Wendet eine Ziehbewegung (in Anteilen der Containergröße) auf das Start-Rechteck an. */
function applyDrag(mode: Exclude<DragMode, null>, dx: number, dy: number): CropRect {
  const s = dragStartRect
  if (mode === 'move') {
    const x = clamp01(Math.min(s.x + dx, 1 - s.width))
    const y = clamp01(Math.min(s.y + dy, 1 - s.height))
    return { x, y, width: s.width, height: s.height }
  }

  let { x, y, width, height } = s

  if (mode.includes('e')) {
    width = Math.min(1 - s.x, Math.max(MIN_CROP_RATIO, s.width + dx))
  }
  if (mode.includes('w')) {
    const newX = Math.min(s.x + s.width - MIN_CROP_RATIO, Math.max(0, s.x + dx))
    width = s.x + s.width - newX
    x = newX
  }
  if (mode.includes('s')) {
    height = Math.min(1 - s.y, Math.max(MIN_CROP_RATIO, s.height + dy))
  }
  if (mode.includes('n')) {
    const newY = Math.min(s.y + s.height - MIN_CROP_RATIO, Math.max(0, s.y + dy))
    height = s.y + s.height - newY
    y = newY
  }

  return { x, y, width, height }
}

function onPointerMove(ev: PointerEvent): void {
  const mode = dragMode.value
  if (!mode) return
  const rect = root.value?.getBoundingClientRect()
  if (!rect || rect.width <= 0 || rect.height <= 0) return
  const dx = (ev.clientX - dragStartX) / rect.width
  const dy = (ev.clientY - dragStartY) / rect.height
  emit('update:modelValue', applyDrag(mode, dx, dy))
}

function onPointerUp(): void {
  dragMode.value = null
}

const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']
</script>

<template>
  <div
    ref="root"
    class="crop-overlay"
    :class="{ disabled }"
    :style="{
      left: `${box.left}px`,
      top: `${box.top}px`,
      width: `${box.width}px`,
      height: `${box.height}px`,
    }"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
  >
    <div class="crop-shade crop-shade-top" :style="{ height: `${modelValue.y * 100}%` }"></div>
    <div
      class="crop-shade crop-shade-bottom"
      :style="{ height: `${(1 - modelValue.y - modelValue.height) * 100}%` }"
    ></div>
    <div
      class="crop-shade crop-shade-left"
      :style="{
        top: `${modelValue.y * 100}%`,
        height: `${modelValue.height * 100}%`,
        width: `${modelValue.x * 100}%`,
      }"
    ></div>
    <div
      class="crop-shade crop-shade-right"
      :style="{
        top: `${modelValue.y * 100}%`,
        height: `${modelValue.height * 100}%`,
        width: `${(1 - modelValue.x - modelValue.width) * 100}%`,
      }"
    ></div>

    <div
      class="crop-rect"
      :style="{
        left: `${modelValue.x * 100}%`,
        top: `${modelValue.y * 100}%`,
        width: `${modelValue.width * 100}%`,
        height: `${modelValue.height * 100}%`,
      }"
      @pointerdown="startDrag('move', $event)"
    >
      <button
        v-for="h in HANDLES"
        :key="h"
        type="button"
        class="crop-handle"
        :class="`crop-handle-${h}`"
        tabindex="-1"
        @pointerdown="startDrag(h, $event)"
      ></button>
    </div>
  </div>
</template>

<style scoped>
.crop-overlay {
  position: absolute;
  touch-action: none;
  /* Nur Rechteck + Griffe fangen Zeiger ab, damit die nativen Video-Controls
     außerhalb des Ausschnitts weiter klickbar bleiben. */
  pointer-events: none;
}
.crop-overlay.disabled .crop-rect,
.crop-overlay.disabled .crop-handle {
  pointer-events: none;
  cursor: default;
}

.crop-shade {
  position: absolute;
  background: rgba(0, 0, 0, 0.45);
  pointer-events: none;
}
.crop-shade-top {
  top: 0;
  left: 0;
  right: 0;
}
.crop-shade-bottom {
  bottom: 0;
  left: 0;
  right: 0;
}
.crop-shade-left {
  left: 0;
}
.crop-shade-right {
  right: 0;
}

.crop-rect {
  position: absolute;
  border: 2px solid #e11d48;
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.6);
  cursor: move;
  pointer-events: auto;
}

.crop-handle {
  position: absolute;
  width: 14px;
  height: 14px;
  padding: 0;
  border: 2px solid #e11d48;
  border-radius: 50%;
  background: #fff;
  transform: translate(-50%, -50%);
  pointer-events: auto;
}
.crop-handle-nw {
  left: 0;
  top: 0;
  cursor: nwse-resize;
}
.crop-handle-ne {
  left: 100%;
  top: 0;
  cursor: nesw-resize;
}
.crop-handle-sw {
  left: 0;
  top: 100%;
  cursor: nesw-resize;
}
.crop-handle-se {
  left: 100%;
  top: 100%;
  cursor: nwse-resize;
}
.crop-handle-n {
  left: 50%;
  top: 0;
  cursor: ns-resize;
}
.crop-handle-s {
  left: 50%;
  top: 100%;
  cursor: ns-resize;
}
.crop-handle-e {
  left: 100%;
  top: 50%;
  cursor: ew-resize;
}
.crop-handle-w {
  left: 0;
  top: 50%;
  cursor: ew-resize;
}
</style>
