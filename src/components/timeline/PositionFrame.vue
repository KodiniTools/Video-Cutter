<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { renderGraphic } from '@/lib/graphicOverlay'
import { DEFAULT_TEXT_STYLE, fontPreview, type TextFont } from '@/lib/textOverlay'
import { useTimelineStore } from '@/stores/timeline'
import { clipGraphic, isDrawable } from '@/timeline/graphics'
import { clipEnd, MIN_LAYOUT_SCALE, type VideoClip } from '@/timeline/model'
import {
  containRect,
  dragPosition,
  layoutBox,
  nudgePoint,
  resizeScale,
  tidyPoint,
  type Point,
  type Rect,
} from '@/timeline/positionFrame'

/**
 * Positionsrahmen über der Vorschau: Der markierte Text, die Form oder das
 * Bild lässt sich direkt im Bild verschieben (Maus, mit Umschalttaste fein,
 * oder Pfeiltasten). Das Bild selbst kommt vom Server; während des Ziehens
 * zeigt der Rahmen, wohin das Element kommt (Formen und Bilder als blasse
 * Kopie), nach dem Loslassen rendert der Server den Abschnitt neu.
 * Dasselbe gilt für einen verkleinerten Video-Clip (Bild-in-Bild): Der Rahmen
 * liegt um sein Bild, der Griff unten rechts ändert die Größe.
 */

const { t } = useI18n()
const store = useTimelineStore()

const root = ref<HTMLElement | null>(null)
const ghost = ref<HTMLCanvasElement | null>(null)
const box = ref({ width: 0, height: 0 })

/** Der verkleinerte Video-Clip (Bild-in-Bild), wenn nur er (samt verknüpftem Ton) markiert ist. */
const video = computed<VideoClip | null>(() => {
  const all = store.selectedClips
  const videos = all.filter((c): c is VideoClip => c.kind === 'video' || c.kind === 'still')
  if (videos.length !== 1 || all.length > 2) return null
  const [v] = videos
  const other = all.find((c) => c !== v)
  if (other && (other.kind !== 'audio' || !v.linkGroup || other.linkGroup !== v.linkGroup)) {
    return null
  }
  return v.layout && v.layout.scale < 1 ? v : null
})

/** Der Clip auf einer Ebenen-Spur, wenn genau einer markiert ist; sonst der verkleinerte Video-Clip. */
const clip = computed(() => {
  const [only, ...rest] = store.selectedClips
  return only && rest.length === 0 && (only.kind === 'text' || only.kind === 'graphic')
    ? only
    : video.value
})

/** Lage des Bildes im Player (eingepasst, mit schwarzen Rändern drumherum). */
const picture = computed<Rect>(() =>
  containRect(
    box.value.width,
    box.value.height,
    store.doc.settings.width,
    store.doc.settings.height,
  ),
)

const num = (v: unknown, fallback: number) =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback

const graphic = computed(() =>
  clip.value?.kind === 'graphic' ? clipGraphic(clip.value.data) : null,
)

/** Größe beim Ziehen am Griff (sonst die des Dokuments). */
const resize = ref<{ from: number; scale: number } | null>(null)

/** Bild des verkleinerten Clips im Projektformat (Mitte und Größe als Anteile). */
const videoBox = computed(() => {
  const v = video.value
  if (!v?.layout) return null
  const asset = store.doc.assets[v.asset]
  const { width, height } = store.doc.settings
  const srcW = (asset?.width ?? 0) * (v.crop?.width ?? 1)
  const srcH = (asset?.height ?? 0) * (v.crop?.height ?? 1)
  const layout = { ...v.layout, scale: resize.value?.scale ?? v.layout.scale }
  // Ohne bekannte Größe der Quelle: wie das Projektformat.
  return layoutBox(layout, srcW || width, srcH || height, width, height)
})

/** Position im Dokument. */
const saved = computed<Point>(() => {
  const c = clip.value
  if (!c) return { x: 0.5, y: 0.5 }
  // Bild-in-Bild: die Mitte, an der das Bild wirklich liegt (ganz im Format).
  if (videoBox.value) return { x: videoBox.value.x, y: videoBox.value.y }
  if (c.kind !== 'text' && c.kind !== 'graphic') return { x: 0.5, y: 0.5 }
  if (graphic.value) return { x: graphic.value.x, y: graphic.value.y }
  return { x: num(c.data.x, DEFAULT_TEXT_STYLE.x), y: num(c.data.y, DEFAULT_TEXT_STYLE.y) }
})

/** Laufendes Ziehen: Start des Zeigers und bisher erreichte Position. */
const drag = ref<{ lastX: number; lastY: number; at: Point } | null>(null)
const position = computed(() => drag.value?.at ?? saved.value)

/** Abspielkopf außerhalb des Clips: Das Element ist im Bild gerade nicht zu sehen. */
const outside = computed(() => {
  const c = clip.value
  return !!c && (store.playhead < c.start || store.playhead >= clipEnd(c))
})

/** Formen und Bilder: in Vorschaugröße gezeichnet (gibt dem Rahmen seine Maße). */
const drawn = computed(() => {
  const g = graphic.value
  const h = picture.value.height
  if (!g || !isDrawable(g) || !(h > 0)) return null
  try {
    return renderGraphic(g, h)
  } catch {
    return null
  }
})

/** Texte: unsichtbar mit der echten Schrift gesetzt (gibt dem Rahmen seine Maße). */
const text = computed(() => {
  const c = clip.value
  if (!c || c.kind !== 'text') return null
  const px = num(c.data.size, DEFAULT_TEXT_STYLE.size) * picture.value.height
  const font = fontPreview(
    (typeof c.data.font === 'string' ? c.data.font : DEFAULT_TEXT_STYLE.font) as TextFont,
  )
  return {
    content: typeof c.data.text === 'string' && c.data.text.trim() ? c.data.text : ' ',
    style: {
      fontFamily: `'${font.css}'`,
      fontSize: `${px}px`,
      lineHeight: String(font.lineRatio),
    },
  }
})

/** Mitte so begrenzen, dass das Bild des Video-Clips ganz im Format bleibt. */
function inside(p: Point): Point {
  const b = videoBox.value
  if (!b) return p
  return {
    x: Math.min(1 - b.width / 2, Math.max(b.width / 2, p.x)),
    y: Math.min(1 - b.height / 2, Math.max(b.height / 2, p.y)),
  }
}

const frameStyle = computed(() => {
  if (videoBox.value) {
    const at = inside(position.value)
    return {
      left: `${at.x * 100}%`,
      top: `${at.y * 100}%`,
      width: `${videoBox.value.width * 100}%`,
      height: `${videoBox.value.height * 100}%`,
    }
  }
  const size = drawn.value
    ? { width: `${drawn.value.width}px`, height: `${drawn.value.height}px` }
    : graphic.value
      ? { width: '48px', height: '48px' }
      : {}
  return {
    left: `${position.value.x * 100}%`,
    top: `${position.value.y * 100}%`,
    ...size,
  }
})

// Blasse Kopie der Grafik im Rahmen, solange gezogen wird.
watch([drawn, ghost, () => !!drag.value], () => {
  const el = ghost.value
  const src = drawn.value
  if (!el || !src) return
  el.width = src.width
  el.height = src.height
  el.getContext('2d')?.drawImage(src, 0, 0)
})

function commit(to: Point): void {
  const c = clip.value
  if (!c) return
  if (video.value?.layout) {
    const at = tidyPoint(inside(to))
    if (at.x === video.value.layout.x && at.y === video.value.layout.y) return
    store.setClipLayout(video.value.id, { ...video.value.layout, ...at })
    return
  }
  if (to.x === saved.value.x && to.y === saved.value.y) return
  store.updateClipData(c.id, { x: to.x, y: to.y })
}

// --- Größe am Griff (nur Bild-in-Bild) -----------------------------------------

/** Abstand des Zeigers von der Mitte des Rahmens in Pixeln. */
function distance(event: PointerEvent): number {
  const b = videoBox.value
  const el = root.value
  if (!b || !el) return 0
  const r = el.getBoundingClientRect()
  const cx = r.left + picture.value.left + b.x * picture.value.width
  const cy = r.top + picture.value.top + b.y * picture.value.height
  return Math.hypot(event.clientX - cx, event.clientY - cy)
}

function onResizeDown(event: PointerEvent): void {
  const v = video.value
  if (event.button !== 0 || !v?.layout) return
  event.preventDefault()
  event.stopPropagation()
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  store.playing = false
  const from = distance(event)
  if (from > 0) resize.value = { from: from / v.layout.scale, scale: v.layout.scale }
}

function onResizeMove(event: PointerEvent): void {
  const r = resize.value
  if (!r) return
  event.stopPropagation()
  // `from` ist der Abstand je Größe 1: Der Griff folgt dem Zeiger.
  resize.value = { ...r, scale: resizeScale(1, r.from, distance(event), MIN_LAYOUT_SCALE) }
}

function onResizeUp(event: PointerEvent): void {
  const r = resize.value
  const v = video.value
  if (!r) return
  event.stopPropagation()
  resize.value = null
  if (v?.layout && r.scale !== v.layout.scale) {
    store.setClipLayout(v.id, { ...v.layout, scale: r.scale })
  }
}

function onPointerDown(event: PointerEvent): void {
  if (event.button !== 0 || !clip.value) return
  event.preventDefault()
  const el = event.currentTarget as HTMLElement
  // Fokus für die Pfeiltasten (preventDefault verhindert den Standard-Fokus).
  el.focus({ preventScroll: true })
  el.setPointerCapture(event.pointerId)
  store.playing = false
  drag.value = { lastX: event.clientX, lastY: event.clientY, at: saved.value }
}

function onPointerMove(event: PointerEvent): void {
  const d = drag.value
  if (!d) return
  // Schritt für Schritt: Ein Wechsel der Umschalttaste mitten im Ziehen springt nicht.
  drag.value = {
    lastX: event.clientX,
    lastY: event.clientY,
    at: dragPosition(
      d.at,
      event.clientX - d.lastX,
      event.clientY - d.lastY,
      picture.value,
      event.shiftKey,
    ),
  }
}

function onPointerUp(): void {
  const d = drag.value
  if (!d) return
  drag.value = null
  commit(tidyPoint(d.at))
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && (drag.value || resize.value)) {
    drag.value = null
    resize.value = null
    event.preventDefault()
    event.stopPropagation()
    return
  }
  if (event.ctrlKey || event.metaKey || event.altKey) return
  const next = nudgePoint(saved.value, event.key, event.shiftKey)
  if (!next) return
  event.preventDefault()
  event.stopPropagation()
  commit(next)
}

let observer: ResizeObserver | null = null
onMounted(() => {
  const el = root.value
  if (!el) return
  const measure = () => (box.value = { width: el.clientWidth, height: el.clientHeight })
  measure()
  if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(measure)
    observer.observe(el)
  }
})
onBeforeUnmount(() => observer?.disconnect())
</script>

<template>
  <div ref="root" class="position-layer">
    <div
      v-if="clip && picture.height > 0 && !store.playing"
      class="picture"
      :style="{
        left: `${picture.left}px`,
        top: `${picture.top}px`,
        width: `${picture.width}px`,
        height: `${picture.height}px`,
      }"
    >
      <div
        class="frame"
        :class="{ dragging: !!drag, outside }"
        :style="frameStyle"
        tabindex="0"
        role="group"
        :aria-label="t('timeline.positionFrame')"
        :title="t('timeline.positionFrameTitle')"
        data-testid="position-frame"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="drag = null"
        @keydown="onKeydown"
      >
        <canvas v-if="drawn" v-show="drag" ref="ghost" class="ghost" aria-hidden="true"></canvas>
        <span
          v-if="videoBox"
          class="handle"
          :title="t('timeline.positionFrameResize')"
          data-testid="position-frame-resize"
          @pointerdown="onResizeDown"
          @pointermove="onResizeMove"
          @pointerup="onResizeUp"
          @pointercancel="resize = null"
        ></span>
        <span v-if="text" class="text" :style="text.style" aria-hidden="true">{{
          text.content
        }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.position-layer {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
.picture {
  position: absolute;
}
.frame {
  position: absolute;
  box-sizing: content-box;
  transform: translate(-50%, -50%);
  border: 1px dashed #fff;
  border-radius: 2px;
  outline: 1px dashed rgb(0 0 0 / 70%);
  outline-offset: 1px;
  cursor: grab;
  pointer-events: auto;
  touch-action: none;
  user-select: none;
}
.frame.outside {
  opacity: 0.55;
}
.frame.dragging {
  cursor: grabbing;
}
.frame:focus-visible {
  border-color: var(--ds-accent);
  box-shadow: var(--ds-focus-ring);
}
.handle {
  position: absolute;
  right: -7px;
  bottom: -7px;
  width: 12px;
  height: 12px;
  border: 1px solid rgb(0 0 0 / 70%);
  border-radius: 2px;
  background: #fff;
  cursor: nwse-resize;
  touch-action: none;
}
.ghost {
  display: block;
  opacity: 0.6;
}
.text {
  display: block;
  padding: 0.15em 0.35em;
  color: transparent;
  white-space: pre;
  text-align: center;
}
</style>
