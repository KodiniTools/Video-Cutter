<script setup lang="ts">
import { ref, computed, watch, onBeforeUnmount, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { storeToRefs } from 'pinia'
import { useLibraryStore } from '@/stores/library'
import { IMAGE_ACCEPT, checkImageFile, decodeImageFile } from '@/lib/imageAssets'
import { createStillClip, fetchMediaFile, MEDIA_UNSUPPORTED } from '@/lib/mediaApi'
import {
  STILL_DEFAULT_DURATION,
  STILL_FITS,
  STILL_MAX_DURATION,
  STILL_MIN_DURATION,
  STILL_PRESETS,
  clampStillDuration,
  drawStill,
  evenSize,
  renderStillPng,
  stillFps,
  type StillFit,
  type StillImage,
} from '@/lib/stillClip'

/**
 * „Bild-Clip einfügen": Hintergrundbild (oder nur Farbe) + Dauer + Größe
 * wählen, an beliebiger Stelle der Liste einfügen. Der Clip ist danach ein
 * normales Video: im Editor Texte/Formen/Emojis/Bilder einbrennen, beim
 * Zusammenfügen Reihenfolge, Übergänge und Musik wie gewohnt.
 */
const props = defineProps<{
  disabled: boolean
}>()

const { t } = useI18n()
const library = useLibraryStore()
const { items, selectedId } = storeToRefs(library)

const open = ref(false)
const busy = ref(false)
const error = ref('')

const imageName = ref('')
const image = ref<StillImage | null>(null)
const fit = ref<StillFit>('blur')
const background = ref('#000000')
const duration = ref(STILL_DEFAULT_DURATION)
/** Gewählte Größe: 'video:<id>' (wie ein Video der Liste) oder Vorlagen-ID. */
const sizeKey = ref('')
/** Einfügeposition: Index in der Liste (0 = ganz vorn). */
const position = ref(0)

const readyItems = computed(() =>
  items.value.filter((it) => it.status === 'ready' && it.width > 0 && it.height > 0),
)

/** Größen-Optionen: zuerst die (verschiedenen) Videogrößen der Liste, dann Vorlagen. */
const sizeOptions = computed(() => {
  const seen = new Set<string>()
  const fromVideos: { key: string; label: string; width: number; height: number; fps: number }[] =
    []
  for (const it of readyItems.value) {
    const w = evenSize(it.width)
    const h = evenSize(it.height)
    const dim = `${w}x${h}`
    if (seen.has(dim)) continue
    seen.add(dim)
    fromVideos.push({
      key: `video:${it.id}`,
      label: t('still.sizeLike', { name: it.name, w, h }),
      width: w,
      height: h,
      fps: it.fps,
    })
  }
  const presets = STILL_PRESETS.filter((p) => !seen.has(`${p.width}x${p.height}`)).map((p) => ({
    key: p.id,
    label: `${p.width} × ${p.height}`,
    width: p.width,
    height: p.height,
    fps: 0,
  }))
  return [...fromVideos, ...presets]
})

const size = computed(
  () => sizeOptions.value.find((o) => o.key === sizeKey.value) ?? sizeOptions.value[0],
)

/** Positionen: „ganz vorn“ und „nach Video n“. */
const positionOptions = computed(() => [
  { value: 0, label: t('still.atStart') },
  ...items.value.map((it, i) => ({
    value: i + 1,
    label: t('still.after', { n: i + 1, name: it.name }),
  })),
])

/** Vorbelegung beim Öffnen: Größe und Bildrate wie das markierte Video, Position dahinter. */
function initDefaults(): void {
  error.value = ''
  const idx = items.value.findIndex((it) => it.id === selectedId.value)
  position.value = idx >= 0 ? idx + 1 : items.value.length
  const sel = idx >= 0 ? items.value[idx] : null
  const match =
    sel && sel.width > 0
      ? sizeOptions.value.find(
          (o) => o.width === evenSize(sel.width) && o.height === evenSize(sel.height),
        )
      : undefined
  sizeKey.value = match?.key ?? sizeOptions.value[0]?.key ?? ''
}

function toggle(): void {
  open.value = !open.value
  if (open.value) {
    initDefaults()
    void nextTick(drawPreview)
  }
}

async function onImage(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = '' // dieselbe Datei erneut wählbar
  if (!file) return
  error.value = ''
  try {
    checkImageFile(file)
    const d = await decodeImageFile(file)
    releaseImage()
    image.value = { source: d.source, width: d.w, height: d.h }
    imageName.value = file.name
  } catch {
    error.value = t('still.imageError')
  }
}

function releaseImage(): void {
  const src = image.value?.source
  if (src && typeof ImageBitmap !== 'undefined' && src instanceof ImageBitmap) src.close()
  image.value = null
  imageName.value = ''
}

// --- Vorschau -------------------------------------------------------------
const preview = ref<HTMLCanvasElement | null>(null)
const PREVIEW_W = 320

const previewSize = computed(() => {
  const s = size.value
  if (!s) return { width: PREVIEW_W, height: 180 }
  const scale = Math.min(PREVIEW_W / s.width, 240 / s.height)
  return { width: Math.round(s.width * scale), height: Math.round(s.height * scale) }
})

function drawPreview(): void {
  const c = preview.value
  if (!c) return
  const { width, height } = previewSize.value
  c.width = width
  c.height = height
  const ctx = c.getContext('2d')
  if (!ctx) return
  drawStill(ctx, width, height, image.value, fit.value, background.value)
}

watch([image, fit, background, previewSize, open], () => void nextTick(drawPreview))

// --- Erstellen ------------------------------------------------------------
const canCreate = computed(() => !props.disabled && !busy.value && !!size.value)

async function create(): Promise<void> {
  const s = size.value
  if (!s || !canCreate.value) return
  busy.value = true
  error.value = ''
  try {
    const dur = clampStillDuration(duration.value)
    duration.value = dur
    const png = await renderStillPng(
      { width: s.width, height: s.height },
      image.value,
      fit.value,
      background.value,
    )
    const media = await createStillClip({
      image: png,
      duration: dur,
      width: s.width,
      height: s.height,
      fps: stillFps(s.fps),
    })
    const blob = await fetchMediaFile(media.id)
    const file = new File([blob], media.name, { type: blob.type || 'video/mp4' })
    library.insertResult(media, file, position.value)
    open.value = false
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    error.value = msg === MEDIA_UNSUPPORTED ? t('still.outdated') : msg || t('still.failed')
  } finally {
    busy.value = false
  }
}

onBeforeUnmount(releaseImage)
</script>

<template>
  <div class="still">
    <button
      type="button"
      class="btn block"
      :aria-expanded="open"
      :disabled="disabled && !open"
      data-test="still-toggle"
      @click="toggle"
    >
      {{ t('still.add') }}
    </button>

    <div v-if="open" class="still-box" data-test="still-box">
      <canvas
        ref="preview"
        class="preview"
        :style="{ aspectRatio: `${previewSize.width} / ${previewSize.height}` }"
        :aria-label="t('still.preview')"
        role="img"
      />

      <div class="row">
        <label class="btn small">
          <input
            type="file"
            :accept="IMAGE_ACCEPT"
            class="sr-only"
            :disabled="busy"
            data-test="still-image"
            @change="onImage"
          />
          {{ imageName ? t('still.changeImage') : t('still.chooseImage') }}
        </label>
        <span class="file-name" :title="imageName">{{ imageName || t('still.noImage') }}</span>
        <button
          v-if="imageName"
          type="button"
          class="btn small ghost"
          :disabled="busy"
          :title="t('still.removeImage')"
          :aria-label="t('still.removeImage')"
          @click="releaseImage"
        >
          ✕
        </button>
      </div>

      <label class="field stack">
        <span class="field-label">{{ t('still.fit') }}</span>
        <select v-model="fit" class="input" :disabled="busy || !imageName">
          <option v-for="f in STILL_FITS" :key="f" :value="f">{{ t(`still.fits.${f}`) }}</option>
        </select>
      </label>

      <label class="field">
        <span class="field-label">{{ t('still.background') }}</span>
        <input v-model="background" type="color" class="color" :disabled="busy" />
      </label>

      <label class="field">
        <span class="field-label">{{ t('still.duration') }}</span>
        <input
          v-model.number="duration"
          type="number"
          class="input num"
          :min="STILL_MIN_DURATION"
          :max="STILL_MAX_DURATION"
          step="0.5"
          :disabled="busy"
          data-test="still-duration"
          @change="duration = clampStillDuration(duration)"
        />
      </label>

      <label class="field stack">
        <span class="field-label">{{ t('still.size') }}</span>
        <select v-model="sizeKey" class="input" :disabled="busy" data-test="still-size">
          <option v-for="o in sizeOptions" :key="o.key" :value="o.key">{{ o.label }}</option>
        </select>
      </label>

      <label class="field stack">
        <span class="field-label">{{ t('still.position') }}</span>
        <select v-model.number="position" class="input" :disabled="busy" data-test="still-position">
          <option v-for="o in positionOptions" :key="o.value" :value="o.value">
            {{ o.label }}
          </option>
        </select>
      </label>

      <p v-if="error" class="hint warn" role="alert">{{ error }}</p>

      <div class="actions">
        <button type="button" class="btn ghost" :disabled="busy" @click="open = false">
          {{ t('still.cancel') }}
        </button>
        <button
          type="button"
          class="btn primary"
          :disabled="!canCreate"
          data-test="still-create"
          @click="create"
        >
          {{ busy ? t('still.creating') : t('still.create') }}
        </button>
      </div>
      <p class="hint">{{ t('still.hint') }}</p>
    </div>
  </div>
</template>

<style scoped>
.still {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.still-box {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border: 1px dashed var(--ds-border-strong);
  border-radius: var(--ds-radius-sm);
  background: var(--ds-surface-0);
}
.preview {
  display: block;
  width: 100%;
  max-height: 240px;
  object-fit: contain;
  border-radius: var(--ds-radius-sm);
  border: 1px solid var(--ds-border);
  background: var(--ds-surface-2);
}
.row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.file-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--ds-text-xs);
  color: var(--ds-text-2);
}
.field {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.field.stack {
  flex-direction: column;
  align-items: stretch;
  gap: 4px;
}
.field.stack .input {
  max-width: none;
}
.field-label {
  flex: 0 0 auto;
  font-size: var(--ds-text-sm);
  color: var(--ds-text-2);
}
.input {
  flex: 1 1 auto;
  min-width: 0;
  max-width: 70%;
  padding: 5px 8px;
  border: 1px solid var(--ds-border-strong);
  border-radius: var(--ds-radius-sm);
  background: var(--ds-surface-0);
  color: var(--ds-text);
  font: inherit;
  font-size: var(--ds-text-sm);
}
.input.num {
  max-width: 90px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.input:focus-visible,
.color:focus-visible {
  outline: none;
  border-color: var(--ds-accent);
  box-shadow: var(--ds-focus-ring);
}
.color {
  width: 44px;
  height: 28px;
  padding: 0 2px;
  border: 1px solid var(--ds-border-strong);
  border-radius: var(--ds-radius-sm);
  background: var(--ds-surface-0);
  cursor: pointer;
}
.actions {
  display: flex;
  gap: 6px;
}
.actions .btn.primary {
  flex: 1;
}
.btn {
  appearance: none;
  border: 1px solid var(--ds-border-strong);
  background: var(--ds-surface-2);
  color: var(--ds-text);
  padding: 8px 12px;
  border-radius: var(--ds-radius-md);
  font-size: var(--ds-text-sm);
  cursor: pointer;
}
.btn:hover:not(:disabled) {
  border-color: var(--ds-accent);
}
.btn.small {
  padding: 4px 10px;
  font-size: var(--ds-text-xs);
  white-space: nowrap;
}
.btn.ghost {
  background: transparent;
}
.btn.primary {
  background: var(--ds-accent);
  border-color: var(--ds-accent);
  color: var(--ds-on-accent);
  font-weight: var(--ds-weight-semibold);
}
.btn.primary:hover:not(:disabled) {
  background: var(--ds-accent-hover);
  border-color: var(--ds-accent-hover);
}
.btn.block {
  width: 100%;
  text-align: center;
  border-color: var(--ds-accent);
  font-weight: var(--ds-weight-semibold);
}
.btn.block:hover:not(:disabled) {
  background: var(--ds-accent-soft);
}
.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.btn:focus-visible {
  outline: none;
  box-shadow: var(--ds-focus-ring);
}
.hint {
  margin: 0;
  font-size: var(--ds-text-xs);
  color: var(--ds-text-2);
  line-height: 1.4;
}
.hint.warn {
  color: var(--ds-danger);
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
</style>
