<script setup lang="ts">
import { computed } from 'vue'
import WaveformCanvas from './WaveformCanvas.vue'
import { stripTileStyle } from '@/lib/derivedApi'
import { useMediaPoolStore } from '@/stores/mediaPool'
import { clipPeaks, clipThumbs, timeToPx } from '@/timeline/layout'
import type { Clip } from '@/timeline/model'

/** Ein Clip auf einer Spur: Lage und Breite aus Zeit und Zoom, Inhalt je nach Art. */
const props = defineProps<{
  clip: Clip
  /** Pixel je Sekunde. */
  zoom: number
  /** Höhe der Spur in px. */
  height: number
  selected: boolean
}>()

const emit = defineEmits<{
  /** `toggle`: zur Auswahl hinzufügen/entfernen (Strg/Shift/Cmd gedrückt). */
  (e: 'select', id: string, toggle: boolean): void
}>()

const pool = useMediaPoolStore()

const left = computed(() => timeToPx(props.clip.start, props.zoom))
const width = computed(() => Math.max(2, timeToPx(props.clip.duration, props.zoom)))
const item = computed(() =>
  'asset' in props.clip && props.clip.asset ? pool.byAsset(props.clip.asset) : undefined,
)
const name = computed(() => item.value?.name ?? '')

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

function onPointerDown(event: PointerEvent): void {
  emit('select', props.clip.id, event.ctrlKey || event.metaKey || event.shiftKey)
}
</script>

<template>
  <div
    class="clip"
    :class="{ selected }"
    :data-kind="clip.kind"
    :data-clip="clip.id"
    :style="{ left: `${left}px`, width: `${width}px` }"
    :title="name"
    @pointerdown.stop="onPointerDown"
  >
    <div v-if="thumbs.length" class="thumbs" aria-hidden="true">
      <span v-for="t in thumbs" :key="t.key" class="thumb" :style="t.style"></span>
    </div>
    <div v-if="peaks && peaks.length" class="wave"><WaveformCanvas :peaks="peaks" /></div>
    <span v-if="name" class="label">{{ name }}</span>
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
  cursor: pointer;
  user-select: none;
}
.clip[data-kind='audio'] {
  background: var(--ds-accent-soft);
  color: var(--ds-accent);
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
</style>
