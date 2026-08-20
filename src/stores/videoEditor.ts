import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { clamp, type TrimMode } from '@/lib/ffmpegCommand'

/** 'keep' = Auswahl behalten, 'remove' = Auswahl entfernen (Rest zusammenfügen). */
export type CutOperation = 'keep' | 'remove'

/** Ein festgehaltener Ausschnitt (Start/Ende in Sekunden). */
export interface Segment {
  start: number
  end: number
}

/** Mindestlänge der Auswahl in Sekunden. */
const MIN_SELECTION = 0.05

export const useVideoEditorStore = defineStore('videoEditor', () => {
  // --- Quellvideo ---
  const file = ref<File | null>(null)
  const objectUrl = ref('')
  const fileName = ref('')
  const duration = ref(0)

  // --- Auswahl / Wiedergabe ---
  const startTime = ref(0)
  const endTime = ref(0)
  const currentTime = ref(0)
  const mode = ref<TrimMode>('copy')
  /** Ob die Auswahl behalten oder entfernt wird. */
  const operation = ref<CutOperation>('keep')
  /** Festgehaltene Ausschnitte. Ist die Liste leer, gilt die aktuelle Auswahl. */
  const segments = ref<Segment[]>([])

  // --- Ergebnis / Fehler ---
  const resultUrl = ref('')
  const resultName = ref('')
  const resultBlob = ref<Blob | null>(null)
  const error = ref('')

  const selectionDuration = computed(() => Math.max(0, endTime.value - startTime.value))
  const hasVideo = computed(() => file.value !== null)
  /** Aktuelle Auswahl ist lang genug, um sie als Ausschnitt festzuhalten. */
  const canAddSegment = computed(() => selectionDuration.value >= MIN_SELECTION)
  /**
   * Die tatsächlich zu verarbeitenden Ausschnitte: die festgehaltene Liste –
   * oder, falls leer, die aktuelle Auswahl.
   */
  const effectiveSegments = computed<Segment[]>(() =>
    segments.value.length
      ? segments.value
      : selectionDuration.value >= MIN_SELECTION
        ? [{ start: startTime.value, end: endTime.value }]
        : [],
  )
  const canExport = computed(() => hasVideo.value && effectiveSegments.value.length > 0)

  function revokeObjectUrl(): void {
    if (objectUrl.value) {
      URL.revokeObjectURL(objectUrl.value)
      objectUrl.value = ''
    }
  }

  function revokeResult(): void {
    if (resultUrl.value) {
      URL.revokeObjectURL(resultUrl.value)
      resultUrl.value = ''
    }
    resultName.value = ''
    resultBlob.value = null
  }

  function setFile(newFile: File): void {
    revokeObjectUrl()
    revokeResult()
    error.value = ''
    file.value = newFile
    fileName.value = newFile.name
    objectUrl.value = URL.createObjectURL(newFile)
    duration.value = 0
    startTime.value = 0
    endTime.value = 0
    currentTime.value = 0
    segments.value = []
  }

  function setDuration(d: number): void {
    duration.value = Number.isFinite(d) && d > 0 ? d : 0
    startTime.value = 0
    endTime.value = duration.value
  }

  function setStart(t: number): void {
    // Start darf End nicht überholen.
    startTime.value = clamp(t, 0, Math.max(0, endTime.value - MIN_SELECTION))
  }

  function setEnd(t: number): void {
    // End darf Start nicht unterschreiten und nicht > Dauer sein.
    const lower = Math.min(startTime.value + MIN_SELECTION, duration.value)
    endTime.value = clamp(t, lower, duration.value)
  }

  function setCurrentTime(t: number): void {
    currentTime.value = clamp(t, 0, duration.value)
  }

  function setMode(m: TrimMode): void {
    mode.value = m
  }

  function setOperation(o: CutOperation): void {
    operation.value = o
  }

  /** Hält die aktuelle Auswahl als Ausschnitt fest (nach Start sortiert). */
  function addSegment(): void {
    if (selectionDuration.value < MIN_SELECTION) return
    const seg: Segment = { start: startTime.value, end: endTime.value }
    // Exakte Duplikate vermeiden.
    const exists = segments.value.some(
      (s) => Math.abs(s.start - seg.start) < 1e-3 && Math.abs(s.end - seg.end) < 1e-3,
    )
    if (exists) return
    segments.value = [...segments.value, seg].sort((a, b) => a.start - b.start)
  }

  function removeSegment(index: number): void {
    segments.value = segments.value.filter((_, i) => i !== index)
  }

  function clearSegments(): void {
    segments.value = []
  }

  function setResult(blob: Blob, name: string): void {
    revokeResult()
    resultBlob.value = blob
    resultUrl.value = URL.createObjectURL(blob)
    resultName.value = name
  }

  function setError(message: string): void {
    error.value = message
  }

  function reset(): void {
    revokeObjectUrl()
    revokeResult()
    file.value = null
    fileName.value = ''
    duration.value = 0
    startTime.value = 0
    endTime.value = 0
    currentTime.value = 0
    error.value = ''
    segments.value = []
  }

  return {
    // state
    file,
    objectUrl,
    fileName,
    duration,
    startTime,
    endTime,
    currentTime,
    mode,
    operation,
    segments,
    resultUrl,
    resultName,
    resultBlob,
    error,
    // getters
    selectionDuration,
    hasVideo,
    canAddSegment,
    effectiveSegments,
    canExport,
    // actions
    setFile,
    setDuration,
    setStart,
    setEnd,
    setCurrentTime,
    setMode,
    setOperation,
    addSegment,
    removeSegment,
    clearSegments,
    setResult,
    setError,
    revokeResult,
    reset,
  }
})
