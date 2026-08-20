<script setup lang="ts">
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import { storeToRefs } from 'pinia'
import { useVideoEditorStore } from '@/stores/videoEditor'
import { useServerCut, CUT_CANCELLED } from '@/composables/useServerCut'
import { formatDisplayTime, getExtension } from '@/lib/ffmpegCommand'
import { saveFile, isAppleMobile } from '@/lib/download'
import Timeline from './Timeline.vue'

const { t } = useI18n()
const store = useVideoEditorStore()
const {
  objectUrl,
  fileName,
  duration,
  startTime,
  endTime,
  currentTime,
  mode,
  operation,
  segments,
  hasVideo,
  canExport,
  canAddSegment,
  effectiveSegments,
  selectionDuration,
  resultUrl,
  resultName,
  resultBlob,
  error,
} = storeToRefs(store)

const {
  isProcessing,
  progress,
  phase,
  uploadedBytes,
  totalBytes,
  bytesPerSec,
  cut: serverCut,
  cancel: serverCancel,
} = useServerCut()

const busy = computed(() => isProcessing.value)
const statusLabel = computed(() =>
  phase.value === 'upload' ? t('status.uploading') : t('status.processing'),
)

function formatMB(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(bytes < 100 * 1024 * 1024 ? 1 : 0)
}
function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '–'
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  return m > 0 ? `${m}:${String(s).padStart(2, '0')} min` : `${s} s`
}

// Detailzeile beim Upload: "45 / 380 MB · 1,8 MB/s · noch ~3:12 min".
const uploadDetail = computed(() => {
  if (phase.value !== 'upload' || totalBytes.value <= 0) return ''
  const parts = [`${formatMB(uploadedBytes.value)} / ${formatMB(totalBytes.value)} MB`]
  if (bytesPerSec.value > 0) {
    parts.push(`${(bytesPerSec.value / (1024 * 1024)).toFixed(1)} MB/s`)
    const remainingBytes = Math.max(0, totalBytes.value - uploadedBytes.value)
    parts.push(`${t('status.remaining')} ~${formatEta(remainingBytes / bytesPerSec.value)}`)
  }
  return parts.join(' · ')
})

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

// Start/Ende des (neuen) Ausschnitts auf die aktuelle Wiedergabeposition
// setzen. markStart/markEnd ziehen die Gegenseite bei Bedarf mit, damit sich
// ein Ausschnitt an beliebiger Stelle aufziehen lässt.
function setStartHere(): void {
  store.markStart(currentTime.value)
}

function setEndHere(): void {
  store.markEnd(currentTime.value)
}

// --- Numerische Zeiteingabe für Start/Ende -------------------------------
// Editierbare Felder; auf Commit setzen sie start/end (der Slider reagiert
// darüber automatisch). Akzeptiert "SS", "M:SS", "MM:SS", "H:MM:SS".
function parseTime(input: string): number | null {
  const s = input.trim().replace(',', '.')
  if (!s) return null
  const parts = s.split(':')
  if (parts.length > 3) return null
  if (!parts.every((p) => /^\d+(\.\d+)?$/.test(p))) return null
  return parts.reduce((acc, p) => acc * 60 + Number(p), 0)
}

const startInput = ref('')
const endInput = ref('')
// Felder mit den Store-Werten synchron halten (auch bei Slider-Ziehen).
watch(startTime, (v) => (startInput.value = formatDisplayTime(v)), { immediate: true })
watch(endTime, (v) => (endInput.value = formatDisplayTime(v)), { immediate: true })

function commitStart(): void {
  const t = parseTime(startInput.value)
  if (t !== null) {
    store.setStart(t)
    seekTo(startTime.value)
  }
  startInput.value = formatDisplayTime(startTime.value) // normalisieren/zurücksetzen
}

function commitEnd(): void {
  const t = parseTime(endInput.value)
  if (t !== null) {
    store.setEnd(t)
    seekTo(endTime.value)
  }
  endInput.value = formatDisplayTime(endTime.value)
}

// Stepper: Start/Ende um `delta` Sekunden anpassen (Slider + Vorschau folgen).
function stepStart(delta: number): void {
  store.setStart(startTime.value + delta)
  seekTo(startTime.value)
}
function stepEnd(delta: number): void {
  store.setEnd(endTime.value + delta)
  seekTo(endTime.value)
}

async function onExport(): Promise<void> {
  if (!store.file || !canExport.value) return
  store.setError('')
  store.revokeResult()
  try {
    const base = fileName.value.replace(/\.[^.]+$/, '') || 'video'
    const cutSegments = effectiveSegments.value.map((s) => ({
      start: s.start,
      duration: Math.max(0, s.end - s.start),
    }))
    // Container-Wahl (muss zur Server-Logik passen):
    //  - verlustfrei (copy behalten, genau ein Ausschnitt): Original-Endung.
    //  - sonst (entfernen, mehrere Ausschnitte, neu kodieren): WebM bleibt
    //    WebM, sonst .mp4.
    const inputExt = getExtension(fileName.value)
    const isWebm = inputExt === 'webm'
    const lossless = operation.value === 'keep' && mode.value === 'copy' && cutSegments.length === 1
    const ext = lossless ? inputExt : isWebm ? 'webm' : 'mp4'
    const blob = await serverCut(
      store.file,
      cutSegments,
      mode.value,
      operation.value,
      duration.value,
    )

    store.setResult(blob, `${base}_cut.${ext}`)
  } catch (e) {
    // Nutzer-Abbruch nicht als Fehler anzeigen.
    const msg = e instanceof Error ? e.message : String(e)
    if (msg !== CUT_CANCELLED) store.setError(msg)
  }
}

function onCancel(): void {
  serverCancel()
}

onBeforeUnmount(() => store.reset())

const appleMobile = isAppleMobile()

/** Ergebnis verwerfen: Vorschau schließen, Blob freigeben – Quellvideo bleibt geladen. */
function discardResult(): void {
  store.revokeResult()
}

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
        <button class="btn ghost" type="button" @click="store.reset()">
          {{ t('actions.change') }}
        </button>
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
        :segments="segments"
        :operation="operation"
        @update:start="store.setStart"
        @update:end="store.setEnd"
        @seek="seekTo"
      />

      <!-- In/Out setzen: numerisch eingeben; Slider reagiert automatisch -->
      <div class="marks">
        <div class="time-field">
          <label>{{ t('labels.start') }}</label>
          <input
            v-model="startInput"
            class="time-input"
            type="text"
            inputmode="numeric"
            :aria-label="t('labels.start')"
            @change="commitStart"
            @keydown.enter.prevent="commitStart"
          />
          <div class="stepper">
            <button
              class="step"
              type="button"
              :aria-label="t('actions.increase')"
              @click="stepStart(1)"
            >
              ▲
            </button>
            <button
              class="step"
              type="button"
              :aria-label="t('actions.decrease')"
              @click="stepStart(-1)"
            >
              ▼
            </button>
          </div>
          <button
            class="btn tiny"
            type="button"
            :title="t('actions.toPlayhead')"
            :aria-label="t('actions.toPlayhead')"
            @click="setStartHere"
          >
            ⏱
          </button>
        </div>

        <div class="sel">
          {{ t('labels.selection') }}: <b>{{ formatDisplayTime(selectionDuration) }}</b>
        </div>

        <div class="time-field">
          <label>{{ t('labels.end') }}</label>
          <input
            v-model="endInput"
            class="time-input"
            type="text"
            inputmode="numeric"
            :aria-label="t('labels.end')"
            @change="commitEnd"
            @keydown.enter.prevent="commitEnd"
          />
          <div class="stepper">
            <button
              class="step"
              type="button"
              :aria-label="t('actions.increase')"
              @click="stepEnd(1)"
            >
              ▲
            </button>
            <button
              class="step"
              type="button"
              :aria-label="t('actions.decrease')"
              @click="stepEnd(-1)"
            >
              ▼
            </button>
          </div>
          <button
            class="btn tiny"
            type="button"
            :title="t('actions.toPlayhead')"
            :aria-label="t('actions.toPlayhead')"
            @click="setEndHere"
          >
            ⏱
          </button>
        </div>
      </div>

      <!-- Ausschnitt-Liste: aktuelle Auswahl festhalten, mehrere möglich -->
      <div class="segments">
        <div class="segments-head">
          <span class="segments-title">{{ t('segments.title') }}</span>
          <button
            class="btn tiny add"
            type="button"
            :disabled="!canAddSegment"
            @click="store.addSegment()"
          >
            ＋ {{ t('segments.add') }}
          </button>
        </div>

        <ul v-if="segments.length" class="segments-list">
          <li v-for="(seg, i) in segments" :key="i" class="segment-row">
            <span class="segment-index">{{ i + 1 }}</span>
            <span class="segment-time">
              {{ formatDisplayTime(seg.start) }} – {{ formatDisplayTime(seg.end) }}
              <small>({{ formatDisplayTime(Math.max(0, seg.end - seg.start)) }})</small>
            </span>
            <button
              class="btn tiny remove"
              type="button"
              :aria-label="t('segments.remove')"
              :title="t('segments.remove')"
              @click="store.removeSegment(i)"
            >
              ✕
            </button>
          </li>
        </ul>
        <p v-else class="segments-empty">{{ t('segments.empty') }}</p>

        <p class="segments-hint">{{ t('segments.hint') }}</p>
      </div>

      <!-- Aktion: Auswahl behalten oder entfernen -->
      <fieldset class="mode">
        <legend>{{ t('operation.legend') }}</legend>
        <label class="radio" :class="{ active: operation === 'keep' }">
          <input
            type="radio"
            value="keep"
            :checked="operation === 'keep'"
            @change="store.setOperation('keep')"
          />
          <span>
            <b>{{ t('operation.keep') }}</b>
            <small>{{ t('operation.keepHint') }}</small>
          </span>
        </label>
        <label class="radio" :class="{ active: operation === 'remove' }">
          <input
            type="radio"
            value="remove"
            :checked="operation === 'remove'"
            @change="store.setOperation('remove')"
          />
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
          <input
            type="radio"
            value="copy"
            :checked="mode === 'copy'"
            @change="store.setMode('copy')"
          />
          <span>
            <b>{{ t('mode.fast') }}</b>
            <small>{{ t('mode.fastHint') }}</small>
          </span>
        </label>
        <label class="radio" :class="{ active: mode === 'reencode' }">
          <input
            type="radio"
            value="reencode"
            :checked="mode === 'reencode'"
            @change="store.setMode('reencode')"
          />
          <span>
            <b>{{ t('mode.accurate') }}</b>
            <small>{{ t('mode.accurateHint') }}</small>
          </span>
        </label>
      </fieldset>
      <p v-else class="reencode-note">{{ t('operation.removeNote') }}</p>

      <!-- Export -->
      <button
        class="btn primary export"
        type="button"
        :disabled="!canExport || busy"
        @click="onExport"
      >
        <template v-if="isProcessing">{{ statusLabel }} {{ progress }}%</template>
        <template v-else>{{ t('actions.export') }}</template>
      </button>

      <div v-if="busy" class="progress" role="progressbar" :aria-valuenow="progress">
        <div class="bar" :style="{ width: `${progress}%` }"></div>
      </div>
      <p v-if="uploadDetail" class="upload-detail">{{ uploadDetail }}</p>

      <button v-if="busy" class="btn ghost cancel" type="button" @click="onCancel">
        {{ t('actions.cancel') }}
      </button>

      <p v-if="error" class="error" role="alert">{{ error }}</p>

      <!-- Ergebnis -->
      <div v-if="resultUrl" class="result">
        <p class="result-title">{{ t('result.ready') }}</p>
        <video class="player" :src="resultUrl" controls preload="metadata"></video>
        <div class="result-actions">
          <a class="btn primary" :href="resultUrl" :download="resultName" @click="onDownload">
            {{ t('actions.download') }} — {{ resultName }}
          </a>
          <button class="btn ghost" type="button" @click="discardResult">
            {{ t('actions.discard') }}
          </button>
          <button class="btn ghost" type="button" @click="store.reset()">
            {{ t('actions.change') }}
          </button>
        </div>
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
  transition:
    border-color 0.15s,
    background 0.15s;
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
.dz-title {
  font-weight: 600;
  font-size: 16px;
}
.dz-hint {
  color: var(--vc-text-dim);
  font-size: 14px;
}

/* Editor */
.editor {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

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
.time-field {
  display: flex;
  align-items: center;
  gap: 6px;
}
.time-field label {
  font-size: 13px;
  color: var(--vc-text-dim);
}
.time-input {
  width: 84px;
  padding: 7px 8px;
  border: 1px solid var(--vc-border);
  border-radius: 8px;
  background: var(--vc-surface);
  color: var(--vc-text);
  font-size: 14px;
  font-variant-numeric: tabular-nums;
  text-align: center;
}
.time-input:focus-visible {
  outline: 2px solid var(--vc-focus);
  outline-offset: 1px;
  border-color: var(--vc-accent);
}
.btn.tiny {
  padding: 6px 9px;
  font-size: 14px;
  line-height: 1;
}
.stepper {
  display: flex;
  flex-direction: column;
}
.step {
  width: 24px;
  height: 17px;
  padding: 0;
  display: grid;
  place-items: center;
  border: 1px solid var(--vc-border);
  background: var(--vc-surface);
  color: var(--vc-text);
  cursor: pointer;
  font-size: 9px;
  line-height: 1;
}
.step:first-child {
  border-radius: 6px 6px 0 0;
  border-bottom: none;
}
.step:last-child {
  border-radius: 0 0 6px 6px;
}
.step:hover {
  border-color: var(--vc-accent);
  color: var(--vc-accent);
}
.step:focus-visible {
  outline: 2px solid var(--vc-focus);
  outline-offset: 1px;
}

/* Ausschnitt-Liste */
.segments {
  display: flex;
  flex-direction: column;
  gap: 8px;
  border: 1px solid var(--vc-border);
  border-radius: 10px;
  padding: 12px;
}
.segments-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.segments-title {
  font-size: 13px;
  color: var(--vc-text-dim);
}
.btn.tiny.add {
  font-size: 13px;
  padding: 6px 10px;
}
.segments-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.segment-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border: 1px solid var(--vc-border);
  border-radius: 8px;
  background: var(--vc-surface);
}
.segment-index {
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--vc-accent);
  color: #fff;
  font-size: 12px;
  font-weight: 600;
  flex: none;
}
.segment-time {
  flex: 1;
  font-size: 14px;
  font-variant-numeric: tabular-nums;
}
.segment-time small {
  color: var(--vc-text-dim);
}
.btn.tiny.remove {
  padding: 4px 8px;
  line-height: 1;
}
.segments-empty {
  margin: 0;
  font-size: 12px;
  color: var(--vc-text-dim);
}
.segments-hint {
  margin: 0;
  font-size: 12px;
  color: var(--vc-text-dim);
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
.mode legend {
  padding: 0 6px;
  font-size: 13px;
  color: var(--vc-text-dim);
}
.radio {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 10px;
  border: 1px solid var(--vc-border);
  border-radius: 8px;
  cursor: pointer;
}
.radio.active {
  border-color: var(--vc-accent);
  background: var(--vc-accent-soft);
}
.radio span {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.radio small {
  color: var(--vc-text-dim);
  font-size: 12px;
}

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
  transition:
    background 0.15s,
    border-color 0.15s,
    opacity 0.15s;
}
.btn:hover {
  border-color: var(--vc-accent);
}
.btn.ghost {
  background: transparent;
}
.btn.primary {
  background: var(--vc-accent);
  border-color: var(--vc-accent);
  color: #fff;
  font-weight: 600;
}
.btn.primary:hover {
  filter: brightness(1.08);
}
.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.btn:focus-visible {
  outline: 2px solid var(--vc-focus);
  outline-offset: 2px;
}
.export {
  align-self: stretch;
  padding: 12px;
}
a.btn {
  text-decoration: none;
  text-align: center;
  display: inline-block;
}

/* Progress */
.progress {
  height: 8px;
  border-radius: 6px;
  background: var(--vc-track-bg);
  overflow: hidden;
}
.bar {
  height: 100%;
  background: var(--vc-accent);
  transition: width 0.2s;
}

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

.upload-detail {
  margin: -4px 0 0;
  font-size: 12px;
  color: var(--vc-text-dim);
  text-align: center;
  font-variant-numeric: tabular-nums;
}

.cancel {
  align-self: center;
}

.result {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.result-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.result-actions .btn {
  flex: 1 1 auto;
}
.result-actions .btn.primary {
  flex: 2 1 240px;
}
.result-title {
  font-weight: 600;
  margin: 0;
}
.result-hint {
  margin: 0;
  font-size: 12px;
  color: var(--vc-text-dim);
}

@media (max-width: 560px) {
  .mode {
    grid-template-columns: 1fr;
  }
}
@media (prefers-reduced-motion: reduce) {
  .bar {
    transition: none;
  }
}
</style>
