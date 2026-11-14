<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  AI_UNSUPPORTED,
  deleteGalleryImage,
  fetchGallery,
  fetchGalleryFile,
  galleryThumbUrl,
  galleryVideoToMedia,
  isGalleryVideo,
  type GalleryImage,
} from '@/lib/aiApi'
import { saveFile } from '@/lib/download'
import type { MediaView } from '@/lib/mediaApi'

/**
 * Galerie der KI-Bilder: Alle erzeugten Bilder liegen dauerhaft auf dem
 * Server. Hier lassen sie sich als Hintergrund verwenden, herunterladen
 * und vom Server löschen; der Prompt eines Bildes lässt sich übernehmen.
 */
const props = defineProps<{
  disabled: boolean
  /** Ändert sich, sobald neue Bilder erzeugt wurden -> neu laden. */
  refreshKey: number
}>()

const emit = defineEmits<{
  pick: [file: File]
  /** Galerie-Video wurde als Bibliotheks-Video angelegt -> in die Liste einfügen. */
  video: [media: MediaView]
  prompt: [text: string, kind: 'image' | 'video']
}>()

const { t, locale } = useI18n()

const images = ref<GalleryImage[]>([])
const totalBytes = ref(0)
const loading = ref(false)
const error = ref('')
/** Bild, das gerade geladen/gelöscht wird. */
const busyId = ref('')
/** Bild, dessen Löschen bestätigt werden muss. */
const confirmId = ref('')
const selectedId = ref('')

const sizeText = computed(() => {
  const mb = totalBytes.value / (1024 * 1024)
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(mb < 10 ? 1 : 0)} MB`
})

function message(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  return msg === AI_UNSUPPORTED ? t('gallery.outdated') : msg || t('gallery.failed')
}

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const g = await fetchGallery()
    images.value = g.images
    totalBytes.value = g.totalBytes
  } catch (e) {
    error.value = message(e)
  } finally {
    loading.value = false
  }
}

onMounted(load)
watch(() => props.refreshKey, load)

function dateOf(img: GalleryImage): string {
  if (!img.createdAt) return ''
  return new Date(img.createdAt).toLocaleString(locale.value === 'en' ? 'en-GB' : 'de-CH', {
    dateStyle: 'short',
    timeStyle: 'short',
  })
}

function tooltip(img: GalleryImage): string {
  return [dateOf(img), img.prompt].filter(Boolean).join(' · ')
}

async function withFile(
  img: GalleryImage,
  fn: (file: File) => void | Promise<void>,
): Promise<void> {
  if (busyId.value) return
  busyId.value = img.id
  error.value = ''
  confirmId.value = ''
  try {
    await fn(await fetchGalleryFile(img))
  } catch (e) {
    error.value = message(e)
  } finally {
    busyId.value = ''
  }
}

/** Video: als Clip in die Liste einfügen (Server legt eine Kopie in die Bibliothek). */
async function useVideo(img: GalleryImage): Promise<void> {
  if (busyId.value) return
  busyId.value = img.id
  error.value = ''
  confirmId.value = ''
  try {
    emit('video', await galleryVideoToMedia(img.id))
  } catch (e) {
    error.value = message(e)
  } finally {
    busyId.value = ''
  }
}

function use(img: GalleryImage): Promise<void> {
  if (isGalleryVideo(img)) return useVideo(img)
  return withFile(img, (file) => {
    selectedId.value = img.id
    emit('pick', file)
  })
}

function download(img: GalleryImage): Promise<void> {
  return withFile(img, async (file) => {
    await saveFile({ blob: file, name: file.name })
  })
}

/** Erster Klick fragt nach, zweiter löscht endgültig. */
async function remove(img: GalleryImage): Promise<void> {
  if (busyId.value) return
  if (confirmId.value !== img.id) {
    confirmId.value = img.id
    return
  }
  busyId.value = img.id
  error.value = ''
  try {
    await deleteGalleryImage(img.id)
    images.value = images.value.filter((i) => i.id !== img.id)
    totalBytes.value = Math.max(0, totalBytes.value - img.size)
    if (selectedId.value === img.id) selectedId.value = ''
  } catch (e) {
    error.value = message(e)
  } finally {
    busyId.value = ''
    confirmId.value = ''
  }
}
</script>

<template>
  <div class="gallery" data-test="gallery">
    <div class="head">
      <span class="title">
        {{ t('gallery.title') }}
        <small v-if="images.length" data-test="gallery-count">
          {{ t('gallery.count', { n: images.length, size: sizeText }) }}
        </small>
      </span>
      <button type="button" class="btn small ghost" :disabled="loading" @click="load">
        {{ t('gallery.reload') }}
      </button>
    </div>

    <p v-if="error" class="hint warn" role="alert">{{ error }}</p>
    <p v-else-if="loading && !images.length" class="hint">{{ t('gallery.loading') }}</p>
    <p v-else-if="!images.length" class="hint" data-test="gallery-empty">
      {{ t('gallery.empty') }}
    </p>

    <ul v-if="images.length" class="grid">
      <li
        v-for="img in images"
        :key="img.id"
        class="cell"
        :class="{ busy: busyId === img.id }"
        data-test="gallery-item"
      >
        <button
          type="button"
          class="thumb"
          :class="{ on: selectedId === img.id }"
          :aria-pressed="selectedId === img.id"
          :title="tooltip(img)"
          :disabled="disabled || !!busyId"
          data-test="gallery-use"
          @click="use(img)"
        >
          <span v-if="isGalleryVideo(img)" class="badge" data-test="gallery-video">▶</span>
          <img
            :src="galleryThumbUrl(img.id)"
            :alt="img.prompt || t('gallery.image')"
            loading="lazy"
          />
        </button>
        <div class="tools">
          <button
            v-if="img.prompt"
            type="button"
            class="tool"
            :title="t('gallery.usePrompt')"
            :aria-label="t('gallery.usePrompt')"
            :disabled="disabled"
            data-test="gallery-prompt"
            @click="emit('prompt', img.prompt, isGalleryVideo(img) ? 'video' : 'image')"
          >
            ✍
          </button>
          <button
            type="button"
            class="tool"
            :title="t('gallery.download')"
            :aria-label="t('gallery.download')"
            :disabled="!!busyId"
            data-test="gallery-download"
            @click="download(img)"
          >
            ⬇
          </button>
          <button
            type="button"
            class="tool"
            :class="{ danger: confirmId === img.id }"
            :title="confirmId === img.id ? t('gallery.confirmDelete') : t('gallery.delete')"
            :aria-label="confirmId === img.id ? t('gallery.confirmDelete') : t('gallery.delete')"
            :disabled="!!busyId"
            data-test="gallery-delete"
            @click="remove(img)"
            @blur="confirmId === img.id && (confirmId = '')"
          >
            {{ confirmId === img.id ? t('gallery.confirmShort') : '🗑' }}
          </button>
        </div>
      </li>
    </ul>
    <p v-if="images.length" class="hint">{{ t('gallery.hint') }}</p>
  </div>
</template>

<style scoped>
.gallery {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--ds-border);
}
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.title {
  font-size: var(--ds-text-sm);
  font-weight: var(--ds-weight-semibold);
  color: var(--ds-text);
}
.title small {
  margin-left: 4px;
  font-weight: normal;
  font-size: var(--ds-text-xs);
  color: var(--ds-text-2);
}
.grid {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
  max-height: 340px;
  overflow-y: auto;
}
.cell {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.cell.busy {
  opacity: 0.6;
}
.badge {
  position: absolute;
  left: 6px;
  top: 6px;
  padding: 3px 6px;
  border-radius: var(--ds-radius-sm);
  background: var(--ds-surface-0);
  color: var(--ds-text);
  font-size: var(--ds-text-xs);
  line-height: 1;
}
.thumb {
  appearance: none;
  position: relative;
  display: block;
  width: 100%;
  padding: 0;
  border: 2px solid var(--ds-border);
  border-radius: var(--ds-radius-sm);
  background: var(--ds-surface-2);
  cursor: pointer;
  overflow: hidden;
  line-height: 0;
}
.thumb img {
  display: block;
  width: 100%;
  aspect-ratio: 16 / 10;
  object-fit: cover;
}
.thumb.on {
  border-color: var(--ds-accent);
  box-shadow: var(--ds-focus-ring);
}
.thumb:focus-visible,
.tool:focus-visible,
.btn:focus-visible {
  outline: none;
  box-shadow: var(--ds-focus-ring);
}
.thumb:disabled {
  cursor: not-allowed;
}
.tools {
  display: flex;
  gap: 3px;
}
.tool {
  appearance: none;
  flex: 1;
  min-width: 0;
  height: 26px;
  padding: 0 4px;
  border: 1px solid var(--ds-border-strong);
  border-radius: var(--ds-radius-sm);
  background: var(--ds-surface-0);
  color: var(--ds-text);
  font-size: var(--ds-text-xs);
  line-height: 1;
  cursor: pointer;
  white-space: nowrap;
}
.tool:hover:not(:disabled) {
  border-color: var(--ds-accent);
}
.tool.danger {
  flex: 2;
  border-color: var(--ds-danger);
  color: var(--ds-danger);
  font-weight: var(--ds-weight-semibold);
}
.tool:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.btn {
  appearance: none;
  border: 1px solid var(--ds-border-strong);
  background: transparent;
  color: var(--ds-text);
  border-radius: var(--ds-radius-md);
  padding: 4px 10px;
  font-size: var(--ds-text-xs);
  cursor: pointer;
}
.btn:hover:not(:disabled) {
  border-color: var(--ds-accent);
}
.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
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
</style>
