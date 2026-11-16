<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { renderGraphic } from '@/lib/graphicOverlay'
import { DEFAULT_TEXT_STYLE, fontPreview, type TextFont } from '@/lib/textOverlay'
import { useTimelineStore } from '@/stores/timeline'
import { clipGraphic, isDrawable } from '@/timeline/graphics'
import { clipEnd } from '@/timeline/model'
import {
  containRect,
  dragPosition,
  nudgePoint,
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
 */

const { t } = useI18n()
const store = useTimelineStore()

const root = ref<HTMLElement | null>(null)
const ghost = ref<HTMLCanvasElement | null>(null)
const box = ref({ width: 0, height: 0 })

/** Der Clip auf einer Ebenen-Spur, wenn genau einer markiert ist. */
const clip = computed(() => {
  const [only, ...rest] = store.selectedClips
  return only && rest.length === 0 && (only.kind === 'text' || only.kind === 'graphic')
    ? only
    : null
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

/** Position im Dokument. */
const saved = computed<Point>(() => {
  const c = clip.value
  if (!c) return { x: 0.5, y: 0.5 }
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

const frameStyle = computed(() => {
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
  if (to.x === saved.value.x && to.y === saved.value.y) return
  store.updateClipData(c.id, { x: to.x, y: to.y })
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
  if (event.key === 'Escape' && drag.value) {
    drag.value = null
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
