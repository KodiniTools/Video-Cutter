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

/** Ausgabe-Seitenverhältnis: 'auto' = wie das (ggf. zugeschnittene) Hauptvideo. */
export type OutputAspect = 'auto' | '16:9' | '9:16' | '1:1'
/** Füllmodus bei abweichendem Seitenverhältnis: Balken, unscharfer Hintergrund, zuschneiden. */
export type OutputFill = 'pad' | 'blur' | 'crop'

/** Hintergrundmusik, die unter das gesamte Ergebnis gemischt wird. */
export interface MusicSettings {
  file: File
  /** Musik-Lautstärke 0–1. */
  volume: number
  /** Lautstärke des Originaltons 0–1. */
  originalVolume: number
  /** Am Anfang ein-, am Ende ausblenden. */
  fade: boolean
  /** Wiederholen, falls die Musik kürzer als das Video ist. */
  loop: boolean
}

/** Standardwerte für neu gewählte Musik. */
export const DEFAULT_MUSIC_VOLUME = 0.3

/** Der rückgängig-/wiederherstellbare Teil des Editor-Zustands (siehe history-Store). */
export interface EditorSnapshot {
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
  /** Ausgabeformat (Einstellung, kein Undo). */
  const outputAspect = ref<OutputAspect>('auto')
  const outputFill = ref<OutputFill>('pad')
  /**
   * Hintergrundmusik (`null` = keine). Kein Teil von Undo; bleibt beim
   * Wechsel des markierten Videos erhalten (gilt fürs nächste Ergebnis).
   */
  const music = ref<MusicSettings | null>(null)

  // --- Fehler ---
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
  /** Zuschneiden aktiv? (erzwingt Re-Encode, da FFmpeg dafür Frames dekodieren muss.) */
  const hasCrop = computed(() => crop.value !== null)
  /** Hintergrundmusik gewählt? (erzwingt Re-Encode.) */
  const hasMusic = computed(() => music.value !== null)
  /** Ausgewählte Auflösung in Pixeln, falls die Quellauflösung bekannt ist. */
  const cropPixelSize = computed(() => {
    if (!crop.value || !videoWidth.value || !videoHeight.value) return null
    return {
      width: Math.round(crop.value.width * videoWidth.value),
      height: Math.round(crop.value.height * videoHeight.value),
    }
  })

  /**
   * Zählt Ladevorgänge (neues Video, Dauer bekannt, Zurücksetzen). Der
   * Rückgängig-Verlauf übernimmt die dabei gesetzten Werte stillschweigend,
   * statt sie als Bearbeitungsschritt zu werten.
   */
  const loadSeq = ref(0)

  /** Der rückgängig-/wiederherstellbare Teil des Zustands als Kopie. */
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

  /** Stellt einen Zustand aus `snapshot()` wieder her (Rückgängig/Wiederholen). */
  function applySnapshot(s: EditorSnapshot): void {
    startTime.value = s.startTime
    endTime.value = s.endTime
    mode.value = s.mode
    operation.value = s.operation
    segments.value = s.segments.map((seg) => ({ ...seg }))
    crop.value = s.crop ? { ...s.crop } : null
  }

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

  function setFile(newFile: File): void {
    revokeObjectUrl()
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
    loadSeq.value++
  }

  function setDuration(d: number): void {
    const next = Number.isFinite(d) && d > 0 ? d : 0
    // `durationchange` + `loadedmetadata` melden dieselbe Dauer doppelt; ein
    // zweiter Aufruf darf die (evtl. schon wiederhergestellte) Auswahl nicht
    // erneut zurücksetzen.
    if (next === duration.value && next > 0) return
    duration.value = next
    startTime.value = 0
    endTime.value = duration.value
    loadSeq.value++
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

  /**
   * Übernimmt Bereiche zum ENTFERNEN (z. B. KI-Schnittvorschläge): stellt auf
   * „Entfernen" um und ergänzt die Ausschnitt-Liste. Waren bisher Bereiche zum
   * Behalten festgehalten, werden sie ersetzt (Rückgängig möglich).
   */
  function addRemoveRanges(ranges: Segment[]): void {
    const valid = ranges.filter((r) => r.end - r.start >= MIN_SELECTION)
    if (!valid.length) return
    const base = operation.value === 'remove' ? segments.value : []
    const merged = [...base]
    for (const r of valid) {
      const dup = merged.some(
        (s) => Math.abs(s.start - r.start) < 1e-3 && Math.abs(s.end - r.end) < 1e-3,
      )
      if (!dup) merged.push({ start: r.start, end: r.end })
    }
    operation.value = 'remove'
    segments.value = merged.sort((a, b) => a.start - b.start)
  }

  function setOutputAspect(a: OutputAspect): void {
    outputAspect.value = a
  }

  function setOutputFill(f: OutputFill): void {
    outputFill.value = f
  }

  /** Wählt eine Musikdatei; Einstellungen einer vorherigen Musik bleiben erhalten. */
  function setMusicFile(f: File): void {
    music.value = music.value
      ? { ...music.value, file: f }
      : { file: f, volume: DEFAULT_MUSIC_VOLUME, originalVolume: 1, fade: true, loop: true }
  }

  /** Ändert Musik-Einstellungen; Lautstärken werden auf 0–1 begrenzt. */
  function updateMusic(patch: Partial<Omit<MusicSettings, 'file'>>): void {
    if (!music.value) return
    const next = { ...music.value, ...patch }
    const unit = (v: number, fb: number) => (Number.isFinite(v) ? clamp(v, 0, 1) : fb)
    next.volume = unit(next.volume, music.value.volume)
    next.originalVolume = unit(next.originalVolume, music.value.originalVolume)
    music.value = next
  }

  function clearMusic(): void {
    music.value = null
  }

  function removeSegment(index: number): void {
    segments.value = segments.value.filter((_, i) => i !== index)
  }

  function clearSegments(): void {
    segments.value = []
  }

  function setError(message: string): void {
    error.value = message
  }

  function reset(): void {
    revokeObjectUrl()
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
    music.value = null
    loadSeq.value++
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
    outputAspect,
    outputFill,
    music,
    error,
    // getters
    selectionDuration,
    hasVideo,
    canAddSegment,
    effectiveSegments,
    canExport,
    loadSeq,
    hasCrop,
    cropPixelSize,
    hasMusic,
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
    addRemoveRanges,
    removeSegment,
    clearSegments,
    setOutputAspect,
    setOutputFill,
    setMusicFile,
    updateMusic,
    clearMusic,
    setCrop,
    enableCrop,
    clearCrop,
    toggleCrop,
    setError,
    reset,
    // Rückgängig/Wiederholen (history-Store)
    snapshot,
    applySnapshot,
  }
})
