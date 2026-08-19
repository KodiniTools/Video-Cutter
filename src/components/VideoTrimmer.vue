<script setup lang="ts">
import { ref, computed, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import { storeToRefs } from 'pinia'
import { useVideoEditorStore } from '@/stores/videoEditor'
import { useServerCut } from '@/composables/useServerCut'
import { formatDisplayTime, getExtension } from '@/lib/ffmpegCommand'
import { saveFile, isAppleMobile } from '@/lib/download'
import Timeline from './Timeline.vue'

const { t } = useI18n()
const store = useVideoEditorStore()
const {
  objectUrl, fileName, duration, startTime, endTime, currentTime, mode, operation,
  hasVideo, canExport, selectionDuration, resultUrl, resultName, resultBlob, error,
} = storeToRefs(store)

const { isProcessing, progress, phase, cut: serverCut } = useServerCut()

const busy = computed(() => isProcessing.value)
const statusLabel = computed(() =>
  phase.value === 'upload' ? t('status.uploading') : t('status.processing'),
)

const videoEl = ref<HTMLVideoElement | null>(null)
const isDragOver = ref(false)

function pickFile(files: FileList | null): void {
  const f = files?.[0]
  if (!f) return
  if (!f.type.startsWith('video/')) {
    store.setError(t('errors.notVideo'))
    return
  }
  store.setFile(f)
}

function onInputChange(e: Event): void {
  const target = e.target as HTMLInputElement
  pickFile(target.files)
  target.value = '' // erneutes Auswählen derselben Datei erlauben
}

function onDrop(e: DragEvent): void {
  isDragOver.value = false
  pickFile(e.dataTransfer?.files ?? null)
}

function onLoadedMetadata(): void {
  store.setDuration(videoEl.value?.duration ?? 0)
}

function onTimeUpdate(): void {
  store.setCurrentTime(videoEl.value?.currentTime ?? 0)
}

function seekTo(sec: number): void {
  if (videoEl.value) videoEl.value.currentTime = sec
  store.setCurrentTime(sec)
}

function setStartHere(): void {
  store.setStart(currentTime.value)
}

function setEndHere(): void {
  store.setEnd(currentTime.value)
}

async function onExport(): Promise<void> {
  if (!store.file || !canExport.value) return
  store.setError('')
  store.revokeResult()
  try {
    const base = fileName.value.replace(/\.[^.]+$/, '') || 'video'
    // 'remove' fügt Segmente zusammen -> immer Re-Encode -> mp4.
    const ext =
      operation.value === 'remove' ? 'mp4' : mode.value === 'copy' ? getExtension(fileName.value) : 'mp4'
    const blob = await serverCut(
      store.file,
      startTime.value,
      selectionDuration.value,
      mode.value,
      operation.value,
      duration.value,
    )

    store.setResult(blob, `${base}_cut.${ext}`)
  } catch (e) {
    store.setError(e instanceof Error ? e.message : String(e))
  }
}

onBeforeUnmount(() => store.reset())

const appleMobile = isAppleMobile()

async function onDownload(e: MouseEvent): Promise<void> {
  const blob = resultBlob.value
  if (!blob) return // ohne Blob: nativen <a>-Download nicht verhindern
  // Einheitlicher, robuster Pfad (iOS-Teilen / Anker / neuer Tab).
  e.preventDefault()
  try {
    await saveFile({ blob, name: resultName.value })
  } catch (err) {
    store.setError(err instanceof Error ? err.message : String(err))
  }
}
</script>

<template>
  <section class="trimmer">
    <!-- Upload / Dropzone -->
    <label
      v-if="!hasVideo"
      class="dropzone"
      :class="{ over: isDragOver }"
      @dragover.prevent="isDragOver = true"
      @dragleave.prevent="isDragOver = false"
      @drop.prevent="onDrop"
    >
      <input type="file" accept="video/*" class="sr-only" @change="onInputChange" />
      <div class="dz-icon" aria-hidden="true">▶</div>
      <p class="dz-title">{{ t('drop.title') }}</p>
      <p class="dz-hint">{{ t('drop.hint') }}</p>
    </label>

    <!-- Editor -->
    <div v-else class="editor">
      <div class="filebar">
        <span class="filename" :title="fileName">{{ fileName }}</span>
        <button class="btn ghost" type="button" @click="store.reset()">{{ t('actions.change') }}</button>
      </div>

      <video
        ref="videoEl"
        class="player"
        :src="objectUrl"
        controls
        preload="metadata"
        @loadedmetadata="onLoadedMetadata"
        @timeupdate="onTimeUpdate"
      ></video>

      <Timeline
        :duration="duration"
        :start="startTime"
        :end="endTime"
        :current="currentTime"
        @update:start="store.setStart"
        @update:end="store.setEnd"
        @seek="seekTo"
      />

      <!-- In/Out setzen -->
      <div class="marks">
        <button class="btn" type="button" @click="setStartHere">
          {{ t('actions.setStart') }} <b>{{ formatDisplayTime(startTime) }}</b>
        </button>
        <div class="sel">
          {{ t('labels.selection') }}: <b>{{ formatDisplayTime(selectionDuration) }}</b>
        </div>
        <button class="btn" type="button" @click="setEndHere">
          {{ t('actions.setEnd') }} <b>{{ formatDisplayTime(endTime) }}</b>
        </button>
      </div>

      <!-- Aktion: Auswahl behalten oder entfernen -->
      <fieldset class="mode">
        <legend>{{ t('operation.legend') }}</legend>
        <label class="radio" :class="{ active: operation === 'keep' }">
          <input type="radio" value="keep" :checked="operation === 'keep'" @change="store.setOperation('keep')" />
          <span>
            <b>{{ t('operation.keep') }}</b>
            <small>{{ t('operation.keepHint') }}</small>
          </span>
        </label>
        <label class="radio" :class="{ active: operation === 'remove' }">
          <input type="radio" value="remove" :checked="operation === 'remove'" @change="store.setOperation('remove')" />
          <span>
            <b>{{ t('operation.remove') }}</b>
            <small>{{ t('operation.removeHint') }}</small>
          </span>
        </label>
      </fieldset>

      <!-- Modus (nur beim Behalten relevant; Entfernen kodiert immer neu) -->
      <fieldset v-if="operation === 'keep'" class="mode">
        <legend>{{ t('mode.legend') }}</legend>
        <label class="radio" :class="{ active: mode === 'copy' }">
          <input type="radio" value="copy" :checked="mode === 'copy'" @change="store.setMode('copy')" />
          <span>
            <b>{{ t('mode.fast') }}</b>
            <small>{{ t('mode.fastHint') }}</small>
          </span>
        </label>
        <label class="radio" :class="{ active: mode === 'reencode' }">
          <input type="radio" value="reencode" :checked="mode === 'reencode'" @change="store.setMode('reencode')" />
          <span>
            <b>{{ t('mode.accurate') }}</b>
            <small>{{ t('mode.accurateHint') }}</small>
          </span>
        </label>
      </fieldset>
      <p v-else class="reencode-note">{{ t('operation.removeNote') }}</p>

      <!-- Export -->
      <button class="btn primary export" type="button" :disabled="!canExport || busy" @click="onExport">
        <template v-if="isProcessing">{{ statusLabel }} {{ progress }}%</template>
        <template v-else>{{ t('actions.export') }}</template>
      </button>

      <div v-if="busy" class="progress" role="progressbar" :aria-valuenow="progress">
        <div class="bar" :style="{ width: `${progress}%` }"></div>
      </div>

      <p v-if="error" class="error" role="alert">{{ error }}</p>

      <!-- Ergebnis -->
      <div v-if="resultUrl" class="result">
        <p class="result-title">{{ t('result.ready') }}</p>
        <video class="player" :src="resultUrl" controls preload="metadata"></video>
        <a class="btn primary" :href="resultUrl" :download="resultName" @click="onDownload">
          {{ t('actions.download') }} — {{ resultName }}
        </a>
        <p v-if="appleMobile" class="result-hint">{{ t('result.iosHint') }}</p>
      </div>
    </div>
  </section>
</template>

<style scoped>
.trimmer {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

/* Dropzone */
.dropzone {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 56px 24px;
  border: 2px dashed var(--vc-border);
  border-radius: 14px;
  background: var(--vc-surface);
  cursor: pointer;
  text-align: center;
  transition: border-color 0.15s, background 0.15s;
}
.dropzone.over {
  border-color: var(--vc-accent);
  background: var(--vc-accent-soft);
}
.dz-icon {
  width: 52px;
  height: 52px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: var(--vc-accent);
  color: #fff;
  font-size: 20px;
}
.dz-title { font-weight: 600; font-size: 16px; }
.dz-hint { color: var(--vc-text-dim); font-size: 14px; }

/* Editor */
.editor { display: flex; flex-direction: column; gap: 14px; }

.filebar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.filename {
  font-size: 14px;
  color: var(--vc-text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.player {
  width: 100%;
  max-height: 52vh;
  border-radius: 10px;
  background: #000;
}

.marks {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.sel {
  font-size: 14px;
  color: var(--vc-text-dim);
  font-variant-numeric: tabular-nums;
}

/* Modus */
.mode {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  border: 1px solid var(--vc-border);
  border-radius: 10px;
  padding: 12px;
}
.mode legend { padding: 0 6px; font-size: 13px; color: var(--vc-text-dim); }
.radio {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 10px;
  border: 1px solid var(--vc-border);
  border-radius: 8px;
  cursor: pointer;
}
.radio.active { border-color: var(--vc-accent); background: var(--vc-accent-soft); }
.radio span { display: flex; flex-direction: column; gap: 2px; }
.radio small { color: var(--vc-text-dim); font-size: 12px; }

/* Buttons */
.btn {
  appearance: none;
  border: 1px solid var(--vc-border);
  background: var(--vc-surface);
  color: var(--vc-text);
  padding: 9px 14px;
  border-radius: 8px;
  font-size: 14px;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s, opacity 0.15s;
}
.btn:hover { border-color: var(--vc-accent); }
.btn.ghost { background: transparent; }
.btn.primary {
  background: var(--vc-accent);
  border-color: var(--vc-accent);
  color: #fff;
  font-weight: 600;
}
.btn.primary:hover { filter: brightness(1.08); }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn:focus-visible { outline: 2px solid var(--vc-focus); outline-offset: 2px; }
.export { align-self: stretch; padding: 12px; }
a.btn { text-decoration: none; text-align: center; display: inline-block; }

/* Progress */
.progress {
  height: 8px;
  border-radius: 6px;
  background: var(--vc-track-bg);
  overflow: hidden;
}
.bar { height: 100%; background: var(--vc-accent); transition: width 0.2s; }

.error {
  margin: 0;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--vc-error-bg);
  color: var(--vc-error-text);
  font-size: 14px;
}

.reencode-note {
  margin: -4px 0 0;
  font-size: 12px;
  color: var(--vc-text-dim);
}

.result { display: flex; flex-direction: column; gap: 10px; }
.result-title { font-weight: 600; margin: 0; }
.result-hint { margin: 0; font-size: 12px; color: var(--vc-text-dim); }

@media (max-width: 560px) {
  .mode { grid-template-columns: 1fr; }
}
@media (prefers-reduced-motion: reduce) {
  .bar { transition: none; }
}
</style>
