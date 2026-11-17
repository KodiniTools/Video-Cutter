<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import WaveformCanvas from './WaveformCanvas.vue'
import { stripTileStyle } from '@/lib/derivedApi'
import { getImageAsset } from '@/lib/imageAssets'
import { useMediaPoolStore } from '@/stores/mediaPool'
import { useTimelineStore } from '@/stores/timeline'
import { envelopeLine, movePoint, visiblePoints } from '@/timeline/envelope'
import { clipGraphic } from '@/timeline/graphics'
import { clipPeaks, clipThumbs, timeToPx } from '@/timeline/layout'
import { MAX_CLIP_GAIN, type Clip } from '@/timeline/model'

/** Ein Clip auf einer Spur: Lage und Breite aus Zeit und Zoom, Inhalt je nach Art. */
const props = defineProps<{
  clip: Clip
  /** Pixel je Sekunde. */
  zoom: number
  /** Höhe der Spur in px. */
  height: number
  selected: boolean
  /** Spur gesperrt: keine Griffe zum Trimmen. */
  locked?: boolean
}>()

/** Was mit dem Zeiger gegriffen wurde: der Clip selbst oder einer seiner Ränder. */
export type ClipGrab = 'move' | 'start' | 'end'

const emit = defineEmits<{
  /** Zeiger auf dem Clip gedrückt; Auswahl und Ziehen übernimmt die Timeline. */
  (e: 'grab', id: string, mode: ClipGrab, event: PointerEvent): void
}>()

const { t, locale } = useI18n()
const pool = useMediaPoolStore()

const left = computed(() => timeToPx(props.clip.start, props.zoom))
const width = computed(() => Math.max(2, timeToPx(props.clip.duration, props.zoom)))
const item = computed(() =>
  'asset' in props.clip && props.clip.asset ? pool.byAsset(props.clip.asset) : undefined,
)
const name = computed(() => {
  const clip = props.clip
  // Text-Clips zeigen ihre erste Zeile.
  if (clip.kind === 'text')
    return typeof clip.data.text === 'string'
      ? clip.data.text.split('\n')[0].trim() || 'Text'
      : 'Text'
  // Grafik-Clips zeigen ihr Emoji bzw. ihre Art.
  if (clip.kind === 'graphic') {
    const g = clipGraphic(clip.data)
    if (g.kind === 'emoji') return g.emoji || t('graphics.kinds.emoji')
    if (g.kind === 'image') return getImageAsset(g.image)?.name ?? t('graphics.kinds.image')
    return g.kind === 'symbol' ? t(`graphics.symbols.${g.symbol}`) : t(`graphics.kinds.${g.kind}`)
  }
  const base = item.value?.name ?? ''
  // Geändertes Tempo steht am Namen, z. B. „video.mp4 · 2×“.
  if ('speed' in clip && clip.kind !== 'still' && Math.abs(clip.speed - 1) > 1e-6) {
    const speed = `${clip.speed.toLocaleString(locale.value, { maximumFractionDigits: 2 })}×`
    return base ? `${base} · ${speed}` : speed
  }
  return base
})

/** Vorschaubilder entlang eines Video-Clips (aus dem Filmstreifen). */
const thumbs = computed(() => {
  const clip = props.clip
  const media = item.value?.media
  const strip = item.value?.derived?.strip
  if (clip.kind !== 'video' || !media || !strip || strip.state !== 'ready') return []
  const thumbWidth = Math.round((props.height * strip.tileWidth) / strip.tileHeight)
  return clipThumbs({
    clipWidth: width.value,
    thumbWidth,
    zoom: props.zoom,
    sourceIn: clip.sourceIn,
    speed: clip.speed,
    interval: strip.interval,
    count: strip.count,
  }).flatMap((slot) => {
    const style = stripTileStyle(media.id, strip, slot.index, thumbWidth)
    return style
      ? [{ key: slot.left, style: { ...style, left: `${slot.left}px`, width: `${thumbWidth}px` } }]
      : []
  })
})

/** Wellenform-Ausschnitt eines Ton-Clips. */
const peaks = computed(() => {
  const clip = props.clip
  if (clip.kind !== 'audio') return null
  const rate = item.value?.derived?.peaks.rate ?? 0
  return clipPeaks(item.value?.peaks, rate, clip.sourceIn, clip.duration, clip.speed)
})

/** Lautstärke-Kurve als Linie über dem Ton-Clip (oben = lauter). */
const envelope = computed(() => {
  const clip = props.clip
  if (clip.kind !== 'audio') return ''
  return envelopeLine(clip)
    .map(
      ([x, gain]) => `${(x * 100).toFixed(2)},${(100 - (gain / MAX_CLIP_GAIN) * 100).toFixed(2)}`,
    )
    .join(' ')
})

/** Punkte der Kurve zum Ziehen: nur am markierten, nicht gesperrten Ton-Clip. */
const store = useTimelineStore()
const root = ref<HTMLElement | null>(null)
const envelopePoints = computed(() => {
  const clip = props.clip
  if (clip.kind !== 'audio' || !props.selected || props.locked) return []
  return visiblePoints(clip).map((p) => ({
    index: p.index,
    percent: Math.round(p.gain * 100),
    style: {
      left: `${(p.offset / clip.duration) * 100}%`,
      top: `clamp(5px, ${(1 - p.gain / MAX_CLIP_GAIN) * 100}%, calc(100% - 5px))`,
    },
  }))
})

let pointDrag: { index: number; pointerId: number; active: boolean } | null = null

function onPointDown(index: number, event: PointerEvent): void {
  if (event.button !== 0) return
  ;(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId)
  pointDrag = { index, pointerId: event.pointerId, active: false }
}

function onPointMove(event: PointerEvent): void {
  const d = pointDrag
  const clip = props.clip
  const box = root.value?.getBoundingClientRect()
  if (!d || event.pointerId !== d.pointerId || clip.kind !== 'audio') return
  if (!box || box.width <= 0 || box.height <= 0) return
  if (!d.active) {
    d.active = true
    store.beginGesture()
  }
  store.setClipEnvelope(
    clip.id,
    movePoint(clip, d.index, {
      offset: Math.round(((event.clientX - box.left) / box.width) * clip.duration),
      gain: (1 - (event.clientY - box.top) / box.height) * MAX_CLIP_GAIN,
    }),
  )
}

function onPointUp(event: PointerEvent): void {
  const d = pointDrag
  if (!d || event.pointerId !== d.pointerId) return
  pointDrag = null
  if (d.active) store.endGesture()
}
onBeforeUnmount(() => {
  if (pointDrag?.active) store.endGesture()
  pointDrag = null
})

/** Doppelklick entfernt den Punkt. */
function removePoint(index: number): void {
  const clip = props.clip
  if (clip.kind !== 'audio' || !clip.envelope) return
  store.setClipEnvelope(
    clip.id,
    clip.envelope.filter((_, i) => i !== index),
  )
}

/** Übergang am Anfang: Marke so breit wie der Teil, der in diesem Clip liegt. */
const transition = computed(() => {
  const clip = props.clip
  if ((clip.kind !== 'video' && clip.kind !== 'still') || !clip.transitionIn) return null
  const half = Math.min(clip.duration, Math.round(clip.transitionIn.duration / 2))
  return {
    width: Math.min(width.value, Math.max(6, timeToPx(half, props.zoom))),
    title: t(`anim.${clip.transitionIn.preset}`),
  }
})

/** Letztes Bild wird gehalten: Marke am Clip-Ende. */
const hold = computed(
  () => (props.clip.kind === 'video' || props.clip.kind === 'still') && props.clip.hold === true,
)

function grab(mode: ClipGrab, event: PointerEvent): void {
  if (event.button !== 0) return
  emit('grab', props.clip.id, mode, event)
}
</script>

<template>
  <div
    ref="root"
    class="clip"
    :class="{ selected }"
    :data-kind="clip.kind"
    :data-clip="clip.id"
    :style="{ left: `${left}px`, width: `${width}px` }"
    :title="name"
    @pointerdown.stop="grab('move', $event)"
  >
    <div v-if="thumbs.length" class="thumbs" aria-hidden="true">
      <span v-for="thumb in thumbs" :key="thumb.key" class="thumb" :style="thumb.style"></span>
    </div>
    <div v-if="peaks && peaks.length" class="wave"><WaveformCanvas :peaks="peaks" /></div>
    <svg
      v-if="envelope"
      class="envelope"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <polyline :points="envelope" />
    </svg>
    <span
      v-for="point in envelopePoints"
      :key="point.index"
      class="env-point"
      :data-point="point.index"
      :style="point.style"
      :title="t('timeline.clipInspector.envelope.pointTitle', { percent: point.percent })"
      @pointerdown.stop="onPointDown(point.index, $event)"
      @pointermove="onPointMove"
      @pointerup="onPointUp"
      @pointercancel="onPointUp"
      @dblclick.stop="removePoint(point.index)"
    ></span>
    <span
      v-if="transition"
      class="transition"
      :style="{ width: `${transition.width}px` }"
      :title="transition.title"
      aria-hidden="true"
    ></span>
    <span
      v-if="hold"
      class="hold"
      :title="t('timeline.clipInspector.hold')"
      aria-hidden="true"
    ></span>
    <span v-if="name" class="label">{{ name }}</span>
    <template v-if="!locked">
      <span class="handle start" @pointerdown.stop="grab('start', $event)"></span>
      <span class="handle end" @pointerdown.stop="grab('end', $event)"></span>
    </template>
  </div>
</template>

<style scoped>
.clip {
  position: absolute;
  top: 2px;
  bottom: 2px;
  overflow: hidden;
  border: 1px solid var(--ds-border-strong);
  border-radius: var(--ds-radius-sm);
  background: var(--ds-surface-3);
  cursor: grab;
  user-select: none;
  touch-action: none;
}
.transition {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  pointer-events: none;
  background: linear-gradient(to top right, var(--ds-accent) 50%, transparent 50%);
  opacity: 0.75;
}
.hold {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: 6px;
  pointer-events: none;
  background: repeating-linear-gradient(to bottom, var(--ds-accent) 0 4px, transparent 4px 8px);
}
.handle {
  position: absolute;
  top: 0;
  bottom: 0;
  z-index: 1;
  width: 7px;
  cursor: ew-resize;
}
.handle.start {
  left: 0;
}
.handle.end {
  right: 0;
}
.clip.selected .handle,
.handle:hover {
  background: var(--ds-accent);
  opacity: 0.85;
}
.clip[data-kind='audio'] {
  background: var(--ds-accent-soft);
  color: var(--ds-accent);
}
.clip[data-kind='text'],
.clip[data-kind='graphic'] {
  background: var(--ds-surface-2);
  border-style: dashed;
}
.clip.selected {
  border-color: var(--ds-accent);
  box-shadow: 0 0 0 2px var(--ds-accent);
  z-index: 1;
}
.thumbs,
.wave {
  position: absolute;
  inset: 0;
}
.thumb {
  position: absolute;
  top: 0;
  bottom: 0;
  background-repeat: no-repeat;
}
.label {
  position: absolute;
  top: 2px;
  left: 4px;
  max-width: calc(100% - 8px);
  padding: 0 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  border-radius: var(--ds-radius-sm);
  background: var(--ds-surface-1);
  color: var(--ds-text);
  font-size: var(--ds-text-xs);
  line-height: 1.4;
}
.envelope {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}
.env-point {
  position: absolute;
  z-index: 2;
  width: 10px;
  height: 10px;
  margin: -5px 0 0 -5px;
  border: 2px solid var(--vc-playhead);
  border-radius: 50%;
  background: var(--ds-surface-0);
  cursor: move;
  touch-action: none;
}
.envelope polyline {
  fill: none;
  stroke: var(--vc-playhead);
  stroke-width: 1.5;
  vector-effect: non-scaling-stroke;
}
</style>
