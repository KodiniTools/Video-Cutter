<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import { storeToRefs } from 'pinia'
import { useVideoEditorStore } from '@/stores/videoEditor'
import { useLibraryStore, itemLength, MAX_MERGE_ITEMS } from '@/stores/library'
import {
  useServerCut,
  CUT_CANCELLED,
  CROP_UNSUPPORTED,
  APPEND_UNSUPPORTED,
  FORMAT_UNSUPPORTED,
  MUSIC_UNSUPPORTED,
  MEDIA_UNSUPPORTED,
  TEXT_UNSUPPORTED,
} from '@/composables/useServerCut'
import { useTextOverlayStore } from '@/stores/textOverlays'
import { toServerOverlay } from '@/lib/textOverlay'
import { useAnimationPref, MIN_DURATION, MAX_DURATION } from '@/composables/useAnimationPref'
import { formatTimeMs, parseTimeInput, toMs } from '@/lib/timeFormat'
import { saveFile, isAppleMobile } from '@/lib/download'
import { readVideoDuration } from '@/lib/videoMeta'
import Timeline from './Timeline.vue'
import DropdownMenu from './DropdownMenu.vue'
import CropOverlay from './CropOverlay.vue'
import LibraryList from './LibraryList.vue'
import TextOverlayLayer from './TextOverlayLayer.vue'
import TextPanel from './TextPanel.vue'

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
  outputAspect,
  outputFill,
  music,
  hasMusic,
  hasVideo,
  canExport,
  canAddSegment,
  canUndo,
  canRedo,
  effectiveSegments,
  selectionDuration,
  error,
} = storeToRefs(store)

// Video-Bibliothek: markiertes Video = Arbeitsvideo im Editor.
const library = useLibraryStore()
const { items, selected, mergeItems, canMerge, normalizeAudio } = storeToRefs(library)

const {
  isProcessing,
  progress,
  phase,
  uploadedBytes,
  totalBytes,
  bytesPerSec,
  cutMedia,
  burnText,
  cancel: serverCancel,
} = useServerCut()

// Text-Einblendungen des markierten Videos.
const texts = useTextOverlayStore()
watch(
  () => selected.value?.id ?? null,
  (id) => texts.setItem(id),
  { immediate: true },
)

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

// --- Ausgabeformat ------------------------------------------------------------
const ASPECT_OPTIONS = [
  { value: 'auto', label: 'format.auto', hint: 'format.autoHint' },
  { value: '16:9', label: 'format.landscape', hint: 'format.landscapeHint' },
  { value: '9:16', label: 'format.portrait', hint: 'format.portraitHint' },
  { value: '1:1', label: 'format.square', hint: 'format.squareHint' },
] as const
const FILL_OPTIONS = [
  { value: 'pad', label: 'format.pad', hint: 'format.padHint' },
  { value: 'blur', label: 'format.blur', hint: 'format.blurHint' },
  { value: 'crop', label: 'format.crop', hint: 'format.cropHint' },
] as const
/** Anderes Seitenverhältnis gewählt? (erzwingt Re-Encode.) */
const hasOutputFormat = computed(() => outputAspect.value !== 'auto')
const formatLabel = computed(() => (hasOutputFormat.value ? outputAspect.value : t('format.auto')))
function pickAspect(a: (typeof ASPECT_OPTIONS)[number]['value'], close: () => void): void {
  store.setOutputAspect(a)
  // Bei „Original" gibt es keine Füllung zu wählen -> Menü schließen.
  if (a === 'auto') close()
}
function pickFill(f: (typeof FILL_OPTIONS)[number]['value'], close: () => void): void {
  store.setOutputFill(f)
  close()
}
// Beim Entfernen, bei aktivem Zuschnitt ODER angehängten Videos wird immer neu
// kodiert -> Modus ist dann fest & deaktiviert (Decode+Encode nötig).
const modeDisabled = computed(
  () => operation.value === 'remove' || hasCrop.value || hasOutputFormat.value || hasMusic.value,
)
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

// --- Videos anhängen (Zusammenfügen) -----------------------------------------
/** Musikdatei wählen (Audio oder Video mit Tonspur). */
function onMusicInput(e: Event): void {
  const target = e.target as HTMLInputElement
  const f = target.files?.[0]
  target.value = '' // erneutes Auswählen derselben Datei erlauben
  if (!f) return
  if (!f.type.startsWith('audio/') && !f.type.startsWith('video/')) {
    store.setError(t('music.notAudio'))
    return
  }
  store.setMusicFile(f)
}

/**
 * Nimmt Videos in die Bibliothek auf (Upload auf den Server läuft im
 * Hintergrund). Ist noch nichts markiert, öffnet sich das erste im Editor.
 */
function addVideos(files: File[]): void {
  if (!files.length) return
  const videos = files.filter((f) => f.type.startsWith('video/'))
  if (videos.length < files.length) store.setError(t('errors.notVideo'))
  const added = library.addFiles(videos)
  // Dauer lokal vorab lesen (Anzeige), der Server liefert sie nach dem Upload.
  for (const it of added) {
    void readVideoDuration(it.file).then((d) => library.setDuration(it.id, d))
  }
}

const videoEl = ref<HTMLVideoElement | null>(null)
const isDragOver = ref(false)

function onInputChange(e: Event): void {
  const target = e.target as HTMLInputElement
  addVideos(Array.from(target.files ?? []))
  target.value = '' // erneutes Auswählen derselben Datei erlauben
}

function onDrop(e: DragEvent): void {
  isDragOver.value = false
  addVideos(Array.from(e.dataTransfer?.files ?? []))
}

// Markiertes Video in den Editor laden (neue Auswahl oder ersetzt durch ein
// Schnitt-Ergebnis). Keins mehr übrig -> zurück zur Upload-Ansicht.
watch(
  () => selected.value?.file ?? null,
  (f) => {
    if (!f) {
      if (store.file) store.reset()
      return
    }
    if (f !== store.file) store.setFile(f)
  },
  { immediate: true },
)

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

/** Schrittweite der ▲▼-Spinner an den Zeitfeldern (ms). */
const SPINNER_MS = 10
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

// Gedrückt-halten der Spinner: sofort ein Schritt, nach kurzer Verzögerung
// wiederholt – die Vorschau springt bei jedem Schritt mit (Frames scrubben).
let holdDelay: ReturnType<typeof setTimeout> | null = null
let holdTimer: ReturnType<typeof setInterval> | null = null
function holdStart(step: () => void): void {
  holdStop()
  step() // sofortiger erster Schritt
  holdDelay = setTimeout(() => {
    holdTimer = setInterval(step, 70)
  }, 300)
}
function holdStop(): void {
  if (holdDelay) {
    clearTimeout(holdDelay)
    holdDelay = null
  }
  if (holdTimer) {
    clearInterval(holdTimer)
    holdTimer = null
  }
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

/** Laufender Vorgang (für die Fortschrittsanzeige am passenden Button). */
const activeJob = ref<'cut' | 'merge' | 'text' | null>(null)
/** Zuletzt erzeugtes Ergebnis (für den Hinweis „Fertig"). */
const lastResultId = ref<number | null>(null)

/** Markiertes Video liegt auf dem Server und hat einen gültigen Ausschnitt. */
const canCut = computed(
  () => canExport.value && selected.value?.status === 'ready' && !!selected.value.mediaId,
)
/** Mehr markierte Videos, als der Server zusammenfügen kann. */
const tooManyToMerge = computed(() => mergeItems.value.length > MAX_MERGE_ITEMS)

function showJobError(e: unknown): void {
  // Nutzer-Abbruch nicht als Fehler anzeigen.
  const msg = e instanceof Error ? e.message : String(e)
  if (msg === CUT_CANCELLED) return
  const known: Record<string, string> = {
    [CROP_UNSUPPORTED]: 'errors.cropUnsupported',
    [APPEND_UNSUPPORTED]: 'errors.appendUnsupported',
    [FORMAT_UNSUPPORTED]: 'errors.formatUnsupported',
    [MUSIC_UNSUPPORTED]: 'errors.musicUnsupported',
    [MEDIA_UNSUPPORTED]: 'errors.mediaUnsupported',
    [TEXT_UNSUPPORTED]: 'errors.textUnsupported',
  }
  store.setError(known[msg] ? t(known[msg]) : msg)
}

/** Ergebnis-Datei mit dem vom Server vergebenen Namen. */
function resultFile(blob: Blob, name: string): File {
  return new File([blob], name, { type: blob.type || 'video/mp4' })
}

/** „Schneiden": nur das markierte Video; das Ergebnis ersetzt es in der Liste. */
async function onExport(): Promise<void> {
  const item = selected.value
  if (!item?.mediaId || !canCut.value || busy.value) return
  store.setError('')
  activeJob.value = 'cut'
  try {
    const { media, blob } = await cutMedia({
      mediaId: item.mediaId,
      segments: effectiveSegments.value.map((s) => ({
        start: s.start,
        duration: Math.max(0, s.end - s.start),
      })),
      mode: mode.value,
      operation: operation.value,
      total: duration.value,
      transition: { preset: animation.value, duration: animDuration.value },
      crop: crop.value ?? undefined,
      output: { aspect: outputAspect.value, fill: outputFill.value },
      music: music.value ?? undefined,
    })
    // Name vom Server: „…_cut.<ext>" (Container passend zum Modus).
    library.replaceWithResult(item.id, media, resultFile(blob, media.name))
    store.clearMusic() // ist jetzt Teil des Ergebnisses
    lastResultId.value = item.id
  } catch (e) {
    showJobError(e)
  } finally {
    activeJob.value = null
  }
}

/**
 * „Zusammenfügen": alle vorgemerkten Videos in Listenreihenfolge (jeweils
 * Von/Bis), mit Übergängen, Musik, Lautstärke-Angleichung und Ausgabeformat.
 * Das Ergebnis kommt als neues Video in die Liste und wird markiert.
 */
async function onMerge(): Promise<void> {
  const list = mergeItems.value
  if (!canMerge.value || busy.value) return
  const [first, ...rest] = list
  if (!first.mediaId) return
  store.setError('')
  activeJob.value = 'merge'
  try {
    const { media, blob } = await cutMedia({
      mediaId: first.mediaId,
      segments: [{ start: first.start, duration: itemLength(first) }],
      mode: 'reencode',
      operation: 'keep',
      transition: { preset: animation.value, duration: animDuration.value },
      appends: rest.map((it) => ({
        mediaId: it.mediaId ?? undefined,
        start: it.start,
        // Nur ein gesetztes Ende kürzt; sonst bis zum Dateiende.
        duration: it.end !== null ? Math.max(0, it.end - it.start) : undefined,
        position: 'after' as const,
      })),
      normalizeAudio: normalizeAudio.value,
      output: { aspect: outputAspect.value, fill: outputFill.value },
      music: music.value ?? undefined,
      seams: library.seamPresets,
    })
    const base = first.name.replace(/\.[^.]+$/, '').replace(/_(cut|merged)$/, '') || 'video'
    const ext = media.name.match(/\.([a-z0-9]+)$/i)?.[1] ?? 'mp4'
    const added = library.addResult(media, resultFile(blob, `${base}_merged.${ext}`))
    store.clearMusic()
    lastResultId.value = added.id
  } catch (e) {
    showJobError(e)
  } finally {
    activeJob.value = null
  }
}

/** Neuer Text an der aktuellen Stelle (Video wird dafür angehalten). */
function onAddText(): void {
  const el = videoEl.value
  if (el && !el.paused) el.pause()
  const at = el?.currentTime ?? currentTime.value
  texts.add(at, duration.value, t('text.defaultText'))
}

/** „Text einbrennen": alle Texte ins markierte Video; Ergebnis ersetzt es. */
async function onBurnText(): Promise<void> {
  const item = selected.value
  const list = texts.overlays
  if (!item?.mediaId || item.status !== 'ready' || !list.length || busy.value) return
  store.setError('')
  activeJob.value = 'text'
  try {
    const { media, blob } = await burnText(item.mediaId, list.map(toServerOverlay))
    library.replaceWithResult(item.id, media, resultFile(blob, media.name))
    // Die Texte sind jetzt Teil des Bildes.
    texts.clearItem(item.id)
    lastResultId.value = item.id
  } catch (e) {
    showJobError(e)
  } finally {
    activeJob.value = null
  }
}

/** Video aus der Liste entfernen und sofort vom Server löschen. */
async function onRemoveItem(id: number): Promise<void> {
  if (lastResultId.value === id) lastResultId.value = null
  texts.clearItem(id)
  try {
    await library.remove(id)
  } catch {
    store.setError(t('library.deleteFailed'))
  }
}

function onCancel(): void {
  serverCancel()
}

/** Markiertes Video löschen (auch vom Server); der Nachbar wird markiert. */
function onDeleteVideo(): void {
  if (busy.value) {
    serverCancel() // laufenden Job stoppen
  }
  const id = selected.value?.id
  if (id !== undefined) void onRemoveItem(id)
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
  holdStop()
  store.reset()
})

const appleMobile = isAppleMobile()

/** Ergebnis des letzten Vorgangs ist markiert? (Hinweis „Fertig") */
const showResult = computed(
  () => lastResultId.value !== null && selected.value?.id === lastResultId.value,
)

/** Lädt das markierte Video herunter (z. B. das Schnitt-Ergebnis). */
async function downloadResult(): Promise<void> {
  const item = selected.value
  if (!item) return
  // Einheitlicher, robuster Pfad (iOS-Teilen / Anker / neuer Tab).
  try {
    await saveFile({ blob: item.file, name: item.name })
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
      <input type="file" accept="video/*" multiple class="sr-only" @change="onInputChange" />
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
          <label class="btn ghost">
            <input type="file" accept="video/*" multiple class="sr-only" @change="onInputChange" />
            {{ t('library.add') }}
          </label>
          <button class="btn ghost danger" type="button" @click="onDeleteVideo">
            🗑 {{ t('actions.removeVideo') }}
          </button>
        </div>
      </div>

      <div class="editor-grid">
        <!-- LINKS: Meine Videos -->
        <div class="panel panel-left">
          <!-- Meine Videos: auf dem Server gespeichert; markiertes Video = Editor -->
          <section class="card segments library">
            <div class="card-head">
              <h3 class="panel-title">{{ t('library.title') }}</h3>
              <span v-if="items.length" class="count">{{ items.length }}</span>
            </div>

            <label class="btn block add">
              <input
                type="file"
                accept="video/*"
                multiple
                class="sr-only"
                @change="onInputChange"
              />
              {{ t('library.add') }}
            </label>

            <LibraryList :disabled="busy" @remove="onRemoveItem" />

            <label v-if="mergeItems.length > 1" class="check-row">
              <input
                type="checkbox"
                :checked="normalizeAudio"
                :disabled="busy"
                @change="library.setNormalizeAudio(($event.target as HTMLInputElement).checked)"
              />
              <span>
                {{ t('append.normalize') }}
                <small>{{ t('append.normalizeHint') }}</small>
              </span>
            </label>

            <p v-if="tooManyToMerge" class="segments-hint warn" role="status">
              {{ t('library.mergeLimit', { max: MAX_MERGE_ITEMS }) }}
            </p>
            <p class="segments-hint">{{ t('library.hint') }}</p>
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

              <DropdownMenu :label="formatLabel" :title="t('format.legend')">
                <template #default="{ close }">
                  <button
                    v-for="opt in ASPECT_OPTIONS"
                    :key="opt.value"
                    class="menu-option"
                    :class="{ active: outputAspect === opt.value }"
                    type="button"
                    role="menuitemradio"
                    :aria-checked="outputAspect === opt.value"
                    @click="pickAspect(opt.value, close)"
                  >
                    <span class="menu-check">{{ outputAspect === opt.value ? '✓' : '' }}</span>
                    <span class="menu-text">
                      <b>{{ t(opt.label) }}</b>
                      <small>{{ t(opt.hint) }}</small>
                    </span>
                  </button>
                  <template v-if="hasOutputFormat">
                    <div class="menu-heading">{{ t('format.fill') }}</div>
                    <button
                      v-for="opt in FILL_OPTIONS"
                      :key="opt.value"
                      class="menu-option"
                      :class="{ active: outputFill === opt.value }"
                      type="button"
                      role="menuitemradio"
                      :aria-checked="outputFill === opt.value"
                      @click="pickFill(opt.value, close)"
                    >
                      <span class="menu-check">{{ outputFill === opt.value ? '✓' : '' }}</span>
                      <span class="menu-text">
                        <b>{{ t(opt.label) }}</b>
                        <small>{{ t(opt.hint) }}</small>
                      </span>
                    </button>
                  </template>
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
                :disabled="!canCut || busy"
                :title="t('actions.cutHint')"
                @click="onExport"
              >
                <template v-if="activeJob === 'cut'">{{ statusLabel }} {{ progress }}%</template>
                <template v-else>{{ t('actions.cut') }}</template>
              </button>
              <button
                class="btn primary merge"
                type="button"
                :disabled="!canMerge || busy"
                :title="t('actions.mergeHint')"
                @click="onMerge"
              >
                <template v-if="activeJob === 'merge'">{{ statusLabel }} {{ progress }}%</template>
                <template v-else>
                  {{ t('actions.merge') }}
                  <span v-if="mergeItems.length > 1">({{ mergeItems.length }})</span>
                </template>
              </button>
              <button
                class="btn primary"
                type="button"
                :disabled="!selected || busy"
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
            <TextOverlayLayer
              v-if="texts.overlays.length"
              :overlays="texts.overlays"
              :selected-id="texts.selectedId"
              :target="videoEl"
              :disabled="busy"
              @select="texts.select"
              @move="(id, pos) => texts.update(id, pos)"
            />
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
            @update:start="store.setStart"
            @update:end="store.setEnd"
            @seek="seekTo"
          />

          <!-- Ergebnis-Status: das Ergebnis läuft im selben Player oben,
               kein zweites Vorschaufenster. Nur Hinweis + Download-Hinweis. -->
          <p v-if="showResult && !busy" class="result-status">
            {{ t('result.ready') }} {{ selected?.name }}
          </p>
          <p v-if="showResult && appleMobile && !busy" class="result-hint">
            {{ t('result.iosHint') }}
          </p>
        </div>

        <!-- RECHTS: Auswahl, Ausschnitte & Hintergrundmusik -->
        <div class="panel panel-right">
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
                  <div class="spinner" role="group">
                    <button
                      class="spin"
                      type="button"
                      :title="t('time.spinUp')"
                      :aria-label="`${t('labels.start')}: ${t('time.spinUp')}`"
                      @pointerdown.prevent="holdStart(() => nudgeStart(SPINNER_MS))"
                      @pointerup="holdStop"
                      @pointerleave="holdStop"
                      @pointercancel="holdStop"
                      @keydown.enter.prevent="nudgeStart(SPINNER_MS)"
                      @keydown.space.prevent="nudgeStart(SPINNER_MS)"
                    >
                      ▲
                    </button>
                    <button
                      class="spin"
                      type="button"
                      :title="t('time.spinDown')"
                      :aria-label="`${t('labels.start')}: ${t('time.spinDown')}`"
                      @pointerdown.prevent="holdStart(() => nudgeStart(-SPINNER_MS))"
                      @pointerup="holdStop"
                      @pointerleave="holdStop"
                      @pointercancel="holdStop"
                      @keydown.enter.prevent="nudgeStart(-SPINNER_MS)"
                      @keydown.space.prevent="nudgeStart(-SPINNER_MS)"
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
                  <div class="spinner" role="group">
                    <button
                      class="spin"
                      type="button"
                      :title="t('time.spinUp')"
                      :aria-label="`${t('labels.end')}: ${t('time.spinUp')}`"
                      @pointerdown.prevent="holdStart(() => nudgeEnd(SPINNER_MS))"
                      @pointerup="holdStop"
                      @pointerleave="holdStop"
                      @pointercancel="holdStop"
                      @keydown.enter.prevent="nudgeEnd(SPINNER_MS)"
                      @keydown.space.prevent="nudgeEnd(SPINNER_MS)"
                    >
                      ▲
                    </button>
                    <button
                      class="spin"
                      type="button"
                      :title="t('time.spinDown')"
                      :aria-label="`${t('labels.end')}: ${t('time.spinDown')}`"
                      @pointerdown.prevent="holdStart(() => nudgeEnd(-SPINNER_MS))"
                      @pointerup="holdStop"
                      @pointerleave="holdStop"
                      @pointercancel="holdStop"
                      @keydown.enter.prevent="nudgeEnd(-SPINNER_MS)"
                      @keydown.space.prevent="nudgeEnd(-SPINNER_MS)"
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

          <!-- Text / Untertitel einblenden -->
          <TextPanel
            :duration="duration"
            :current-time="currentTime"
            :busy="busy"
            :burning="activeJob === 'text'"
            :progress-label="`${statusLabel} ${progress}%`"
            :can-burn="selected?.status === 'ready' && !!selected?.mediaId"
            @add="onAddText"
            @seek="seekTo"
            @burn="onBurnText"
          />

          <!-- Hintergrundmusik über das gesamte Ergebnis -->
          <section class="card segments music">
            <div class="card-head">
              <h3 class="panel-title">{{ t('music.title') }}</h3>
            </div>

            <label class="btn block add" :class="{ disabled: busy }">
              <input
                type="file"
                accept="audio/*,video/*"
                class="sr-only"
                :disabled="busy"
                @change="onMusicInput"
              />
              {{ music ? t('music.replace') : t('music.add') }}
            </label>

            <template v-if="music">
              <div class="segment-row">
                <span class="segment-time music-name" :title="music.file.name">
                  ♪ {{ music.file.name }}
                </span>
                <button
                  class="btn tiny remove"
                  type="button"
                  :disabled="busy"
                  :aria-label="t('music.remove')"
                  :title="t('music.remove')"
                  @click="store.clearMusic()"
                >
                  ✕
                </button>
              </div>

              <div class="field-col">
                <div class="field-row">
                  <label for="music-volume" class="field-label">{{ t('music.volume') }}</label>
                  <span class="field-value">{{ Math.round(music.volume * 100) }} %</span>
                </div>
                <input
                  id="music-volume"
                  class="range"
                  type="range"
                  min="0"
                  max="100"
                  step="5"
                  :value="Math.round(music.volume * 100)"
                  :disabled="busy"
                  @input="
                    store.updateMusic({
                      volume: Number(($event.target as HTMLInputElement).value) / 100,
                    })
                  "
                />
              </div>

              <div class="field-col">
                <div class="field-row">
                  <label for="music-original" class="field-label">{{ t('music.original') }}</label>
                  <span class="field-value">{{ Math.round(music.originalVolume * 100) }} %</span>
                </div>
                <input
                  id="music-original"
                  class="range"
                  type="range"
                  min="0"
                  max="100"
                  step="5"
                  :value="Math.round(music.originalVolume * 100)"
                  :disabled="busy"
                  @input="
                    store.updateMusic({
                      originalVolume: Number(($event.target as HTMLInputElement).value) / 100,
                    })
                  "
                />
              </div>

              <label class="check-row">
                <input
                  type="checkbox"
                  :checked="music.fade"
                  :disabled="busy"
                  @change="store.updateMusic({ fade: ($event.target as HTMLInputElement).checked })"
                />
                <span>{{ t('music.fade') }}</span>
              </label>
              <label class="check-row">
                <input
                  type="checkbox"
                  :checked="music.loop"
                  :disabled="busy"
                  @change="store.updateMusic({ loop: ($event.target as HTMLInputElement).checked })"
                />
                <span>{{ t('music.loop') }}</span>
              </label>
            </template>
            <p v-else class="segments-empty">{{ t('music.empty') }}</p>

            <p class="segments-hint">{{ t('music.hint') }}</p>
          </section>
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
  border: 2px dashed var(--ds-border-strong);
  border-radius: var(--ds-radius-lg);
  background: var(--ds-surface-2);
  cursor: pointer;
  text-align: center;
  transition:
    border-color var(--ds-duration) var(--ds-ease),
    background var(--ds-duration) var(--ds-ease);
}
.dropzone.over {
  border-color: var(--ds-accent);
  background: var(--ds-accent-soft);
}
.dz-icon {
  width: 52px;
  height: 52px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: var(--ds-accent);
  color: var(--ds-on-accent);
  font-size: var(--ds-text-xl);
}
.dz-title {
  font-weight: var(--ds-weight-semibold);
  font-size: var(--ds-text-lg);
}
.dz-hint {
  color: var(--ds-text-2);
  font-size: var(--ds-text-md);
}

/* Editor */
.editor {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

/* 3-Spalten-Layout: links „Meine Videos", Mitte der Canvas mit Werkzeugleiste,
   rechts Auswahl/Ausschnitte/Musik. Mittelbreit: rechte Sidebar unter den
   Canvas. Schmal: gestapelt, Canvas zuerst. */
.editor-grid {
  display: grid;
  gap: 16px;
  grid-template-columns: 1fr;
  grid-template-areas:
    'canvas'
    'left'
    'right';
}
.panel-left {
  grid-area: left;
}
.panel-right {
  grid-area: right;
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
    grid-template-areas:
      'left canvas'
      'left right';
    align-items: start;
  }
}
@media (min-width: 1100px) {
  .editor-grid {
    grid-template-columns: minmax(220px, 270px) minmax(0, 1fr) minmax(220px, 270px);
    grid-template-areas: 'left canvas right';
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
.menu-heading {
  padding: 8px 10px 4px;
  border-top: 1px solid var(--ds-border);
  margin-top: 4px;
  font-size: 10px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--ds-text-2);
}
.menu-option {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  width: 100%;
  padding: 9px 8px;
  border: none;
  border-radius: var(--ds-radius-md);
  background: transparent;
  color: var(--ds-text);
  text-align: left;
  cursor: pointer;
}
.menu-option:hover {
  background: var(--ds-accent-soft);
}
.menu-option.active {
  background: var(--ds-accent-soft);
}
.menu-option:focus-visible {
  outline: none;
  box-shadow: var(--ds-focus-ring);
}
.menu-check {
  width: 14px;
  flex: none;
  color: var(--ds-text);
  font-weight: var(--ds-weight-bold);
}
.menu-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.menu-text small {
  color: var(--ds-text-2);
  font-size: var(--ds-text-xs);
}

/* Karten-Container in den Panels */
.card {
  border: 1px solid var(--ds-border);
  border-radius: var(--ds-radius-md);
  padding: 12px;
  background: var(--ds-surface-1);
}
.panel-title {
  margin: 0 0 10px;
  font-size: var(--ds-text-sm);
  color: var(--ds-text-2);
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
  font-size: var(--ds-text-md);
  color: var(--ds-text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.filesize {
  flex: none;
  font-size: var(--ds-text-xs);
  color: var(--ds-text-2);
  font-variant-numeric: tabular-nums;
  padding: 2px 7px;
  border: 1px solid var(--ds-border);
  border-radius: var(--ds-radius-full);
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
  font-size: var(--ds-text-lg);
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
  border-radius: var(--ds-radius-md);
  background: #000;
}

.crop-toggle.active {
  border-color: var(--ds-accent);
  color: var(--ds-text);
  background: var(--ds-accent-soft);
}
.crop-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  font-size: var(--ds-text-xs);
  color: var(--ds-text-2);
}
.crop-size {
  font-variant-numeric: tabular-nums;
}
.crop-size b {
  color: var(--ds-text);
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
  border: 1px solid var(--ds-border);
  border-radius: var(--ds-radius-md);
}
.time-label {
  font-size: 11px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--ds-text-2);
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
  border: 1px solid var(--ds-border-strong);
  border-radius: var(--ds-radius-md);
  background: var(--ds-surface-2);
  color: var(--ds-text);
  font-size: var(--ds-text-lg);
  font-weight: var(--ds-weight-bold);
  font-family: var(--ds-font-mono);
  font-variant-numeric: tabular-nums;
  text-align: center;
}
.time-input.ms {
  flex: none;
  width: 110px;
  font-size: var(--ds-text-md);
  text-align: right;
}
.time-input:focus-visible {
  outline: none;
  box-shadow: var(--ds-focus-ring);
  border-color: var(--ds-accent);
}
/* ▲▼-Spinner am Zeitfeld (schrittweises Setzen der Position) */
.spinner {
  display: flex;
  flex-direction: column;
  flex: none;
}
.spin {
  width: 26px;
  height: 17px;
  padding: 0;
  display: grid;
  place-items: center;
  border: 1px solid var(--ds-border-strong);
  background: var(--ds-surface-2);
  color: var(--ds-text);
  cursor: pointer;
  font-size: 9px;
  line-height: 1;
}
.spin:first-child {
  border-radius: var(--ds-radius-sm) var(--ds-radius-sm) 0 0;
  border-bottom: none;
}
.spin:last-child {
  border-radius: 0 0 var(--ds-radius-sm) var(--ds-radius-sm);
}
.spin:hover {
  border-color: var(--ds-accent);
  color: var(--ds-text);
}
.spin:focus-visible {
  outline: none;
  box-shadow: var(--ds-focus-ring);
}
.ms-field {
  display: flex;
  align-items: center;
  gap: 6px;
}
.ms-unit {
  font-size: var(--ds-text-xs);
  color: var(--ds-text-2);
}
.nudges {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.btn.tiny.nudge {
  padding: 4px 6px;
  font-size: 11px;
  font-family: var(--ds-font-mono);
  font-variant-numeric: tabular-nums;
}
.sel {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  font-size: var(--ds-text-sm);
  color: var(--ds-text-2);
  font-variant-numeric: tabular-nums;
  padding-top: 2px;
}
.sel b {
  color: var(--ds-text);
  font-family: var(--ds-font-mono);
}
.sel-total {
  color: var(--ds-text-2);
}
.sel-valid {
  color: var(--ds-success);
  font-weight: var(--ds-weight-semibold);
}
.sel-invalid {
  color: var(--ds-danger);
  font-weight: var(--ds-weight-semibold);
}
.sel .btn {
  margin-left: auto;
}
.btn.tiny {
  padding: 6px 9px;
  font-size: var(--ds-text-md);
  line-height: 1;
}

/* Live-Zeile unter dem Player */
.live-row {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  margin-top: 8px;
  font-family: var(--ds-font-mono);
  font-variant-numeric: tabular-nums;
  font-size: var(--ds-text-xs);
  font-weight: var(--ds-weight-bold);
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
  font-weight: var(--ds-weight-semibold);
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--ds-text-2);
}
.live-value {
  color: var(--ds-text-2);
  white-space: nowrap;
}
.live-value.strong {
  color: var(--ds-text);
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
  font-size: var(--ds-text-sm);
  color: var(--ds-text-2);
}
.cursor-at b {
  color: var(--ds-text);
  font-family: var(--ds-font-mono);
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
  border-radius: var(--ds-radius-full);
  background: var(--ds-accent);
  color: var(--ds-on-accent);
  font-size: var(--ds-text-xs);
  font-weight: var(--ds-weight-semibold);
  font-variant-numeric: tabular-nums;
}
/* Volle-Breite-Button (z. B. Ausschnitt hinzufügen) */
.btn.block {
  width: 100%;
  text-align: center;
  border-color: var(--ds-accent);
  color: var(--ds-text);
  font-weight: var(--ds-weight-semibold);
}
.btn.block:hover:not(:disabled) {
  background: var(--ds-accent-soft);
}
/* Beschriftete Steuerzeile (Label links, Bedienelement rechts) */
.field-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.field-label {
  font-size: var(--ds-text-sm);
  color: var(--ds-text-2);
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
  font-size: var(--ds-text-sm);
  font-weight: var(--ds-weight-semibold);
  font-variant-numeric: tabular-nums;
}
.field-hint {
  margin: 0;
  font-size: var(--ds-text-xs);
  color: var(--ds-text-2);
}
.range {
  width: 100%;
  accent-color: var(--ds-accent);
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
  border: 1px solid var(--ds-border);
  border-radius: var(--ds-radius-md);
  background: var(--ds-surface-2);
}
.segment-index {
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--ds-accent);
  color: var(--ds-on-accent);
  font-size: var(--ds-text-xs);
  font-weight: var(--ds-weight-semibold);
  flex: none;
}
.segment-time {
  flex: 1;
  font-size: var(--ds-text-md);
  font-variant-numeric: tabular-nums;
}
.segment-time small {
  color: var(--ds-text-2);
}
.btn.tiny.remove {
  padding: 4px 8px;
  line-height: 1;
}
.btn.block.disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
label.btn.block {
  display: block;
}
.segment-row.main {
  border-style: dashed;
}
.check-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: var(--ds-text-md);
  cursor: pointer;
}
.check-row input {
  margin-top: 3px;
  accent-color: var(--ds-accent);
}
.music-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.check-row small {
  display: block;
  color: var(--ds-text-2);
  font-size: var(--ds-text-xs);
}
.segments-empty {
  margin: 0;
  font-size: var(--ds-text-xs);
  color: var(--ds-text-2);
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
  font-size: var(--ds-text-xs);
  color: var(--ds-text-2);
}
.segments-hint.warn {
  color: var(--ds-danger);
}
/* Datei-Auswahl als Button (Leiste oben). */
label.btn {
  display: inline-flex;
  align-items: center;
}

/* Buttons */
.btn {
  appearance: none;
  border: 1px solid var(--ds-border-strong);
  background: var(--ds-surface-2);
  color: var(--ds-text);
  padding: 9px 14px;
  border-radius: var(--ds-radius-md);
  font-size: var(--ds-text-md);
  cursor: pointer;
  transition:
    background var(--ds-duration) var(--ds-ease),
    border-color var(--ds-duration) var(--ds-ease),
    opacity var(--ds-duration) var(--ds-ease);
}
.btn:hover {
  border-color: var(--ds-accent);
}
.btn.ghost {
  background: transparent;
}
.btn.ghost.danger {
  color: var(--ds-danger);
}
.btn.ghost.danger:hover {
  border-color: var(--ds-danger);
  background: color-mix(in srgb, var(--ds-danger) 10%, transparent);
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
.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.btn:focus-visible {
  outline: none;
  box-shadow: var(--ds-focus-ring);
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
  border-radius: var(--ds-radius-sm);
  background: var(--ds-surface-3);
  overflow: hidden;
}
.bar {
  height: 100%;
  background: var(--ds-accent);
  transition: width 0.2s;
}

.error {
  margin: 0;
  padding: 10px 12px;
  border-radius: var(--ds-radius-md);
  background: color-mix(in srgb, var(--ds-danger) 10%, transparent);
  color: var(--ds-danger);
  font-size: var(--ds-text-md);
}

.reencode-note {
  margin: -4px 0 0;
  font-size: var(--ds-text-xs);
  color: var(--ds-text-2);
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
  font-size: var(--ds-text-xs);
  color: var(--ds-text-2);
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
  font-weight: var(--ds-weight-semibold);
  margin: 0;
}
.action-buttons {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.result-status {
  margin: 8px 0 0;
  font-size: var(--ds-text-sm);
  font-weight: var(--ds-weight-semibold);
}
.result-hint {
  margin: 0;
  font-size: var(--ds-text-xs);
  color: var(--ds-text-2);
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
