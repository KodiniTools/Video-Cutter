<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { containedVideoBox } from '@/lib/cropGeometry'
import {
  fontPreview,
  overlayFrame,
  type OverlayFrame,
  type TextOverlay,
  type TextOverlayData,
} from '@/lib/textOverlay'

/**
 * Vorschau der Text-Einblendungen über dem Video. Liegt exakt auf der
 * sichtbaren Bildfläche (wie der Bildausschnitt), alle Maße sind Anteile der
 * Bildhöhe – dadurch entspricht die Vorschau dem eingebrannten Ergebnis.
 * Texte lassen sich mit der Maus/dem Finger verschieben.
 */
const props = defineProps<{
  overlays: TextOverlay[]
  selectedId: number | null
  target: HTMLVideoElement | null
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

/** Wiedergabezeit flüssig (pro Frame) mitlesen, damit Animationen sichtbar sind. */
function tick(): void {
  const el = props.target
  if (el && el.currentTime !== time.value) time.value = el.currentTime
  if (el && el.paused !== paused.value) paused.value = el.paused
  raf = requestAnimationFrame(tick)
}

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

raf = requestAnimationFrame(tick)
onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  detach()
})

interface Rendered {
  o: TextOverlay
  frame: OverlayFrame
  style: Record<string, string>
  textStyle: Record<string, string>
  lineStyle: Record<string, string>
  lines: { ch: string; hidden: boolean }[][]
}

/** CSS für Stil/Farbe – Maße relativ zur Schriftgröße `px` (wie der Server). */
function lookCss(o: TextOverlayData, px: number): Record<string, string> {
  switch (o.style) {
    case 'outline':
      return {
        // Kontur liegt zur Hälfte innen -> doppelte Breite, Füllung darüber.
        webkitTextStroke: `${Math.max(1, px * 0.08) * 2}px ${o.accent}`,
        paintOrder: 'stroke fill',
      }
    case 'box':
      // Box wird je Zeile gezeichnet (wie libass), siehe lineCss.
      return {}
    case 'shadow': {
      const s = Math.max(1, px * 0.06)
      return { textShadow: `${s}px ${s}px 0 ${o.accent}bf` }
    }
    case 'none':
      return {}
    default: {
      const never: never = o.style
      throw new Error(`Unbekannter Stil: ${String(never)}`)
    }
  }
}

/** Box-Stil: libass zeichnet je Zeile ein eigenes Rechteck (Glyphen + Rand). */
function lineCss(o: TextOverlayData, px: number): Record<string, string> {
  if (o.style !== 'box') return {}
  const pad = Math.max(2, px * 0.2)
  return {
    background: o.accent,
    padding: `${pad}px`,
    boxDecorationBreak: 'clone',
    webkitBoxDecorationBreak: 'clone',
  }
}

const rendered = computed<Rendered[]>(() => {
  const h = box.value.height
  if (!(h > 0)) return []
  const t = time.value
  return props.overlays.flatMap((o) => {
    const isSel = o.id === props.selectedId
    // Angehalten + gewählt: ruhende Ansicht ohne Animation, damit Design und
    // Position beim Bearbeiten sichtbar sind. Außerhalb des Zeitbereichs blass.
    const animated = overlayFrame(o, t)
    const frame: OverlayFrame =
      isSel && paused.value
        ? { visible: animated.visible, opacity: 1, dy: 0, scale: 1, chars: Infinity }
        : animated
    if (!frame.visible && !isSel) return []
    const px = o.size * h
    const font = fontPreview(o.font)
    let k = 0
    const lines = o.text.split('\n').map((line) =>
      Array.from(line).map((ch) => {
        const idx = k++
        return { ch, hidden: frame.visible && idx >= frame.chars }
      }),
    )
    return [
      {
        o,
        frame,
        style: {
          left: `${o.x * 100}%`,
          top: `${(o.y + frame.dy) * 100}%`,
          opacity: String(frame.visible ? frame.opacity : 0.35),
          transform: `translate(-50%, -50%) scale(${frame.scale})`,
        },
        textStyle: {
          fontFamily: `'${font.css}'`,
          fontSize: `${px}px`,
          lineHeight: String(font.lineRatio),
          top: `${font.shift * px}px`,
          color: o.color,
          ...lookCss(o, px),
        },
        lineStyle: lineCss(o, px),
        lines,
      },
    ]
  })
})

// --- Verschieben -------------------------------------------------------------
let drag: { id: number; startX: number; startY: number; x: number; y: number } | null = null

function onPointerDown(o: TextOverlay, ev: PointerEvent): void {
  emit('select', o.id)
  if (props.disabled) return
  ev.preventDefault()
  drag = { id: o.id, startX: ev.clientX, startY: ev.clientY, x: o.x, y: o.y }
  ;(ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId)
}

function onPointerMove(ev: PointerEvent): void {
  if (!drag) return
  const { width, height } = box.value
  if (!(width > 0 && height > 0)) return
  const clamp = (v: number) => Math.min(1, Math.max(0, v))
  emit('move', drag.id, {
    x: clamp(drag.x + (ev.clientX - drag.startX) / width),
    y: clamp(drag.y + (ev.clientY - drag.startY) / height),
  })
}

function onPointerUp(): void {
  drag = null
}
</script>

<template>
  <div
    class="text-layer"
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
      class="text-item"
      :class="{ selected: r.o.id === selectedId, disabled }"
      :style="r.style"
      @pointerdown="onPointerDown(r.o, $event)"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
    >
      <span class="text-body" :style="r.textStyle"
        ><template v-for="(line, li) in r.lines" :key="li"
          ><br v-if="li > 0" /><span class="text-line" :style="r.lineStyle"
            ><span v-for="(c, ci) in line" :key="ci" :class="{ hidden: c.hidden }">{{
              c.ch
            }}</span></span
          ></template
        ></span
      >
    </div>
  </div>
</template>

<style>
/* Dieselben Schriften wie der Server (server/fonts) – Vorschau = Ergebnis. */
@font-face {
  font-family: 'VC Roboto';
  src: url('../../server/fonts/Roboto-Bold.ttf') format('truetype');
  font-display: swap;
}
@font-face {
  font-family: 'VC Montserrat';
  src: url('../../server/fonts/Montserrat-ExtraBold.ttf') format('truetype');
  font-display: swap;
}
@font-face {
  font-family: 'VC Bebas Neue';
  src: url('../../server/fonts/BebasNeue-Regular.ttf') format('truetype');
  font-display: swap;
}
@font-face {
  font-family: 'VC Lora';
  src: url('../../server/fonts/Lora-Bold.ttf') format('truetype');
  font-display: swap;
}
@font-face {
  font-family: 'VC Pacifico';
  src: url('../../server/fonts/Pacifico-Regular.ttf') format('truetype');
  font-display: swap;
}
</style>

<style scoped>
.text-layer {
  position: absolute;
  pointer-events: none;
  overflow: hidden;
}

.text-item {
  position: absolute;
  pointer-events: auto;
  cursor: move;
  touch-action: none;
  user-select: none;
  white-space: pre;
  text-align: center;
  border-radius: 2px;
}

.text-item.disabled {
  cursor: default;
}

.text-item.selected {
  outline: 2px dashed var(--ds-accent);
  outline-offset: 4px;
}

.text-body {
  position: relative;
  display: inline-block;
  font-weight: normal;
}

.hidden {
  visibility: hidden;
}
</style>
