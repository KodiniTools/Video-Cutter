<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import { storeToRefs } from 'pinia'
import { useVideoEditorStore } from '@/stores/videoEditor'
import { useServerCut, CUT_CANCELLED, CROP_UNSUPPORTED } from '@/composables/useServerCut'
import { useAnimationPref, MIN_DURATION, MAX_DURATION } from '@/composables/useAnimationPref'
import { getExtension } from '@/lib/ffmpegCommand'
import { formatTimeMs, parseTimeInput, toMs } from '@/lib/timeFormat'
import { saveFile, isAppleMobile } from '@/lib/download'
import Timeline from './Timeline.vue'
import DropdownMenu from './DropdownMenu.vue'
import CropOverlay from './CropOverlay.vue'

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
  crop,
  hasCrop,
  cropPixelSize,
  hasVideo,
  canExport,
  canAddSegment,
  canUndo,
  canRedo,
  effectiveSegments,
  selectionDuration,
  resultName,
  resultBlob,
  hasResult,
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

const { animation, duration: animDuration, transitionName, animations } = useAnimationPref()

const busy = computed(() => isProcessing.value)
const statusLabel = computed(() =>
  phase.value === 'upload' ? t('status.uploading') : t('status.processing'),
)

// Beschriftungen für die Menü-Buttons oben am Canvas.
const operationLabel = computed(() =>
  operation.value === 'keep' ? t('operation.keep') : t('operation.remove'),
)

// Auswahl im Menü treffen und das Menü schließen.
function pickOperation(op: 'keep' | 'remove', close: () => void): void {
  store.setOperation(op)
  close()
}
function pickMode(m: 'copy' | 'reencode', close: () => void): void {
  store.setMode(m)
  close()
}
// Beim Entfernen ODER bei aktivem Zuschnitt wird immer neu kodiert -> Modus
// ist dann fest & deaktiviert (Zuschneiden erfordert Decode+Encode).
const modeDisabled = computed(() => operation.value === 'remove' || hasCrop.value)
const modeLabel = computed(() =>
  modeDisabled.value
    ? t('mode.accurate')
    : mode.value === 'copy'
      ? t('mode.fast')
      : t('mode.accurate'),
)

// --- Bildausschnitt (Crop) ------------------------------------------------
function onCropUpdate(rect: { x: number; y: number; width: number; height: number }): void {
  store.setCrop(rect)
}
function onToggleCrop(): void {
  store.toggleCrop()
}
const cropSizeLabel = computed(() => {
  if (!crop.value) return ''
  const pct = `${Math.round(crop.value.width * 100)}% × ${Math.round(crop.value.height * 100)}%`
  return cropPixelSize.value
    ? `${cropPixelSize.value.width}×${cropPixelSize.value.height}px (${pct})`
    : pct
})

function formatMB(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(bytes < 100 * 1024 * 1024 ? 1 : 0)
}
/** Menschlich lesbare Dateigröße (KB / MB / GB). */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return ''
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(0)} KB`
  const mb = kb / 1024
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`
  return `${(mb / 1024).toFixed(2)} GB`
}
const fileSizeLabel = computed(() => (store.file ? formatBytes(store.file.size) : ''))
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

// Beim In-place-Wechsel (Ergebnis wird zum neuen Arbeitsvideo) muss die Dauer
// neu gelesen werden. Ein fragmentiertes MP4 (client-seitiger Remux) meldet
// anfangs `Infinity` – dann bis ans Ende springen, damit der Browser die echte
// Dauer ermittelt (kommt danach per `durationchange`).
let seekingForDuration = false

function readDuration(): void {
  const el = videoEl.value
  if (!el) return
  const d = el.duration
  if (Number.isFinite(d) && d > 0) {
    if (seekingForDuration) {
      seekingForDuration = false
      el.currentTime = 0
    }
    store.setDuration(d)
  } else if (d === Infinity && !seekingForDuration) {
    seekingForDuration = true
    try {
      el.currentTime = 1e101
    } catch {
      seekingForDuration = false
    }
  }
}

function onLoadedMetadata(): void {
  readDuration()
  const el = videoEl.value
  if (el) store.setVideoDimensions(el.videoWidth, el.videoHeight)
}

function onDurationChange(): void {
  readDuration()
}

function onTimeUpdate(): void {
  if (seekingForDuration) return // Erzwungenes Spulen nicht als Position werten.
  store.setCurrentTime(videoEl.value?.currentTime ?? 0)
}

// Quelle gewechselt (neues Video ODER Schnitt-Ergebnis) -> Element sicher neu
// laden, damit loadedmetadata/durationchange erneut feuern und die Dauer stimmt.
// Ohne URL (Video gelöscht) gibt es nichts zu laden: Der Player wird dann
// ausgehängt und trüge noch die alte src – ein load() darauf würde die
// bereits freigegebene Blob-URL erneut anfordern (ERR_FILE_NOT_FOUND).
watch(objectUrl, (url) => {
  seekingForDuration = false
  const el = videoEl.value
  if (!el || !url) return
  nextTick(() => {
    if (el.isConnected) el.load()
  })
})

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

// --- Numerische Zeiteingabe für Start/Ende (ms-genau, wie im Audio-Cutter) --
// Textfeld "[hh:]mm:ss.mmm" + ms-Zahlenfeld mit Spinner + Nudge-Buttons.
// Auf Commit setzen sie Start/Ende im Store (Slider + Vorschau folgen).
const startInput = ref('')
const endInput = ref('')
// Felder mit den Store-Werten synchron halten (auch bei Slider-Ziehen).
watch(startTime, (v) => (startInput.value = formatTimeMs(v)), { immediate: true })
watch(endTime, (v) => (endInput.value = formatTimeMs(v)), { immediate: true })

function applyStart(sec: number): void {
  store.setStart(sec)
  seekTo(startTime.value) // geclampten Wert übernehmen
}
function applyEnd(sec: number): void {
  store.setEnd(sec)
  seekTo(endTime.value)
}

function commitStart(): void {
  const sec = parseTimeInput(startInput.value)
  if (sec !== null) applyStart(sec)
  startInput.value = formatTimeMs(startTime.value) // normalisieren/zurücksetzen
}
function commitEnd(): void {
  const sec = parseTimeInput(endInput.value)
  if (sec !== null) applyEnd(sec)
  endInput.value = formatTimeMs(endTime.value)
}

/** Ganzzahlige ms für die nativen Spinner (input type=number). */
const startMs = computed({
  get: () => toMs(startTime.value),
  set: (v: number | string) => {
    const ms = Number(v)
    if (Number.isFinite(ms)) applyStart(ms / 1000)
  },
})
const endMs = computed({
  get: () => toMs(endTime.value),
  set: (v: number | string) => {
    const ms = Number(v)
    if (Number.isFinite(ms)) applyEnd(ms / 1000)
  },
})
const maxMs = computed(() => toMs(duration.value))

/** Feinjustierung in Millisekunden (±1 / ±10 / ±100 ms). */
const nudges = [-100, -10, -1, 1, 10, 100] as const
function nudgeStart(deltaMs: number): void {
  applyStart(startTime.value + deltaMs / 1000)
}
function nudgeEnd(deltaMs: number): void {
  applyEnd(endTime.value + deltaMs / 1000)
}
function fmtDelta(d: number): string {
  return `${d > 0 ? '+' : ''}${d}`
}

/** Auswahl auf die volle Länge zurücksetzen -> neu wählbar. */
function resetSelection(): void {
  store.setEnd(duration.value)
  store.setStart(0)
}
/** Auswahl ist nicht bereits die volle Länge? (Reset dann sinnvoll) */
const canReset = computed(() => startTime.value > 0 || endTime.value < duration.value)

/** Live-Werte: "mm:ss.mmm · 1234 ms" (wie die Statuszeile des Audio-Cutters). */
function msLabel(sec: number): string {
  return `${formatTimeMs(sec)} · ${toMs(sec)} ms`
}
const remainingTime = computed(() => Math.max(0, duration.value - currentTime.value))

async function onExport(): Promise<void> {
  if (!store.file || !canExport.value) return
  store.setError('')
  try {
    // Vorhandenes „_cut" nicht stapeln (kumulatives Schneiden).
    const base = fileName.value.replace(/\.[^.]+$/, '').replace(/_cut$/, '') || 'video'
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
      { preset: animation.value, duration: animDuration.value },
      crop.value ?? undefined,
    )

    store.applyCutResult(blob, `${base}_cut.${ext}`)
  } catch (e) {
    // Nutzer-Abbruch nicht als Fehler anzeigen.
    const msg = e instanceof Error ? e.message : String(e)
    if (msg === CUT_CANCELLED) return
    store.setError(msg === CROP_UNSUPPORTED ? t('errors.cropUnsupported') : msg)
  }
}

function onCancel(): void {
  serverCancel()
}

/** Geladenes Video entfernen und zur Upload-Ansicht zurückkehren. */
function onDeleteVideo(): void {
  if (busy.value) {
    serverCancel() // laufenden Upload/Job stoppen
  }
  store.reset()
}

// --- Undo/Redo -----------------------------------------------------------
function onUndo(): void {
  if (canUndo.value) store.undo()
}
function onRedo(): void {
  if (canRedo.value) store.redo()
}

// Tastatur: Strg/Cmd+Z = rückgängig, Strg/Cmd+Shift+Z bzw. Strg+Y = wieder.
function onKeydown(e: KeyboardEvent): void {
  if (!hasVideo.value || busy.value) return
  const meta = e.ctrlKey || e.metaKey
  if (!meta) return
  const key = e.key.toLowerCase()
  // In Textfeldern die native Bearbeitung nicht überschreiben.
  const target = e.target as HTMLElement | null
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
  if (key === 'z' && !e.shiftKey) {
    e.preventDefault()
    onUndo()
  } else if ((key === 'z' && e.shiftKey) || key === 'y') {
    e.preventDefault()
    onRedo()
  }
}

// --- Animations-Menü -----------------------------------------------------
const currentAnimLabel = computed(
  () => animations.find((a) => a.id === animation.value)?.labelKey ?? 'anim.fade',
)
function pickAnimation(id: (typeof animations)[number]['id'], close: () => void): void {
  animation.value = id
  close()
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  store.reset()
})

const appleMobile = isAppleMobile()

/** Lädt das aktuelle Schnitt-Ergebnis herunter (getrennt vom Schneiden). */
async function downloadResult(): Promise<void> {
  const blob = resultBlob.value
  if (!blob) return
  // Einheitlicher, robuster Pfad (iOS-Teilen / Anker / neuer Tab).
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
      <p class="dz-title" data-slot="drop.title">{{ t('drop.title') }}</p>
      <p class="dz-hint" data-slot="drop.hint">{{ t('drop.hint') }}</p>
    </label>

    <!-- Editor -->
    <div v-else class="editor">
      <div class="filebar">
        <span class="fileinfo">
          <span class="filename" :title="fileName">{{ fileName }}</span>
          <span v-if="fileSizeLabel" class="filesize">{{ fileSizeLabel }}</span>
        </span>
        <div class="filebar-actions">
          <div class="history">
            <button
              class="btn tiny"
              type="button"
              :disabled="!canUndo"
              :title="`${t('actions.undo')} (Ctrl+Z)`"
              :aria-label="t('actions.undo')"
              @click="onUndo"
            >
              ↶
            </button>
            <button
              class="btn tiny"
              type="button"
              :disabled="!canRedo"
              :title="`${t('actions.redo')} (Ctrl+Shift+Z)`"
              :aria-label="t('actions.redo')"
              @click="onRedo"
            >
              ↷
            </button>
          </div>
          <button class="btn ghost" type="button" @click="store.reset()">
            {{ t('actions.change') }}
          </button>
          <button class="btn ghost danger" type="button" @click="onDeleteVideo">
            🗑 {{ t('actions.removeVideo') }}
          </button>
        </div>
      </div>

      <div class="editor-grid">
        <!-- LINKS: Auswahl & Ausschnitte -->
        <div class="panel panel-left">
          <!-- Auswahl: numerisch eingeben; Slider reagiert automatisch -->
          <section class="card">
            <h3 class="panel-title">{{ t('labels.selection') }}</h3>
            <div class="marks">
              <div class="time-card">
                <label class="time-label" for="start-text">{{ t('labels.start') }}</label>
                <div class="time-main">
                  <input
                    id="start-text"
                    v-model="startInput"
                    class="time-input start"
                    type="text"
                    inputmode="decimal"
                    :placeholder="t('time.placeholder')"
                    :aria-label="t('labels.start')"
                    @change="commitStart"
                    @keydown.enter.prevent="commitStart"
                  />
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
                <div class="ms-field">
                  <input
                    v-model.number="startMs"
                    class="time-input ms start"
                    type="number"
                    :min="0"
                    :max="maxMs"
                    step="1"
                    :aria-label="`${t('labels.start')} (ms)`"
                  />
                  <span class="ms-unit">{{ t('time.ms') }}</span>
                </div>
                <div class="nudges">
                  <button
                    v-for="d in nudges"
                    :key="`s${d}`"
                    class="btn tiny nudge"
                    type="button"
                    @click="nudgeStart(d)"
                  >
                    {{ fmtDelta(d) }}{{ t('time.ms') }}
                  </button>
                </div>
              </div>

              <div class="time-card">
                <label class="time-label" for="end-text">{{ t('labels.end') }}</label>
                <div class="time-main">
                  <input
                    id="end-text"
                    v-model="endInput"
                    class="time-input end"
                    type="text"
                    inputmode="decimal"
                    :placeholder="t('time.placeholder')"
                    :aria-label="t('labels.end')"
                    @change="commitEnd"
                    @keydown.enter.prevent="commitEnd"
                  />
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
                <div class="ms-field">
                  <input
                    v-model.number="endMs"
                    class="time-input ms end"
                    type="number"
                    :min="0"
                    :max="maxMs"
                    step="1"
                    :aria-label="`${t('labels.end')} (ms)`"
                  />
                  <span class="ms-unit">{{ t('time.ms') }}</span>
                </div>
                <div class="nudges">
                  <button
                    v-for="d in nudges"
                    :key="`e${d}`"
                    class="btn tiny nudge"
                    type="button"
                    @click="nudgeEnd(d)"
                  >
                    {{ fmtDelta(d) }}{{ t('time.ms') }}
                  </button>
                </div>
              </div>

              <div class="sel">
                <span>
                  {{ t('labels.selection') }}: <b>{{ formatTimeMs(selectionDuration) }}</b>
                  <span class="sel-total"> / {{ formatTimeMs(duration) }}</span>
                </span>
                <span v-if="canAddSegment" class="sel-valid">{{ t('time.valid') }}</span>
                <span v-else class="sel-invalid">{{ t('time.invalid') }}</span>
                <button
                  class="btn tiny ghost"
                  type="button"
                  :disabled="!canReset"
                  :title="t('time.reset')"
                  @click="resetSelection"
                >
                  ↺ {{ t('time.reset') }}
                </button>
              </div>
            </div>
          </section>

          <!-- Ausschnitt-Liste: aktuelle Auswahl festhalten, mehrere möglich -->
          <section class="card segments">
            <div class="card-head">
              <h3 class="panel-title">{{ t('segments.title') }}</h3>
              <span v-if="segments.length" class="count">{{ segments.length }}</span>
            </div>

            <button
              class="btn block add"
              type="button"
              :disabled="!canAddSegment"
              @click="store.addSegment()"
            >
              {{ t('segments.add') }}
            </button>

            <div class="field-row">
              <span class="field-label">{{ t('anim.menu') }}</span>
              <DropdownMenu :label="t(currentAnimLabel)">
                <template #default="{ close }">
                  <button
                    v-for="a in animations"
                    :key="a.id"
                    class="menu-option"
                    :class="{ active: animation === a.id }"
                    type="button"
                    role="menuitemradio"
                    :aria-checked="animation === a.id"
                    @click="pickAnimation(a.id, close)"
                  >
                    <span class="menu-check">{{ animation === a.id ? '✓' : '' }}</span>
                    <span class="menu-text">
                      <b>{{ t(a.labelKey) }}</b>
                    </span>
                  </button>
                </template>
              </DropdownMenu>
            </div>

            <!-- Übergangsdauer (nur relevant, wenn ein Übergang gewählt ist) -->
            <div class="field-col" :class="{ disabled: animation === 'none' }">
              <div class="field-row">
                <label for="anim-duration" class="field-label">{{ t('anim.duration') }}</label>
                <span class="field-value">{{ animDuration }} s</span>
              </div>
              <input
                id="anim-duration"
                v-model.number="animDuration"
                class="range"
                type="range"
                :min="MIN_DURATION"
                :max="MAX_DURATION"
                step="1"
                :disabled="animation === 'none'"
                :aria-label="t('anim.duration')"
              />
              <p class="field-hint">{{ t('anim.durationHint') }}</p>
            </div>

            <TransitionGroup tag="ul" :name="transitionName" class="segments-list">
              <li v-for="(seg, i) in segments" :key="`${seg.start}-${seg.end}`" class="segment-row">
                <span class="segment-index">{{ i + 1 }}</span>
                <span class="segment-time">
                  {{ formatTimeMs(seg.start) }} – {{ formatTimeMs(seg.end) }}
                  <small>({{ formatTimeMs(Math.max(0, seg.end - seg.start)) }})</small>
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
            </TransitionGroup>
            <p v-if="!segments.length" class="segments-empty">{{ t('segments.empty') }}</p>

            <p class="segments-hint">{{ t('segments.hint') }}</p>
          </section>
        </div>

        <!-- MITTE: Canvas (Werkzeugleiste + Video + Timeline + Ergebnis) -->
        <div class="canvas">
          <!-- Werkzeugleiste: Aktion & Modus als Menüs, Export separat -->
          <div class="canvas-toolbar">
            <div class="toolbar-menus">
              <DropdownMenu :label="operationLabel" :title="t('operation.legend')">
                <template #default="{ close }">
                  <button
                    class="menu-option"
                    :class="{ active: operation === 'keep' }"
                    type="button"
                    role="menuitemradio"
                    :aria-checked="operation === 'keep'"
                    @click="pickOperation('keep', close)"
                  >
                    <span class="menu-check">{{ operation === 'keep' ? '✓' : '' }}</span>
                    <span class="menu-text">
                      <b>{{ t('operation.keep') }}</b>
                      <small>{{ t('operation.keepHint') }}</small>
                    </span>
                  </button>
                  <button
                    class="menu-option"
                    :class="{ active: operation === 'remove' }"
                    type="button"
                    role="menuitemradio"
                    :aria-checked="operation === 'remove'"
                    @click="pickOperation('remove', close)"
                  >
                    <span class="menu-check">{{ operation === 'remove' ? '✓' : '' }}</span>
                    <span class="menu-text">
                      <b>{{ t('operation.remove') }}</b>
                      <small>{{ t('operation.removeHint') }}</small>
                    </span>
                  </button>
                </template>
              </DropdownMenu>

              <DropdownMenu :label="modeLabel" :title="t('mode.legend')" :disabled="modeDisabled">
                <template #default="{ close }">
                  <button
                    class="menu-option"
                    :class="{ active: mode === 'copy' }"
                    type="button"
                    role="menuitemradio"
                    :aria-checked="mode === 'copy'"
                    @click="pickMode('copy', close)"
                  >
                    <span class="menu-check">{{ mode === 'copy' ? '✓' : '' }}</span>
                    <span class="menu-text">
                      <b>{{ t('mode.fast') }}</b>
                      <small>{{ t('mode.fastHint') }}</small>
                    </span>
                  </button>
                  <button
                    class="menu-option"
                    :class="{ active: mode === 'reencode' }"
                    type="button"
                    role="menuitemradio"
                    :aria-checked="mode === 'reencode'"
                    @click="pickMode('reencode', close)"
                  >
                    <span class="menu-check">{{ mode === 'reencode' ? '✓' : '' }}</span>
                    <span class="menu-text">
                      <b>{{ t('mode.accurate') }}</b>
                      <small>{{ t('mode.accurateHint') }}</small>
                    </span>
                  </button>
                </template>
              </DropdownMenu>

              <button
                class="btn crop-toggle"
                type="button"
                :class="{ active: hasCrop }"
                :aria-pressed="hasCrop"
                @click="onToggleCrop"
              >
                {{ hasCrop ? t('crop.on') : t('crop.toggle') }}
              </button>
            </div>

            <div class="action-buttons">
              <button
                class="btn primary export"
                type="button"
                :disabled="!canExport || busy"
                @click="onExport"
              >
                <template v-if="isProcessing">{{ statusLabel }} {{ progress }}%</template>
                <template v-else>{{ t('actions.cut') }}</template>
              </button>
              <button
                class="btn primary"
                type="button"
                :disabled="!hasResult || busy"
                @click="downloadResult"
              >
                {{ t('actions.download') }}
              </button>
            </div>
          </div>

          <p v-if="operation === 'remove'" class="reencode-note">{{ t('operation.removeNote') }}</p>

          <div v-if="hasCrop" class="crop-bar">
            <span class="crop-size"
              >{{ t('crop.selection') }}: <b>{{ cropSizeLabel }}</b></span
            >
            <span class="crop-hint">{{ t('crop.hint') }}</span>
            <button class="btn tiny ghost" type="button" @click="store.clearCrop()">
              {{ t('crop.reset') }}
            </button>
          </div>

          <div v-if="busy" class="progress" role="progressbar" :aria-valuenow="progress">
            <div class="bar" :style="{ width: `${progress}%` }"></div>
          </div>
          <p v-if="uploadDetail" class="upload-detail">{{ uploadDetail }}</p>
          <button v-if="busy" class="btn ghost cancel" type="button" @click="onCancel">
            {{ t('actions.cancel') }}
          </button>
          <p v-if="error" class="error" role="alert">{{ error }}</p>

          <div class="video-wrap">
            <video
              ref="videoEl"
              class="player"
              :src="objectUrl"
              controls
              preload="metadata"
              @loadedmetadata="onLoadedMetadata"
              @durationchange="onDurationChange"
              @timeupdate="onTimeUpdate"
            ></video>
            <CropOverlay
              v-if="crop"
              :model-value="crop"
              :disabled="busy"
              :target="videoEl"
              @update:model-value="onCropUpdate"
            />
          </div>

          <!-- Live-Werte: Gesamtdauer · Auswahl · Cursor · Restdauer -->
          <div class="live-row">
            <div class="live-cell">
              <span class="live-label">{{ t('live.total') }}</span>
              <span class="live-value strong">{{ msLabel(duration) }}</span>
            </div>
            <div class="live-cell center">
              <span class="live-label">{{ t('live.selection') }}</span>
              <span class="live-value">{{ msLabel(selectionDuration) }}</span>
            </div>
            <div class="live-cell center">
              <span class="live-label">{{ t('live.cursor') }}</span>
              <span class="live-value">{{ msLabel(currentTime) }}</span>
            </div>
            <div class="live-cell right">
              <span class="live-label">{{ t('live.remaining') }}</span>
              <span class="live-value strong">{{ msLabel(remainingTime) }}</span>
            </div>
          </div>

          <!-- Cursor: aktuelle Wiedergabeposition als Anfang/Ende übernehmen -->
          <div class="cursor-row">
            <span class="cursor-at">
              {{ t('player.cursorAt') }} <b>{{ formatTimeMs(currentTime) }}</b>
            </span>
            <button class="btn tiny" type="button" @click="setStartHere">
              {{ t('player.setStart') }}
            </button>
            <button class="btn tiny" type="button" @click="setEndHere">
              {{ t('player.setEnd') }}
            </button>
          </div>

          <Timeline
            :duration="duration"
            :start="startTime"
            :end="endTime"
            :current="currentTime"
            :segments="segments"
            :operation="operation"
            :transition-name="transitionName"
            @update:start="store.setStart"
            @update:end="store.setEnd"
            @seek="seekTo"
          />

          <!-- Ergebnis-Status: das Ergebnis läuft im selben Player oben,
               kein zweites Vorschaufenster. Nur Hinweis + Download-Hinweis. -->
          <p v-if="hasResult && !busy" class="result-status">
            {{ t('result.ready') }} {{ resultName }}
          </p>
          <p v-if="hasResult && appleMobile && !busy" class="result-hint">
            {{ t('result.iosHint') }}
          </p>
        </div>
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
  width: 100%;
  max-width: 680px;
  margin: 0 auto;
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

/* 2-Spalten-Layout: links Auswahl/Ausschnitte, Mitte/rechts der Canvas mit
   Werkzeugleiste. Optionen (Aktion/Modus) sowie Export sitzen als Menüs bzw.
   Button oben am Canvas -> mehr Platz fürs Video. Schmal: gestapelt, Canvas
   zuerst. */
.editor-grid {
  display: grid;
  gap: 16px;
  grid-template-columns: 1fr;
  grid-template-areas:
    'canvas'
    'left';
}
.panel-left {
  grid-area: left;
}
.canvas {
  grid-area: canvas;
}
.panel,
.canvas {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
}
@media (min-width: 900px) {
  .editor-grid {
    grid-template-columns: minmax(240px, 300px) minmax(0, 1fr);
    grid-template-areas: 'left canvas';
    align-items: start;
  }
}

/* Werkzeugleiste oben am Canvas */
.canvas-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}
.toolbar-menus {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.canvas-toolbar .export {
  margin-left: auto;
  align-self: stretch;
  padding: 10px 20px;
}

/* Optionen im Menü (Aktion/Modus) */
.menu-option {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  width: 100%;
  padding: 9px 8px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--vc-text);
  text-align: left;
  cursor: pointer;
}
.menu-option:hover {
  background: var(--vc-accent-soft);
}
.menu-option.active {
  background: var(--vc-accent-soft);
}
.menu-option:focus-visible {
  outline: 2px solid var(--vc-focus);
  outline-offset: 1px;
}
.menu-check {
  width: 14px;
  flex: none;
  color: var(--vc-accent);
  font-weight: 700;
}
.menu-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.menu-text small {
  color: var(--vc-text-dim);
  font-size: 12px;
}

/* Karten-Container in den Panels */
.card {
  border: 1px solid var(--vc-border);
  border-radius: 10px;
  padding: 12px;
}
.panel-title {
  margin: 0 0 10px;
  font-size: 13px;
  color: var(--vc-text-dim);
}

.filebar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.fileinfo {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}
.filename {
  font-size: 14px;
  color: var(--vc-text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.filesize {
  flex: none;
  font-size: 12px;
  color: var(--vc-text-dim);
  font-variant-numeric: tabular-nums;
  padding: 2px 7px;
  border: 1px solid var(--vc-border);
  border-radius: 999px;
}
.filebar-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
}
.history {
  display: flex;
  gap: 4px;
}
.history .btn.tiny {
  font-size: 16px;
  line-height: 1;
  padding: 6px 10px;
}

.video-wrap {
  position: relative;
  /* Video ist ein Replaced Element mit Default-`display:inline` -> ohne
     `block` bliebe ein paar Pixel „Whitespace-below“, wodurch der Crop-
     Overlay (absolut, inset:0) nicht exakt auf dem sichtbaren Bild läge. */
  display: block;
  line-height: 0;
}
.player {
  display: block;
  width: 100%;
  max-height: 52vh;
  border-radius: 10px;
  background: #000;
}

.crop-toggle.active {
  border-color: var(--vc-accent);
  color: var(--vc-accent);
  background: var(--vc-accent-soft);
}
.crop-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  color: var(--vc-text-dim);
}
.crop-size {
  font-variant-numeric: tabular-nums;
}
.crop-size b {
  color: var(--vc-text);
}
.crop-hint {
  flex: 1;
  min-width: 160px;
}

.marks {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
/* Eine Zeitkarte (Start bzw. Ende): Textfeld, ms-Feld, Nudges */
.time-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px;
  border: 1px solid var(--vc-border);
  border-radius: 8px;
}
.time-label {
  font-size: 11px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--vc-text-dim);
}
.time-main {
  display: flex;
  align-items: center;
  gap: 6px;
}
.time-input {
  flex: 1;
  min-width: 0;
  width: 100%;
  padding: 7px 8px;
  border: 1px solid var(--vc-border);
  border-radius: 8px;
  background: var(--vc-surface);
  color: var(--vc-text);
  font-size: 16px;
  font-weight: 700;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-variant-numeric: tabular-nums;
  text-align: center;
}
.time-input.start {
  color: var(--vc-accent);
}
.time-input.end {
  color: var(--vc-playhead, var(--vc-accent));
}
.time-input.ms {
  flex: none;
  width: 110px;
  font-size: 14px;
  text-align: right;
}
.time-input:focus-visible {
  outline: 2px solid var(--vc-focus);
  outline-offset: 1px;
  border-color: var(--vc-accent);
}
.ms-field {
  display: flex;
  align-items: center;
  gap: 6px;
}
.ms-unit {
  font-size: 12px;
  color: var(--vc-text-dim);
}
.nudges {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.btn.tiny.nudge {
  padding: 4px 6px;
  font-size: 11px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-variant-numeric: tabular-nums;
}
.sel {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--vc-text-dim);
  font-variant-numeric: tabular-nums;
  padding-top: 2px;
}
.sel b {
  color: var(--vc-text);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.sel-total {
  color: var(--vc-text-dim);
}
.sel-valid {
  color: var(--vc-accent);
  font-weight: 600;
}
.sel-invalid {
  color: var(--vc-error-text, #d33);
  font-weight: 600;
}
.sel .btn {
  margin-left: auto;
}
.btn.tiny {
  padding: 6px 9px;
  font-size: 14px;
  line-height: 1;
}

/* Live-Zeile unter dem Player */
.live-row {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  margin-top: 8px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-variant-numeric: tabular-nums;
  font-size: 12px;
  font-weight: 700;
}
.live-cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.live-cell.center {
  text-align: center;
}
.live-cell.right {
  text-align: right;
}
.live-label {
  font-family: inherit;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--vc-text-dim);
}
.live-value {
  color: var(--vc-text-dim);
  white-space: nowrap;
}
.live-value.strong {
  color: var(--vc-text);
}
@media (max-width: 640px) {
  .live-row {
    flex-wrap: wrap;
  }
  .live-cell {
    flex: 1 1 45%;
  }
}

/* Cursor-Zeile: Position als Anfang/Ende übernehmen */
.cursor-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 8px;
  margin-top: 8px;
  font-size: 13px;
  color: var(--vc-text-dim);
}
.cursor-at b {
  color: var(--vc-text);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-variant-numeric: tabular-nums;
}

/* Ausschnitt-Liste */
.segments {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.card-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.card-head .panel-title {
  margin: 0;
}
.count {
  display: inline-grid;
  place-items: center;
  min-width: 20px;
  height: 20px;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--vc-accent);
  color: #fff;
  font-size: 12px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
/* Volle-Breite-Button (z. B. Ausschnitt hinzufügen) */
.btn.block {
  width: 100%;
  text-align: center;
  border-color: var(--vc-accent);
  color: var(--vc-accent);
  font-weight: 600;
}
.btn.block:hover:not(:disabled) {
  background: var(--vc-accent-soft);
}
/* Beschriftete Steuerzeile (Label links, Bedienelement rechts) */
.field-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.field-label {
  font-size: 13px;
  color: var(--vc-text-dim);
}
.field-col {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.field-col.disabled {
  opacity: 0.5;
}
.field-value {
  font-size: 13px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.field-hint {
  margin: 0;
  font-size: 12px;
  color: var(--vc-text-dim);
}
.range {
  width: 100%;
  accent-color: var(--vc-accent);
  cursor: pointer;
}
.range:disabled {
  cursor: not-allowed;
}
.segments-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  position: relative;
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

/* Übergänge der Listenzeilen – Stil je nach Menüauswahl (anim-*).
   Gemeinsames Timing + Layout, danach der Effekt pro Preset. */
.anim-fade-enter-active,
.anim-fade-leave-active,
.anim-slide-enter-active,
.anim-slide-leave-active,
.anim-scale-enter-active,
.anim-scale-leave-active,
.anim-flip-enter-active,
.anim-flip-leave-active {
  transition:
    opacity 0.28s ease,
    transform 0.28s ease;
}
/* Entfernte Zeile aus dem Fluss nehmen, damit die übrigen sanft nachrücken. */
.anim-fade-leave-active,
.anim-slide-leave-active,
.anim-scale-leave-active,
.anim-flip-leave-active {
  position: absolute;
  left: 0;
  right: 0;
}
.anim-fade-move,
.anim-slide-move,
.anim-scale-move,
.anim-flip-move {
  transition: transform 0.28s ease;
}
/* Effekte je Preset */
.anim-fade-enter-from,
.anim-fade-leave-to {
  opacity: 0;
}
.anim-slide-enter-from,
.anim-slide-leave-to {
  opacity: 0;
  transform: translateX(-18px);
}
.anim-scale-enter-from,
.anim-scale-leave-to {
  opacity: 0;
  transform: scale(0.9);
}
.anim-flip-enter-from,
.anim-flip-leave-to {
  opacity: 0;
  transform: perspective(400px) rotateX(-80deg);
}

.segments-hint {
  margin: 0;
  font-size: 12px;
  color: var(--vc-text-dim);
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
.btn.ghost.danger {
  color: var(--vc-error-text, #d33);
}
.btn.ghost.danger:hover {
  border-color: var(--vc-error-text, #d33);
  background: var(--vc-error-bg, transparent);
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

/* Auf schmalen Displays Export-Button in der Werkzeugleiste voll breit. */
@media (max-width: 600px) {
  .toolbar-menus {
    width: 100%;
  }
  .toolbar-menus .dropdown {
    flex: 1;
  }
  .canvas-toolbar .export {
    width: 100%;
    margin-left: 0;
  }
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
.action-buttons {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.result-status {
  margin: 8px 0 0;
  font-size: 13px;
  font-weight: 600;
}
.result-hint {
  margin: 0;
  font-size: 12px;
  color: var(--vc-text-dim);
}

@media (prefers-reduced-motion: reduce) {
  .bar {
    transition: none;
  }
  .anim-fade-enter-active,
  .anim-fade-leave-active,
  .anim-fade-move,
  .anim-slide-enter-active,
  .anim-slide-leave-active,
  .anim-slide-move,
  .anim-scale-enter-active,
  .anim-scale-leave-active,
  .anim-scale-move,
  .anim-flip-enter-active,
  .anim-flip-leave-active,
  .anim-flip-move {
    transition: none;
  }
}
</style>
