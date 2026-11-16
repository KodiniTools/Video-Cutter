<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { waveformBars } from '@/lib/waveform'

/** Zeichnet eine Wellenform als gespiegelte Balken in der Textfarbe des Elements. */
const props = defineProps<{
  /** Ein Wert (0–255) je Abschnitt; `null` = (noch) keine Wellenform. */
  peaks: Uint8Array | null
}>()

const canvas = ref<HTMLCanvasElement | null>(null)
let observer: ResizeObserver | null = null

function draw(): void {
  const el = canvas.value
  if (!el) return
  const width = el.clientWidth
  const height = el.clientHeight
  if (width <= 0 || height <= 0) return
  const ratio = Math.min(3, window.devicePixelRatio || 1)
  el.width = Math.round(width * ratio)
  el.height = Math.round(height * ratio)
  let ctx: CanvasRenderingContext2D | null = null
  try {
    ctx = el.getContext('2d')
  } catch {
    ctx = null
  }
  if (!ctx) return
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
  ctx.clearRect(0, 0, width, height)
  ctx.fillStyle = getComputedStyle(el).color
  const mid = height / 2
  waveformBars(props.peaks, Math.floor(width)).forEach((bar, x) => {
    // Auch Stille bekommt eine dünne Linie, damit die Länge erkennbar bleibt.
    const h = Math.max(1, bar * height)
    ctx.fillRect(x, mid - h / 2, 1, h)
  })
}

onMounted(() => {
  draw()
  if (typeof ResizeObserver !== 'undefined' && canvas.value) {
    observer = new ResizeObserver(draw)
    observer.observe(canvas.value)
  }
})
onBeforeUnmount(() => observer?.disconnect())
watch(() => props.peaks, draw, { flush: 'post' })
</script>

<template>
  <canvas ref="canvas" class="waveform" aria-hidden="true"></canvas>
</template>

<style scoped>
.waveform {
  display: block;
  width: 100%;
  height: 100%;
}
</style>
