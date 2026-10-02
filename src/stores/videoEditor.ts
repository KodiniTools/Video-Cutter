import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import { clamp, type TrimMode } from '@/lib/ffmpegCommand'

/** 'keep' = Auswahl behalten, 'remove' = Auswahl entfernen (Rest zusammenfügen). */
export type CutOperation = 'keep' | 'remove'

/** Ein festgehaltener Ausschnitt (Start/Ende in Sekunden). */
export interface Segment {
  start: number
  end: number
}

/**
 * Räumlicher Bildausschnitt (Crop). Alle Werte sind Anteile [0, 1] der
 * Originalbreite/-höhe – unabhängig von der Vorschaugröße, direkt für den
 * FFmpeg-`crop`-Filter (iw/ih-Ausdrücke) auf dem Server nutzbar.
 */
export interface CropRect {
  x: number
  y: number
  width: number
  height: number
}

/** Der rückgängig-/wiederherstellbare Teil des Editor-Zustands. */
interface EditorSnapshot {
  startTime: number
  endTime: number
  mode: TrimMode
  operation: CutOperation
  segments: Segment[]
  crop: CropRect | null
}

/** Mindestlänge der Auswahl in Sekunden. */
const MIN_SELECTION = 0.05

/** Mindestgröße des Bildausschnitts (Anteil der jeweiligen Kante). */
export const MIN_CROP_RATIO = 0.1

/** Voreingestellter Ausschnitt beim Aktivieren (zentriert, 80 %). */
const DEFAULT_CROP: CropRect = { x: 0.1, y: 0.1, width: 0.8, height: 0.8 }

/** Verzögerung, bis eine Änderungsserie (z. B. Ziehen) als ein Schritt gilt. */
const HISTORY_DEBOUNCE_MS = 350

export const useVideoEditorStore = defineStore('videoEditor', () => {
  // --- Quellvideo ---
  const file = ref<File | null>(null)
  const objectUrl = ref('')
  const fileName = ref('')
  const duration = ref(0)
  /** Intrinsische Video-Auflösung (px), sobald bekannt – nur für die Anzeige. */
  const videoWidth = ref(0)
  const videoHeight = ref(0)

  // --- Auswahl / Wiedergabe ---
  const startTime = ref(0)
  const endTime = ref(0)
  const currentTime = ref(0)
  const mode = ref<TrimMode>('copy')
  /** Ob die Auswahl behalten oder entfernt wird. */
  const operation = ref<CutOperation>('keep')
  /** Festgehaltene Ausschnitte. Ist die Liste leer, gilt die aktuelle Auswahl. */
  const segments = ref<Segment[]>([])
  /** Räumlicher Bildausschnitt. `null` = kein Zuschneiden (volles Bild). */
  const crop = ref<CropRect | null>(null)

  // --- Ergebnis / Fehler ---
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
  /** Liegt ein herunterladbares Schnitt-Ergebnis vor? */
  const hasResult = computed(() => resultBlob.value !== null)
  /** Zuschneiden aktiv? (erzwingt Re-Encode, da FFmpeg dafür Frames dekodieren muss.) */
  const hasCrop = computed(() => crop.value !== null)
  /** Ausgewählte Auflösung in Pixeln, falls die Quellauflösung bekannt ist. */
  const cropPixelSize = computed(() => {
    if (!crop.value || !videoWidth.value || !videoHeight.value) return null
    return {
      width: Math.round(crop.value.width * videoWidth.value),
      height: Math.round(crop.value.height * videoHeight.value),
    }
  })

  // --- Undo/Redo -----------------------------------------------------------
  // Rückgängig/Wiederherstellen deckt Auswahl (Start/Ende), Ausschnitt-Liste,
  // Modus und Aktion ab – nicht das geladene Video oder die Wiedergabeposition.
  // Änderungsserien (Ziehen, mehrfaches Tippen) werden per Debounce zu einem
  // Schritt zusammengefasst.
  const undoStack = ref<EditorSnapshot[]>([])
  const redoStack = ref<EditorSnapshot[]>([])
  let baseline: EditorSnapshot | null = null
  let applyingHistory = false
  let commitTimer: ReturnType<typeof setTimeout> | null = null

  const canUndo = computed(() => undoStack.value.length > 0)
  const canRedo = computed(() => redoStack.value.length > 0)

  function snapshot(): EditorSnapshot {
    return {
      startTime: startTime.value,
      endTime: endTime.value,
      mode: mode.value,
      operation: operation.value,
      segments: segments.value.map((s) => ({ ...s })),
      crop: crop.value ? { ...crop.value } : null,
    }
  }

  function sameSegments(a: Segment[], b: Segment[]): boolean {
    if (a.length !== b.length) return false
    return a.every((s, i) => s.start === b[i].start && s.end === b[i].end)
  }

  function sameCrop(a: CropRect | null, b: CropRect | null): boolean {
    if (a === null || b === null) return a === b
    return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
  }

  function sameSnapshot(a: EditorSnapshot, b: EditorSnapshot): boolean {
    return (
      a.startTime === b.startTime &&
      a.endTime === b.endTime &&
      a.mode === b.mode &&
      a.operation === b.operation &&
      sameSegments(a.segments, b.segments) &&
      sameCrop(a.crop, b.crop)
    )
  }

  function applySnapshot(s: EditorSnapshot): void {
    applyingHistory = true
    startTime.value = s.startTime
    endTime.value = s.endTime
    mode.value = s.mode
    operation.value = s.operation
    segments.value = s.segments.map((seg) => ({ ...seg }))
    crop.value = s.crop ? { ...s.crop } : null
    applyingHistory = false
  }

  /** Übernimmt den aktuellen Zustand als neuen History-Schritt (falls geändert). */
  function commitHistory(): void {
    if (commitTimer) {
      clearTimeout(commitTimer)
      commitTimer = null
    }
    const cur = snapshot()
    if (!baseline) {
      baseline = cur
      return
    }
    if (sameSnapshot(cur, baseline)) return
    undoStack.value = [...undoStack.value, baseline]
    redoStack.value = []
    baseline = cur
  }

  /** Setzt die History auf den aktuellen Zustand als Ausgangspunkt zurück. */
  function resetHistory(): void {
    if (commitTimer) {
      clearTimeout(commitTimer)
      commitTimer = null
    }
    undoStack.value = []
    redoStack.value = []
    baseline = snapshot()
  }

  function undo(): void {
    commitHistory() // eventuelle, noch nicht übernommene Änderung festschreiben
    if (!undoStack.value.length) return
    const prev = undoStack.value[undoStack.value.length - 1]
    undoStack.value = undoStack.value.slice(0, -1)
    if (baseline) redoStack.value = [...redoStack.value, baseline]
    applySnapshot(prev)
    baseline = snapshot()
  }

  function redo(): void {
    commitHistory()
    if (!redoStack.value.length) return
    const next = redoStack.value[redoStack.value.length - 1]
    redoStack.value = redoStack.value.slice(0, -1)
    if (baseline) undoStack.value = [...undoStack.value, baseline]
    applySnapshot(next)
    baseline = snapshot()
  }

  // Änderungen am editierbaren Zustand beobachten und (verzögert) festschreiben.
  // flush: 'sync', damit der applyingHistory-Schutz beim Anwenden greift.
  watch(
    [startTime, endTime, mode, operation, segments, crop],
    () => {
      if (applyingHistory) return
      if (commitTimer) clearTimeout(commitTimer)
      commitTimer = setTimeout(commitHistory, HISTORY_DEBOUNCE_MS)
    },
    { deep: true, flush: 'sync' },
  )

  /**
   * Gibt die aktuelle Blob-URL frei – aber erst NACH dem nächsten DOM-Update.
   * Der <video>-Player hält die alte URL bis zum Re-Render und lädt daraus
   * ggf. noch Daten (Range-Requests); ein sofortiges Revoke löst in Chrome
   * „blob:… net::ERR_FILE_NOT_FOUND" in der Konsole aus.
   */
  function revokeObjectUrl(): void {
    const old = objectUrl.value
    if (!old) return
    objectUrl.value = ''
    setTimeout(() => {
      if (typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(old)
    }, 0)
  }

  function revokeResult(): void {
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
    videoWidth.value = 0
    videoHeight.value = 0
    startTime.value = 0
    endTime.value = 0
    currentTime.value = 0
    segments.value = []
    crop.value = null
  }

  function setDuration(d: number): void {
    duration.value = Number.isFinite(d) && d > 0 ? d : 0
    startTime.value = 0
    endTime.value = duration.value
    // Frisch geladenes Video = Ausgangspunkt der History (kein Undo darüber).
    resetHistory()
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

  /**
   * Setzt den Start auf eine absolute Zeit (z. B. die Wiedergabeposition).
   * Anders als `setStart` zieht es das Ende mit, falls es davor liegt – so
   * lässt sich ein neuer Ausschnitt an beliebiger Stelle aufziehen.
   */
  function markStart(t: number): void {
    const v = clamp(t, 0, duration.value)
    startTime.value = v
    if (endTime.value < v) endTime.value = v
  }

  /** Setzt das Ende auf eine absolute Zeit; zieht den Start mit, falls nötig. */
  function markEnd(t: number): void {
    const v = clamp(t, 0, duration.value)
    endTime.value = v
    if (startTime.value > v) startTime.value = v
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

  /** Hält die intrinsische Auflösung fest (nur für die Pixel-Anzeige). */
  function setVideoDimensions(width: number, height: number): void {
    videoWidth.value = Number.isFinite(width) && width > 0 ? Math.round(width) : 0
    videoHeight.value = Number.isFinite(height) && height > 0 ? Math.round(height) : 0
  }

  /** Begrenzt einen Crop-Rechteck auf [0,1] mit Mindestgröße, ohne über den Rand zu ragen. */
  function clampCrop(r: CropRect): CropRect {
    const width = clamp(r.width, MIN_CROP_RATIO, 1)
    const height = clamp(r.height, MIN_CROP_RATIO, 1)
    const x = clamp(r.x, 0, 1 - width)
    const y = clamp(r.y, 0, 1 - height)
    return { x, y, width, height }
  }

  /** Setzt/aktualisiert den Bildausschnitt (Anteile 0–1). */
  function setCrop(r: CropRect): void {
    crop.value = clampCrop(r)
  }

  /** Aktiviert das Zuschneiden mit einem zentrierten Standardausschnitt. */
  function enableCrop(): void {
    crop.value = { ...DEFAULT_CROP }
  }

  /** Deaktiviert das Zuschneiden (volles Bild). */
  function clearCrop(): void {
    crop.value = null
  }

  /** Schaltet das Zuschneiden ein/aus (Toolbar-Button). */
  function toggleCrop(): void {
    if (crop.value) clearCrop()
    else enableCrop()
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
    // Entwurf für den nächsten Ausschnitt an der aktuellen Position frisch
    // aufsetzen (leere Auswahl an der Wiedergabeposition).
    startTime.value = currentTime.value
    endTime.value = currentTime.value
  }

  function removeSegment(index: number): void {
    segments.value = segments.value.filter((_, i) => i !== index)
  }

  function clearSegments(): void {
    segments.value = []
  }

  /**
   * Macht das Schnitt-Ergebnis zum neuen Arbeitsvideo: Es wird im selben
   * (ersten) Player angezeigt – KEIN zweites Vorschaufenster. Ein weiterer
   * Schnitt arbeitet damit auf dem Ergebnis (kumulativ, wie im Audio-Cutter).
   * Der Blob bleibt für den separaten „Herunterladen"-Button erhalten.
   */
  function applyCutResult(blob: Blob, name: string): void {
    revokeObjectUrl()
    file.value = new File([blob], name, { type: blob.type || 'video/mp4' })
    fileName.value = name
    objectUrl.value = URL.createObjectURL(blob)
    duration.value = 0
    videoWidth.value = 0
    videoHeight.value = 0
    startTime.value = 0
    endTime.value = 0
    currentTime.value = 0
    segments.value = []
    crop.value = null
    error.value = ''
    // Ergebnis für den Download bereithalten.
    resultBlob.value = blob
    resultName.value = name
    // Die History wird nach dem Laden (setDuration) neu aufgesetzt.
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
    videoWidth.value = 0
    videoHeight.value = 0
    startTime.value = 0
    endTime.value = 0
    currentTime.value = 0
    error.value = ''
    segments.value = []
    crop.value = null
    resetHistory()
  }

  return {
    // state
    file,
    objectUrl,
    fileName,
    duration,
    videoWidth,
    videoHeight,
    startTime,
    endTime,
    currentTime,
    mode,
    operation,
    segments,
    crop,
    resultName,
    resultBlob,
    hasResult,
    error,
    // getters
    selectionDuration,
    hasVideo,
    canAddSegment,
    effectiveSegments,
    canExport,
    canUndo,
    canRedo,
    hasCrop,
    cropPixelSize,
    // actions
    setFile,
    setDuration,
    setVideoDimensions,
    setStart,
    setEnd,
    markStart,
    markEnd,
    setCurrentTime,
    setMode,
    setOperation,
    addSegment,
    removeSegment,
    clearSegments,
    setCrop,
    enableCrop,
    clearCrop,
    toggleCrop,
    applyCutResult,
    setError,
    revokeResult,
    reset,
    // history
    undo,
    redo,
    commitHistory,
    resetHistory,
  }
})
