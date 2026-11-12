import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import { clamp, type TrimMode } from '@/lib/ffmpegCommand'
import { computeKeepRanges, type KeepRange } from '@/lib/keepRanges'

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

/**
 * Ein weiteres Video, das beim Schneiden vollständig HINTER die Ausschnitte
 * gehängt (zusammengefügt) wird.
 */
/** Wo ein angehängtes Video landet: vor (Intro) oder hinter (Outro) den Ausschnitten. */
export type AppendPosition = 'before' | 'after'

export interface AppendClip {
  /** Stabile ID für Liste/Reihenfolge. */
  id: number
  file: File
  /** Gesamtdauer der Datei in Sekunden; 0 = (noch) unbekannt. */
  duration: number
  /** Verwendeter Bereich: Start (s) … Ende (s); `end: null` = bis zum Dateiende. */
  start: number
  end: number | null
  position: AppendPosition
  /**
   * Nur bei 'after': direkt hinter dem n-ten Teil des Hauptvideos einfügen
   * (1-basiert, zwischen zwei Ausschnitten). `null` = ganz am Ende.
   */
  slot: number | null
}

/** Ein Eintrag der Gesamtreihenfolge beim Zusammenfügen. */
export type MergeItem =
  | {
      kind: 'main'
      /** 0-basierter Index des Teils des Hauptvideos. */
      index: number
      /** Bereich des Teils; `null`, solange noch kein Ausschnitt existiert (Platzhalter). */
      range: KeepRange | null
    }
  | { kind: 'append'; clip: AppendClip }

/** Übergang an einer Nahtstelle (wie die globale Animation). */
export type SeamPreset = 'none' | 'fade' | 'slide' | 'scale' | 'flip'

/** Stabiler Schlüssel eines Eintrags der Gesamtreihenfolge. */
export function mergeItemKey(it: MergeItem): string {
  return it.kind === 'main' ? `main-${it.index}` : `clip-${it.clip.id}`
}

/**
 * Schlüssel einer Nahtstelle aus ihren beiden Nachbarn. Ändert sich die
 * Reihenfolge, entstehen neue Paare – deren Übergang ist dann wieder „Standard".
 */
export function seamKey(left: MergeItem, right: MergeItem): string {
  return `${mergeItemKey(left)}>${mergeItemKey(right)}`
}

/** Effektive Einfügestelle: Anzahl der Teile des Hauptvideos VOR dem Clip (wie im Backend). */
export function appendSlotOf(c: AppendClip, mainCount: number): number {
  if (c.position === 'before') return 0
  const s = c.slot
  if (s === null || !Number.isInteger(s) || s < 1 || s >= mainCount) return mainCount
  return s
}

/** Verwendete Länge eines angehängten Videos (0, solange die Dauer unbekannt ist). */
export function appendClipLength(c: AppendClip): number {
  const end = c.end ?? c.duration
  return end > 0 ? Math.max(0, end - c.start) : 0
}

/** Ist das angehängte Video gekürzt? */
export function isAppendTrimmed(c: AppendClip): boolean {
  return c.start > 0 || c.end !== null
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

/** Höchstzahl angehängter Videos (muss zu MAX_APPEND_FILES im Backend passen). */
export const MAX_APPEND_CLIPS = 5

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
  /**
   * Angehängte Videos (in Reihenfolge). Bewusst NICHT Teil von Undo/Redo –
   * es sind Dateien, keine Bearbeitungswerte.
   */
  const appendClips = ref<AppendClip[]>([])
  let nextAppendId = 1
  /** Lautstärke aller Clips beim Zusammenfügen angleichen (Einstellung, kein Undo). */
  const normalizeAudio = ref(false)
  /** Ausgabeformat (Einstellung, kein Undo). */
  const outputAspect = ref<OutputAspect>('auto')
  const outputFill = ref<OutputFill>('pad')
  /** Hintergrundmusik (`null` = keine). Wie angehängte Videos kein Teil von Undo. */
  const music = ref<MusicSettings | null>(null)
  /** Übergang je Nahtstelle (Schlüssel: seamKey). Fehlt = globaler Übergang. */
  const seamTransitions = ref<Record<string, SeamPreset>>({})

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
  /** Werden weitere Videos angehängt? (erzwingt Re-Encode.) */
  const hasAppends = computed(() => appendClips.value.length > 0)
  const canAppend = computed(() => appendClips.value.length < MAX_APPEND_CLIPS)
  /** Hintergrundmusik gewählt? (erzwingt Re-Encode.) */
  const hasMusic = computed(() => music.value !== null)
  /** Angehängte Videos getrennt nach Position (je Gruppe in Listenreihenfolge). */
  const appendsBefore = computed(() => appendClips.value.filter((c) => c.position === 'before'))
  const appendsAfter = computed(() => appendClips.value.filter((c) => c.position === 'after'))
  /**
   * Teile des Hauptvideos, so wie das Backend sie zusammenfügt (sortiert,
   * Überlappungen vereint; bei 'remove' der verbleibende Rest).
   */
  const mainParts = computed<KeepRange[]>(() =>
    computeKeepRanges(
      effectiveSegments.value.map((s) => ({ start: s.start, duration: s.end - s.start })),
      operation.value,
      operation.value === 'remove' ? duration.value : Number.POSITIVE_INFINITY,
    ),
  )
  /**
   * Gesamtreihenfolge: Teile des Hauptvideos in Zeitreihenfolge, angehängte
   * Videos an ihrer Einfügestelle. Ohne Ausschnitt steht ein Platzhalter-Teil.
   */
  const mergeItems = computed<MergeItem[]>(() => {
    const parts = mainParts.value
    const n = Math.max(1, parts.length)
    const items: MergeItem[] = []
    for (let k = 0; k <= n; k++) {
      if (k > 0) items.push({ kind: 'main', index: k - 1, range: parts[k - 1] ?? null })
      for (const clip of appendClips.value) {
        if (appendSlotOf(clip, n) === k) items.push({ kind: 'append', clip })
      }
    }
    return items
  })
  /** Übergang je Nahtstelle in Gesamtreihenfolge (`null` = globaler Übergang). */
  const seamPresets = computed<(SeamPreset | null)[]>(() =>
    mergeItems.value
      .slice(1)
      .map((it, i) => seamTransitions.value[seamKey(mergeItems.value[i], it)] ?? null),
  )
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
    appendClips.value = []
    music.value = null
    seamTransitions.value = {}
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

  /**
   * Hängt Videos an (max. MAX_APPEND_CLIPS insgesamt). Gibt die angelegten
   * Einträge zurück, damit die UI deren Dauer nachladen kann.
   */
  function addAppendClips(files: File[]): AppendClip[] {
    const free = MAX_APPEND_CLIPS - appendClips.value.length
    const added = files.slice(0, Math.max(0, free)).map((file) => ({
      id: nextAppendId++,
      file,
      duration: 0,
      start: 0,
      end: null,
      position: 'after' as AppendPosition,
      slot: null,
    }))
    if (added.length) appendClips.value = [...appendClips.value, ...added]
    return added
  }

  function updateAppend(id: number, fn: (c: AppendClip) => AppendClip): void {
    appendClips.value = appendClips.value.map((c) => (c.id === id ? fn(c) : c))
  }

  /** Begrenzt Start/Ende auf die (bekannte) Dauer mit Mindestlänge. */
  function clampAppendRange(c: AppendClip): AppendClip {
    const dur = c.duration
    let start = Math.max(0, Number.isFinite(c.start) ? c.start : 0)
    let end = c.end
    if (dur > 0) {
      start = Math.min(start, Math.max(0, dur - MIN_SELECTION))
      if (end !== null) end = clamp(end, Math.min(start + MIN_SELECTION, dur), dur)
      // Ende = Dateiende -> wieder „bis zum Ende" (ungekürzt).
      if (end !== null && dur - end < 1e-3) end = null
    } else if (end !== null) {
      end = Math.max(end, start + MIN_SELECTION)
    }
    return { ...c, start, end }
  }

  function setAppendDuration(id: number, d: number): void {
    const dur = Number.isFinite(d) && d > 0 ? d : 0
    updateAppend(id, (c) => clampAppendRange({ ...c, duration: dur }))
  }

  /** Setzt den Start des verwendeten Bereichs; zieht das Ende bei Bedarf mit. */
  function setAppendStart(id: number, t: number): void {
    updateAppend(id, (c) => {
      const start = Number.isFinite(t) ? Math.max(0, t) : 0
      const end = c.end !== null && c.end < start + MIN_SELECTION ? null : c.end
      return clampAppendRange({ ...c, start, end })
    })
  }

  /** Setzt das Ende des verwendeten Bereichs; `null` = bis zum Dateiende. */
  function setAppendEnd(id: number, t: number | null): void {
    updateAppend(id, (c) =>
      clampAppendRange({ ...c, end: t === null || !Number.isFinite(t) ? null : t }),
    )
  }

  /** Kürzung aufheben (ganzes Video verwenden). */
  function resetAppendRange(id: number): void {
    updateAppend(id, (c) => ({ ...c, start: 0, end: null }))
  }

  /** Davor/Danach setzen – setzt eine Einfügestelle zwischen Ausschnitten zurück. */
  function setAppendPosition(id: number, position: AppendPosition): void {
    updateAppend(id, (c) => ({ ...c, position, slot: null }))
  }

  /**
   * Übernimmt eine neue Gesamtreihenfolge: Position/Einfügestelle jedes
   * angehängten Videos ergibt sich aus der Zahl der Hauptvideo-Teile davor.
   */
  function applyMergeOrder(items: MergeItem[]): void {
    const n = items.filter((it) => it.kind === 'main').length
    let k = 0
    const next: AppendClip[] = []
    for (const it of items) {
      if (it.kind === 'main') {
        k++
        continue
      }
      const current = appendClips.value.find((c) => c.id === it.clip.id)
      if (!current) continue
      if (k === 0) next.push({ ...current, position: 'before', slot: null })
      else if (k >= n) next.push({ ...current, position: 'after', slot: null })
      else next.push({ ...current, position: 'after', slot: k })
    }
    // Sicherheitsnetz: nichts verlieren, falls ein Clip in `items` fehlt.
    for (const c of appendClips.value) if (!next.some((x) => x.id === c.id)) next.push(c)
    appendClips.value = next
  }

  /**
   * Verschiebt ein angehängtes Video in der Gesamtreihenfolge an Stelle
   * `toIndex` (Index in der Liste OHNE das verschobene Video). Teile des
   * Hauptvideos bleiben in Zeitreihenfolge; das Video kann davor, dazwischen
   * oder dahinter landen (Drag & Drop).
   */
  function moveMergeItem(id: number, toIndex: number): void {
    const items = [...mergeItems.value]
    const from = items.findIndex((it) => it.kind === 'append' && it.clip.id === id)
    if (from < 0 || !Number.isFinite(toIndex)) return
    const [moved] = items.splice(from, 1)
    const to = Math.min(Math.max(0, Math.trunc(toIndex)), items.length)
    items.splice(to, 0, moved)
    applyMergeOrder(items)
  }

  function removeAppendClip(id: number): void {
    appendClips.value = appendClips.value.filter((c) => c.id !== id)
  }

  /**
   * Verschiebt ein angehängtes Video in der Gesamtreihenfolge um einen Platz
   * (▲▼): an anderen Videos und an Teilen des Hauptvideos vorbei – so wird
   * z. B. aus einem Outro ein Video zwischen zwei Ausschnitten.
   */
  function moveAppendClip(id: number, delta: number): void {
    if (delta === 0) return
    const from = mergeItems.value.findIndex((it) => it.kind === 'append' && it.clip.id === id)
    if (from < 0) return
    const to = from + (delta < 0 ? -1 : 1)
    if (to < 0 || to >= mergeItems.value.length) return
    moveMergeItem(id, to)
  }

  function setNormalizeAudio(on: boolean): void {
    normalizeAudio.value = on
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

  /** Übergang einer Nahtstelle setzen; `null` = wieder globaler Übergang. */
  function setSeamTransition(key: string, preset: SeamPreset | null): void {
    const next = { ...seamTransitions.value }
    if (preset === null) delete next[key]
    else next[key] = preset
    seamTransitions.value = next
  }

  function clearAppendClips(): void {
    appendClips.value = []
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
    // Angehängte Videos und Musik sind jetzt Teil des Ergebnisses.
    appendClips.value = []
    music.value = null
    seamTransitions.value = {}
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
    appendClips.value = []
    music.value = null
    seamTransitions.value = {}
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
    appendClips,
    normalizeAudio,
    outputAspect,
    outputFill,
    music,
    seamTransitions,
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
    hasAppends,
    canAppend,
    hasMusic,
    appendsBefore,
    appendsAfter,
    mainParts,
    mergeItems,
    seamPresets,
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
    addAppendClips,
    setAppendDuration,
    setAppendStart,
    setAppendEnd,
    resetAppendRange,
    setAppendPosition,
    removeAppendClip,
    moveAppendClip,
    moveMergeItem,
    setNormalizeAudio,
    setOutputAspect,
    setOutputFill,
    setMusicFile,
    updateMusic,
    clearMusic,
    setSeamTransition,
    clearAppendClips,
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
