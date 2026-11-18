<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import CropOverlay from '@/components/CropOverlay.vue'
import { API_BASE } from '@/lib/apiBase'
import { proxyUrl } from '@/lib/derivedApi'
import { useTimelineStore } from '@/stores/timeline'
import { cropFrameSourceTime, playheadInClip, sameCrop } from '@/timeline/cropFrame'
import type { ClipCrop, VideoClip } from '@/timeline/model'

/**
 * Bildausschnitt wie im bisherigen Editor: Solange die Wahl läuft, zeigt die
 * Vorschau das ungeschnittene Bild der Quelle (am Abspielkopf) mit einem
 * Rechteck darüber, das sich verschieben und an den Punkten in der Größe
 * ändern lässt. Erst beim Loslassen landet der Ausschnitt im Dokument (ein
 * Rückgängig-Schritt), dann rendert der Server die Vorschau neu.
 */

const { t } = useI18n()
const store = useTimelineStore()

const clip = computed<VideoClip | null>(() => {
  const id = store.cropEditing
  if (!id) return null
  const found = store.selectedClips.find((c) => c.id === id)
  return found && found.kind === 'video' ? found : null
})

const FULL: ClipCrop = { x: 0, y: 0, width: 1, height: 1 }
/** Ausschnitt während des Ziehens (sonst der des Dokuments). */
const draft = ref<ClipCrop | null>(null)
const rect = computed<ClipCrop>(() => draft.value ?? clip.value?.crop ?? FULL)

const videoEl = ref<HTMLVideoElement | null>(null)
/** Vorschau-Kopie fehlt noch: dann das Original vom Server. */
const useOriginal = ref(false)
const src = computed(() => {
  const c = clip.value
  if (!c) return undefined
  return useOriginal.value
    ? `${API_BASE}/api/media/${encodeURIComponent(c.asset)}/file`
    : proxyUrl(c.asset)
})
watch(
  () => clip.value?.asset,
  () => (useOriginal.value = false),
)

function onError(): void {
  if (!useOriginal.value) useOriginal.value = true
}

/** Quellzeit in Sekunden, deren Bild gezeigt wird. */
const seconds = computed(() =>
  clip.value ? cropFrameSourceTime(clip.value, store.playhead) / 1e6 : 0,
)
const outside = computed(() => !!clip.value && !playheadInClip(clip.value, store.playhead))

function showFrame(): void {
  const el = videoEl.value
  if (!el || el.readyState < 1) return
  const max = Number.isFinite(el.duration) ? Math.max(0, el.duration - 0.001) : seconds.value
  const at = Math.min(max, seconds.value)
  if (Math.abs(el.currentTime - at) > 0.001) el.currentTime = at
}
watch(seconds, showFrame)

// Beim Wählen läuft nichts ab.
watch(
  clip,
  (c) => {
    if (c) store.playing = false
    draft.value = null
  },
  { immediate: true },
)

function onUpdate(next: ClipCrop): void {
  draft.value = next
}

function finishDrag(): void {
  const c = clip.value
  const next = draft.value
  draft.value = null
  if (!c || !next || sameCrop(next, c.crop)) return
  store.setClipCrop(c.id, next)
}
</script>

<template>
  <div
    v-if="clip"
    class="crop-layer"
    data-testid="crop-frame"
    @pointerup="finishDrag"
    @pointercancel="draft = null"
  >
    <video
      ref="videoEl"
      :src="src"
      muted
      playsinline
      preload="auto"
      data-testid="crop-frame-video"
      @loadedmetadata="showFrame"
      @error="onError"
    />
    <CropOverlay :model-value="rect" :target="videoEl" @update:model-value="onUpdate" />
    <p class="note" :class="{ outside }" role="status">
      {{ outside ? t('timeline.cropFrame.outside') : t('timeline.cropFrame.hint') }}
    </p>
  </div>
</template>

<style scoped>
.crop-layer {
  position: absolute;
  inset: 0;
  z-index: 2;
  background: #000;
}
.crop-layer video {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
  pointer-events: none;
}
.note {
  position: absolute;
  left: 50%;
  bottom: 8px;
  max-width: calc(100% - 16px);
  margin: 0;
  padding: 3px 8px;
  border-radius: 4px;
  transform: translateX(-50%);
  background: rgb(0 0 0 / 70%);
  color: #fff;
  font-size: 0.75rem;
  text-align: center;
  pointer-events: none;
}
.note.outside {
  color: #fde68a;
}
</style>
