<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { containedVideoBox } from '@/lib/cropGeometry'
import { nudgePosition } from '@/lib/textOverlay'
import {
  graphicFrame,
  lookKey,
  renderGraphic,
  stackOrder,
  type GraphicFrame,
  type GraphicOverlay,
} from '@/lib/graphicOverlay'

/**
 * Vorschau der Grafiken (Formen, Linien, Symbole, Emojis) über dem Video.
 * Zeigt exakt das Bild, das beim Einbrennen als PNG an den Server geht
 * (gezeichnet für die echte Videohöhe, nur verkleinert dargestellt).
 * Grafiken lassen sich wie Texte verschieben (Maus/Finger, Pfeiltasten).
 */
const props = defineProps<{
  overlays: GraphicOverlay[]
  selectedId: number | null
  target: HTMLVideoElement | null
  /** Bildhöhe des Videos in px (wie auf dem Server); 0 = aus dem Video-Element. */
  frameHeight: number
  disabled?: boolean
}>()

const emit = defineEmits<{
  (e: 'select', id: number): void
  (e: 'move', id: number, pos: { x: number; y: number }): void
}>()

const box = ref({ left: 0, top: 0, width: 0, height: 0 })
const time = ref(0)
const paused = ref(true)
let observer: ResizeObserver | null = null
let observed: HTMLVideoElement | null = null
let raf = 0

function measure(): void {
  const el = props.target
  if (!el) return
  box.value = containedVideoBox(
    { left: el.offsetLeft, top: el.offsetTop, width: el.offsetWidth, height: el.offsetHeight },
    el.videoWidth,
    el.videoHeight,
  )
}

function tick(): void {
  const el = props.target
  if (el && el.currentTime !== time.value) time.value = el.currentTime
  if (el && el.paused !== paused.value) paused.value = el.paused
  raf = requestAnimationFrame(tick)
}

const MEDIA_EVENTS = ['loadedmetadata', 'resize'] as const
const videoHeight = ref(0)

function onMeta(): void {
  videoHeight.value = props.target?.videoHeight ?? 0
  measure()
}

function detach(): void {
  observer?.disconnect()
  observer = null
  if (observed) {
    for (const ev of MEDIA_EVENTS) observed.removeEventListener(ev, onMeta)
    observed = null
  }
}

watch(
  () => props.target,
  (el) => {
    detach()
    if (!el) return
    observed = el
    for (const ev of MEDIA_EVENTS) el.addEventListener(ev, onMeta)
    observer = new ResizeObserver(measure)
    observer.observe(el)
    onMeta()
  },
  { immediate: true },
)

raf = requestAnimationFrame(tick)
onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  detach()
})

/** Zeichenhöhe: echte Videohöhe (wie beim Einbrennen), höchstens 4K. */
const renderH = computed(() => {
  const h = props.frameHeight > 0 ? props.frameHeight : videoHeight.value || 720
  return Math.min(2160, Math.round(h))
})

// Bild-Cache je Grafik: nur neu zeichnen, wenn sich das Aussehen ändert.
const cache = new Map<
  number,
  { key: string; url: string; width: number; height: number; H: number }
>()

/**
 * Fotos werden für die Vorschau nur in Anzeigegröße gezeichnet (große PNGs
 * zu kodieren wäre beim Ziehen der Regler zu langsam); eingebrannt wird in
 * voller Videohöhe. Formen bleiben pixelgenau in Videohöhe.
 */
function previewH(o: GraphicOverlay, H: number, boxH: number): number {
  if (o.kind !== 'image') return H
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
  return Math.min(H, Math.max(1, Math.round(boxH * dpr)))
}

function imageFor(o: GraphicOverlay, H: number) {
  const key = lookKey(o, H)
  const hit = cache.get(o.id)
  if (hit && hit.key === key) return hit
  const canvas = renderGraphic(o, H)
  const entry = {
    key,
    url: canvas.toDataURL('image/png'),
    width: canvas.width,
    height: canvas.height,
    H,
  }
  cache.set(o.id, entry)
  return entry
}

watch(
  () => props.overlays.map((o) => o.id),
  (ids) => {
    for (const id of cache.keys()) if (!ids.includes(id)) cache.delete(id)
  },
)

interface Rendered {
  o: GraphicOverlay
  frame: GraphicFrame
  url: string
  style: Record<string, string>
}

const rendered = computed<Rendered[]>(() => {
  const bh = box.value.height
  if (!(bh > 0)) return []
  const H = renderH.value
  const t = time.value
  return stackOrder(props.overlays).flatMap((o) => {
    const isSel = o.id === props.selectedId
    const animated = graphicFrame(o, t)
    // Angehalten: ruhende Ansicht für alle Grafiken im Zeitbereich (wie bei Texten).
    const frame: GraphicFrame =
      paused.value && (isSel || animated.visible)
        ? { visible: animated.visible, opacity: 1, dy: 0 }
        : animated
    if (!frame.visible && !isSel) return []
    const img = imageFor(o, previewH(o, H, bh))
    const scale = bh / img.H
    return [
      {
        o,
        frame,
        url: img.url,
        style: {
          left: `${o.x * 100}%`,
          top: `${(o.y + frame.dy) * 100}%`,
          width: `${img.width * scale}px`,
          height: `${img.height * scale}px`,
          opacity: String(frame.visible ? frame.opacity : 0.35),
        },
      },
    ]
  })
})

// --- Verschieben (wie TextOverlayLayer) ---------------------------------------
let drag: { id: number; lastX: number; lastY: number; x: number; y: number } | null = null
const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
const FINE_DRAG = 0.2

function onPointerDown(o: GraphicOverlay, ev: PointerEvent): void {
  emit('select', o.id)
  if (props.disabled) return
  ev.preventDefault()
  const el = ev.currentTarget as HTMLElement
  el.focus({ preventScroll: true })
  drag = { id: o.id, lastX: ev.clientX, lastY: ev.clientY, x: o.x, y: o.y }
  el.setPointerCapture(ev.pointerId)
}

function onPointerMove(ev: PointerEvent): void {
  if (!drag) return
  const { width, height } = box.value
  if (!(width > 0 && height > 0)) return
  const f = ev.shiftKey ? FINE_DRAG : 1
  drag.x = clamp01(drag.x + ((ev.clientX - drag.lastX) * f) / width)
  drag.y = clamp01(drag.y + ((ev.clientY - drag.lastY) * f) / height)
  drag.lastX = ev.clientX
  drag.lastY = ev.clientY
  emit('move', drag.id, { x: drag.x, y: drag.y })
}

function onKeydown(o: GraphicOverlay, ev: KeyboardEvent): void {
  if (props.disabled) return
  const next = nudgePosition(o, ev.key, ev.shiftKey)
  if (!next) return
  ev.preventDefault()
  ev.stopPropagation()
  emit('move', o.id, next)
}

function onPointerUp(): void {
  drag = null
}
</script>

<template>
  <div
    class="graphic-layer"
    :style="{
      left: `${box.left}px`,
      top: `${box.top}px`,
      width: `${box.width}px`,
      height: `${box.height}px`,
    }"
  >
    <div
      v-for="r in rendered"
      :key="r.o.id"
      class="graphic-item"
      :class="{ selected: r.o.id === selectedId, disabled }"
      :style="r.style"
      tabindex="0"
      @pointerdown="onPointerDown(r.o, $event)"
      @keydown="onKeydown(r.o, $event)"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
    >
      <img :src="r.url" alt="" draggable="false" />
    </div>
  </div>
</template>

<style scoped>
.graphic-layer {
  position: absolute;
  pointer-events: none;
  overflow: hidden;
}

.graphic-item {
  position: absolute;
  pointer-events: auto;
  cursor: move;
  touch-action: none;
  user-select: none;
  transform: translate(-50%, -50%);
}

.graphic-item img {
  display: block;
  width: 100%;
  height: 100%;
  pointer-events: none;
}

.graphic-item.disabled {
  cursor: default;
}

.graphic-item:focus {
  outline: none;
}
.graphic-item.selected {
  outline: 2px dashed var(--ds-accent);
  outline-offset: 2px;
}
.graphic-item.selected:focus-visible,
.graphic-item.selected:focus {
  outline-style: solid;
}
</style>
