<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import StillAiImage from '@/components/StillAiImage.vue'
import { IMAGE_ACCEPT, checkImageFile, decodeImageFile } from '@/lib/imageAssets'
import { createStillClip, MEDIA_UNSUPPORTED, type MediaView } from '@/lib/mediaApi'
import {
  STILL_DEFAULT_DURATION,
  STILL_FITS,
  STILL_MAX_DURATION,
  STILL_MIN_DURATION,
  clampStillDuration,
  drawStill,
  evenSize,
  renderStillPng,
  stillFps,
  type StillFit,
  type StillImage,
} from '@/lib/stillClip'
import { useMediaPoolStore } from '@/stores/mediaPool'
import { useTimelineStore } from '@/stores/timeline'

/**
 * Bild-Clip für den Timeline-Editor: Bild (hochgeladen, mit KI erzeugt oder
 * aus der KI-Galerie) oder nur eine Farbe wird auf dem Server zu einem Video
 * im Projektformat und landet in der Medienliste. KI-Videos kommen ebenfalls
 * direkt in die Medienliste.
 */
const emit = defineEmits<{ close: [] }>()

const { t } = useI18n()
const pool = useMediaPoolStore()
const timeline = useTimelineStore()

const busy = ref(false)
const aiOpen = ref(false)
const aiBusy = ref(false)
const error = ref('')
const notice = ref('')

const imageName = ref('')
const image = ref<StillImage | null>(null)
const fit = ref<StillFit>('blur')
const background = ref(timeline.doc.settings.background)
const duration = ref(STILL_DEFAULT_DURATION)

/** Der Clip entsteht im Projektformat. */
const size = computed(() => ({
  width: evenSize(timeline.doc.settings.width),
  height: evenSize(timeline.doc.settings.height),
}))

async function onImage(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (file) await useImageFile(file)
}

async function useImageFile(file: File): Promise<boolean> {
  error.value = ''
  try {
    checkImageFile(file)
    const d = await decodeImageFile(file)
    releaseImage()
    image.value = { source: d.source, width: d.w, height: d.h }
    imageName.value = file.name
    return true
  } catch {
    error.value = t('still.imageError')
    return false
  }
}

/** KI-Variante gewählt: hat schon das passende Seitenverhältnis, also Fläche füllen. */
async function onAiPick(file: File): Promise<void> {
  if (await useImageFile(file)) fit.value = 'cover'
}

function releaseImage(): void {
  const src = image.value?.source
  if (src && typeof ImageBitmap !== 'undefined' && src instanceof ImageBitmap) src.close()
  image.value = null
  imageName.value = ''
}

// --- Vorschau ---------------------------------------------------------------
const preview = ref<HTMLCanvasElement | null>(null)
const previewSize = computed(() => {
  const s = size.value
  const scale = Math.min(320 / s.width, 200 / s.height)
  return { width: Math.round(s.width * scale), height: Math.round(s.height * scale) }
})

function drawPreview(): void {
  const c = preview.value
  if (!c) return
  const { width, height } = previewSize.value
  c.width = width
  c.height = height
  const ctx = c.getContext('2d')
  if (ctx) drawStill(ctx, width, height, image.value, fit.value, background.value)
}
watch([image, fit, background, previewSize], () => void nextTick(drawPreview))
onMounted(drawPreview)

// --- Erstellen --------------------------------------------------------------
const canCreate = computed(() => !busy.value && !aiBusy.value)

async function create(): Promise<void> {
  if (!canCreate.value) return
  busy.value = true
  error.value = ''
  notice.value = ''
  try {
    const dur = clampStillDuration(duration.value)
    duration.value = dur
    const s = size.value
    const png = await renderStillPng(s, image.value, fit.value, background.value)
    const base = imageName.value.replace(/\.[^.]+$/, '')
    const media = await createStillClip({
      image: png,
      duration: dur,
      width: s.width,
      height: s.height,
      fps: stillFps(timeline.doc.settings.fps),
      audio: false,
      ...(base ? { name: `${base}.mp4` } : {}),
    })
    pool.addMedia(media)
    notice.value = t('timeline.still.added', { name: media.name })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    error.value = msg === MEDIA_UNSUPPORTED ? t('still.outdated') : msg || t('still.failed')
  } finally {
    busy.value = false
  }
}

/** KI-Video (neu erzeugt oder aus der Galerie): liegt schon auf dem Server. */
function onAiVideo(media: MediaView): void {
  pool.addMedia(media)
  notice.value = t('timeline.still.added', { name: media.name })
}

watch(aiOpen, (open) => {
  if (!open) aiBusy.value = false
})
onBeforeUnmount(releaseImage)
</script>

<template>
  <div class="still" data-testid="still-form">
    <canvas
      ref="preview"
      class="preview"
      :style="{ aspectRatio: `${previewSize.width} / ${previewSize.height}` }"
      :aria-label="t('still.preview')"
      role="img"
    />

    <div class="row">
      <label class="button">
        <input
          type="file"
          :accept="IMAGE_ACCEPT"
          class="file"
          :disabled="busy || aiBusy"
          data-testid="still-image"
          @change="onImage"
        />
        {{ imageName ? t('still.changeImage') : t('still.chooseImage') }}
      </label>
      <span class="name" :title="imageName">{{ imageName || t('still.noImage') }}</span>
      <button
        v-if="imageName"
        type="button"
        class="button icon"
        :disabled="busy"
        :title="t('still.removeImage')"
        :aria-label="t('still.removeImage')"
        @click="releaseImage"
      >
        ✕
      </button>
    </div>

    <button
      type="button"
      class="button wide"
      :aria-expanded="aiOpen"
      :disabled="busy"
      data-testid="still-ai-toggle"
      @click="aiOpen = !aiOpen"
    >
      {{ aiOpen ? t('stillAi.close') : t('stillAi.open') }}
    </button>
    <StillAiImage
      v-if="aiOpen"
      :width="size.width"
      :height="size.height"
      :before="null"
      :after="null"
      :disabled="busy"
      @pick="onAiPick"
      @video="onAiVideo"
      @busy="aiBusy = $event"
    />

    <label class="field">
      <span>{{ t('still.fit') }}</span>
      <select v-model="fit" :disabled="busy || !imageName" data-testid="still-fit">
        <option v-for="f in STILL_FITS" :key="f" :value="f">{{ t(`still.fits.${f}`) }}</option>
      </select>
    </label>
    <label class="field inline">
      <span>{{ t('still.background') }}</span>
      <input v-model="background" type="color" :disabled="busy" />
    </label>
    <label class="field inline">
      <span>{{ t('still.duration') }}</span>
      <input
        v-model.number="duration"
        type="number"
        class="num"
        :min="STILL_MIN_DURATION"
        :max="STILL_MAX_DURATION"
        step="0.5"
        :disabled="busy"
        data-testid="still-duration"
        @change="duration = clampStillDuration(duration)"
      />
    </label>

    <p v-if="error" class="note error" role="alert" data-testid="still-error">{{ error }}</p>
    <p v-if="notice" class="note ok" role="status" data-testid="still-notice">{{ notice }}</p>

    <div class="actions">
      <button type="button" class="button" :disabled="busy" @click="emit('close')">
        {{ t('timeline.still.close') }}
      </button>
      <button
        type="button"
        class="button primary"
        :disabled="!canCreate"
        data-testid="still-create"
        @click="create"
      >
        {{ busy ? t('still.creating') : t('still.create') }}
      </button>
    </div>
    <p class="note">
      {{ t('timeline.still.hint', { w: size.width, h: size.height, max: STILL_MAX_DURATION }) }}
    </p>
  </div>
</template>

<style scoped>
.still {
  display: flex;
  flex-direction: column;
  gap: var(--ds-space-2);
  padding: var(--ds-space-3);
  border: 1px solid var(--ds-border);
  border-radius: var(--ds-radius-md);
  background: var(--ds-surface-2);
  font-size: var(--ds-text-sm);
}
.preview {
  width: 100%;
  max-height: 200px;
  object-fit: contain;
  border-radius: var(--ds-radius-sm, 4px);
  background: #000;
}
.row {
  display: flex;
  align-items: center;
  gap: var(--ds-space-2);
}
.name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ds-text-2);
}
.file {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
}
.button {
  position: relative;
  flex: none;
  padding: var(--ds-space-2) var(--ds-space-3);
  border: 1px solid var(--ds-border);
  border-radius: var(--ds-radius-md);
  background: var(--ds-surface-1);
  color: var(--ds-text);
  font: inherit;
  cursor: pointer;
}
.button:focus-within,
.button:focus-visible {
  outline: none;
  box-shadow: var(--ds-focus-ring);
}
.button:disabled {
  opacity: 0.5;
  cursor: default;
}
.button.wide {
  width: 100%;
}
.button.primary {
  border-color: var(--ds-accent);
  font-weight: var(--ds-weight-semibold);
}
.field {
  display: flex;
  flex-direction: column;
  gap: var(--ds-space-1);
  color: var(--ds-text-2);
}
.field.inline {
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
}
select,
.num {
  padding: var(--ds-space-2);
  border: 1px solid var(--ds-border);
  border-radius: var(--ds-radius-md);
  background: var(--ds-surface-1);
  color: var(--ds-text);
  font: inherit;
}
.num {
  width: 6em;
}
.actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--ds-space-2);
}
.note {
  margin: 0;
  color: var(--ds-text-2);
  line-height: 1.5;
}
.note.error {
  color: var(--ds-danger);
}
.note.ok {
  color: var(--ds-success, #2e7d32);
}
</style>
