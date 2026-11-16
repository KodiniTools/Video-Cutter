import { defineStore } from 'pinia'
import { computed, ref, shallowRef } from 'vue'
import {
  addTrack as addTrackOp,
  appendMedia as appendMediaOp,
  assetInUse,
  createDoc,
  docDuration,
  findClip,
  insertClip as insertClipOp,
  isTime,
  moveClip as moveClipOp,
  putAsset as putAssetOp,
  removeAsset as removeAssetOp,
  removeClip as removeClipOp,
  removeTrack as removeTrackOp,
  snapPoints,
  snapTime,
  snapToFrame,
  splitClip as splitClipOp,
  trimClip as trimClipOp,
  updateTrack as updateTrackOp,
  validateDoc,
  type AssetRef,
  type Clip,
  type DocIssue,
  type MoveTarget,
  type NewTrack,
  type OpError,
  type OpResult,
  type Time,
  type TimelineDoc,
  type TrackPatch,
} from '@/timeline/model'

/** So viele Schritte merkt sich der Verlauf höchstens. */
export const MAX_TIMELINE_HISTORY = 200

/** Kleinster/größter Zoom in Pixel je Sekunde. */
export const MIN_ZOOM = 2
export const MAX_ZOOM = 2000
const DEFAULT_ZOOM = 100

/**
 * Zustand des Timeline-Editors: das Dokument als einzige Quelle der Wahrheit,
 * dazu Auswahl, Abspielkopf, Zoom und der Rückgängig-Verlauf.
 *
 * Das Dokument wird nur über Befehle des Modells geändert (`apply`). Da diese
 * nie in ihre Eingabe schreiben, genügt es, für Rückgängig/Wiederholen die
 * früheren Dokumente aufzuheben – unveränderte Teile werden geteilt.
 */
export const useTimelineStore = defineStore('timeline', () => {
  const doc = shallowRef<TimelineDoc>(createDoc())
  const past = shallowRef<TimelineDoc[]>([])
  const future = shallowRef<TimelineDoc[]>([])

  const playhead = ref<Time>(0)
  /** IDs der markierten Clips. */
  const selection = ref<string[]>([])
  /** Zoom in Pixel je Sekunde. */
  const zoom = ref(DEFAULT_ZOOM)
  const snapping = ref(true)
  /** Grund, warum der letzte Befehl abgelehnt wurde (`null` = angenommen). */
  const lastError = ref<OpError | null>(null)

  /** Läuft gerade eine Geste (Ziehen)? Dann zählt alles bis `endGesture` als ein Schritt. */
  let gestureStart: TimelineDoc | null = null

  const duration = computed(() => docDuration(doc.value))
  const canUndo = computed(() => past.value.length > 0)
  const canRedo = computed(() => future.value.length > 0)
  const selectedClips = computed(() =>
    selection.value.flatMap((id) => {
      const loc = findClip(doc.value, id)
      return loc ? [loc.clip] : []
    }),
  )

  /** Auswahl auf Clips beschränken, die es (noch) gibt. */
  function pruneSelection(): void {
    const kept = selection.value.filter((id) => findClip(doc.value, id) !== null)
    if (kept.length !== selection.value.length) selection.value = kept
  }

  /**
   * Früheren Stand wiederherstellen. Angemeldete Medien gehören nicht zum
   * Verlauf: Was inzwischen hochgeladen wurde, bleibt bekannt.
   */
  function restore(target: TimelineDoc): void {
    doc.value = { ...target, assets: { ...target.assets, ...doc.value.assets } }
    pruneSelection()
  }

  function pushPast(previous: TimelineDoc): void {
    const next = [...past.value, previous]
    past.value = next.length > MAX_TIMELINE_HISTORY ? next.slice(-MAX_TIMELINE_HISTORY) : next
    future.value = []
  }

  /**
   * Befehl ausführen. Liefert `true`, wenn er angenommen wurde; sonst bleibt
   * alles unverändert und `lastError` nennt den Grund.
   */
  function apply(op: (current: TimelineDoc) => OpResult): boolean {
    const result = op(doc.value)
    if (!result.ok) {
      lastError.value = result.error
      return false
    }
    lastError.value = null
    if (result.doc === doc.value) return true
    if (gestureStart === null) pushPast(doc.value)
    doc.value = result.doc
    pruneSelection()
    return true
  }

  /** Beginn einer Geste (z. B. Zeiger gedrückt): Folgebefehle bilden einen Schritt. */
  function beginGesture(): void {
    if (gestureStart === null) gestureStart = doc.value
  }

  /** Ende der Geste: Hat sich etwas geändert, entsteht genau ein Verlaufsschritt. */
  function endGesture(): void {
    const start = gestureStart
    gestureStart = null
    if (start !== null && start !== doc.value) pushPast(start)
  }

  /** Geste abbrechen (z. B. Esc): Stand vom Beginn der Geste wiederherstellen. */
  function cancelGesture(): void {
    const start = gestureStart
    gestureStart = null
    if (start !== null && start !== doc.value) restore(start)
  }

  function undo(): boolean {
    endGesture()
    const previous = past.value[past.value.length - 1]
    if (!previous) return false
    past.value = past.value.slice(0, -1)
    future.value = [...future.value, doc.value]
    restore(previous)
    lastError.value = null
    return true
  }

  function redo(): boolean {
    endGesture()
    const next = future.value[future.value.length - 1]
    if (!next) return false
    future.value = future.value.slice(0, -1)
    past.value = [...past.value, doc.value]
    restore(next)
    lastError.value = null
    return true
  }

  /**
   * Dokument laden (z. B. Projekt öffnen). Verletzt es die Regeln des Modells,
   * wird nichts geladen und die Verstöße werden zurückgegeben. Der Verlauf
   * beginnt neu.
   */
  function load(next: TimelineDoc): DocIssue[] {
    const issues = validateDoc(next)
    if (issues.length > 0) return issues
    gestureStart = null
    doc.value = next
    past.value = []
    future.value = []
    selection.value = []
    playhead.value = 0
    lastError.value = null
    return []
  }

  /** Leeres Dokument, Verlauf und Auswahl zurückgesetzt. */
  function reset(): void {
    load(createDoc())
  }

  // --- Befehle -------------------------------------------------------------

  /** Medium anmelden/aktualisieren – bewusst kein Verlaufsschritt. */
  function putAsset(asset: AssetRef): void {
    const before = doc.value
    doc.value = putAssetOp(before, asset)
    // Eine laufende Geste soll das nicht als Änderung werten.
    if (gestureStart === before) gestureStart = doc.value
  }

  /**
   * Medium abmelden – wie das Anmelden kein Verlaufsschritt. Abgelehnt, solange
   * ein Clip es verwendet. Kommt es nur noch in früheren Ständen vor, wird der
   * Verlauf geleert: „Rückgängig“ dürfte sonst Clips ohne Medium zurückholen.
   */
  function removeAsset(assetId: string): boolean {
    endGesture()
    const result = removeAssetOp(doc.value, assetId)
    if (!result.ok) {
      lastError.value = result.error
      return false
    }
    lastError.value = null
    const strip = (d: TimelineDoc): TimelineDoc => {
      if (!d.assets[assetId]) return d
      const assets = { ...d.assets }
      delete assets[assetId]
      return { ...d, assets }
    }
    if ([...past.value, ...future.value].some((d) => assetInUse(d, assetId))) {
      past.value = []
      future.value = []
    } else {
      // Sonst käme das Medium beim Rückgängigmachen aus einem alten Stand zurück.
      past.value = past.value.map(strip)
      future.value = future.value.map(strip)
    }
    doc.value = result.doc
    return true
  }

  const addTrack = (track: NewTrack, index?: number) => apply((d) => addTrackOp(d, track, index))
  const removeTrack = (trackId: string) => apply((d) => removeTrackOp(d, trackId))
  const updateTrack = (trackId: string, patch: TrackPatch) =>
    apply((d) => updateTrackOp(d, trackId, patch))
  const insertClip = (trackId: string, clip: Clip) => apply((d) => insertClipOp(d, trackId, clip))
  const moveClip = (clipId: string, to: MoveTarget, opts?: { linked?: boolean }) =>
    apply((d) => moveClipOp(d, clipId, to, opts))
  const trimClip = (clipId: string, edge: 'start' | 'end', to: Time) =>
    apply((d) => trimClipOp(d, clipId, edge, to))
  const splitClip = (clipId: string, at: Time, opts?: { linked?: boolean }) =>
    apply((d) => splitClipOp(d, clipId, at, opts))
  const removeClip = (clipId: string, opts?: { ripple?: boolean; linked?: boolean }) =>
    apply((d) => removeClipOp(d, clipId, opts))

  /**
   * Video aus der Medienliste ans Ende der Timeline legen (ein Verlaufsschritt)
   * und die neuen Clips markieren.
   */
  function appendMedia(assetId: string): boolean {
    const before = new Set(doc.value.tracks.flatMap((t) => t.clips.map((c) => c.id)))
    if (!apply((d) => appendMediaOp(d, assetId))) return false
    selection.value = doc.value.tracks
      .flatMap((t) => t.clips.map((c) => c.id))
      .filter((id) => !before.has(id))
    return true
  }

  /** Alle markierten Clips am Abspielkopf teilen (ein Verlaufsschritt). */
  function splitSelectionAtPlayhead(): boolean {
    const at = playhead.value
    return apply((current) => {
      let next = current
      let split = false
      for (const id of selection.value) {
        const loc = findClip(next, id)
        // Verknüpfte Clips wurden evtl. schon mitgeteilt und enden jetzt am Abspielkopf.
        if (!loc || !(loc.clip.start < at && at < loc.clip.start + loc.clip.duration)) continue
        const result = splitClipOp(next, id, at)
        if (!result.ok) return result
        next = result.doc
        split = true
      }
      return split ? { ok: true, doc: next } : { ok: false, error: 'invalid-time' }
    })
  }

  /** Alle markierten Clips löschen (ein Verlaufsschritt). */
  function removeSelection(opts: { ripple?: boolean } = {}): boolean {
    if (selection.value.length === 0) return false
    return apply((current) => {
      let next = current
      for (const id of selection.value) {
        // Verknüpfte Clips sind evtl. schon mitgelöscht.
        if (!findClip(next, id)) continue
        const result = removeClipOp(next, id, opts)
        if (!result.ok) return result
        next = result.doc
      }
      return { ok: true, doc: next }
    })
  }

  // --- Ansicht -------------------------------------------------------------

  function select(ids: readonly string[]): void {
    selection.value = [...new Set(ids)].filter((id) => findClip(doc.value, id) !== null)
  }

  /** Clip zur Auswahl hinzufügen bzw. daraus entfernen (Strg/Shift-Klick). */
  function toggleSelected(id: string): void {
    select(
      selection.value.includes(id)
        ? selection.value.filter((s) => s !== id)
        : [...selection.value, id],
    )
  }

  /** Abspielkopf setzen: nie negativ, auf das Bildraster des Projekts gelegt. */
  function seek(time: Time): void {
    const t = Number.isFinite(time) ? Math.max(0, Math.round(time)) : 0
    playhead.value = snapToFrame(t, doc.value.settings.fps)
  }

  function setZoom(pxPerSecond: number): void {
    if (!Number.isFinite(pxPerSecond)) return
    zoom.value = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, pxPerSecond))
  }

  /**
   * Zeit einrasten lassen (Clip-Ränder, Marker, Abspielkopf), wenn das
   * Einrasten an ist. `tolerancePx` wird über den Zoom in Zeit umgerechnet.
   */
  function snap(
    time: Time,
    opts: { exclude?: readonly string[]; tolerancePx?: number } = {},
  ): Time {
    if (!snapping.value || !isTime(time)) return time
    const tolerance = Math.round(((opts.tolerancePx ?? 8) / zoom.value) * 1_000_000)
    const points = snapPoints(doc.value, { exclude: opts.exclude, playhead: playhead.value })
    return snapTime(time, points, tolerance).time
  }

  return {
    doc,
    playhead,
    selection,
    zoom,
    snapping,
    lastError,
    duration,
    canUndo,
    canRedo,
    selectedClips,
    apply,
    beginGesture,
    endGesture,
    cancelGesture,
    undo,
    redo,
    load,
    reset,
    putAsset,
    removeAsset,
    addTrack,
    removeTrack,
    updateTrack,
    insertClip,
    moveClip,
    trimClip,
    splitClip,
    removeClip,
    appendMedia,
    splitSelectionAtPlayhead,
    removeSelection,
    select,
    toggleSelected,
    seek,
    setZoom,
    snap,
  }
})
