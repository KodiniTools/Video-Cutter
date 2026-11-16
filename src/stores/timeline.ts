import { defineStore } from 'pinia'
import { computed, ref, shallowRef } from 'vue'
import {
  addTrack as addTrackOp,
  appendMedia as appendMediaOp,
  assetInUse,
  createDoc,
  docDuration,
  findClip,
  createId,
  insertClip as insertClipOp,
  insertOverlayClip,
  insertOverlayClips,
  isTime,
  linkClips as linkClipsOp,
  linkGroupIds,
  moveClip as moveClipOp,
  moveTrack as moveTrackOp,
  nextTrackName,
  putAsset as putAssetOp,
  removeAsset as removeAssetOp,
  removeClip as removeClipOp,
  removeTrack as removeTrackOp,
  setClipCrop as setClipCropOp,
  setClipFade as setClipFadeOp,
  setClipTransition as setClipTransitionOp,
  setClipGain as setClipGainOp,
  setClipSpeed as setClipSpeedOp,
  snapPoints,
  snapTime,
  snapToFrame,
  splitClip as splitClipOp,
  trimClip as trimClipOp,
  trimRange,
  unlinkClips as unlinkClipsOp,
  updateClipData as updateClipDataOp,
  updateSettings as updateSettingsOp,
  updateTrack as updateTrackOp,
  validateDoc,
  type AssetRef,
  type Clip,
  type ClipCrop,
  type ClipTransitionPreset,
  type DocIssue,
  type FadeCurve,
  type MoveTarget,
  type NewTrack,
  type OpError,
  type OpResult,
  type OverlayClip,
  type SettingsPatch,
  type Time,
  type TimelineDoc,
  type TrackKind,
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
  /** Läuft die Vorschau? Der Vorschau-Player folgt diesem Wert. */
  const playing = ref(false)
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
    playing.value = false
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
  const moveTrack = (trackId: string, index: number) => apply((d) => moveTrackOp(d, trackId, index))

  /** Leere Spur anlegen: Bild-Spuren oben (Vordergrund), Ton-Spuren unten. */
  function newTrack(kind: TrackKind): boolean {
    const prefix = kind === 'video' ? 'V' : kind === 'audio' ? 'A' : 'E'
    return apply((d) =>
      addTrackOp(
        d,
        { kind, name: nextTrackName(d, prefix) },
        kind === 'audio' ? d.tracks.length : 0,
      ),
    )
  }

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
   * Text am Abspielkopf anlegen (auf einer Ebenen-Spur, bei Bedarf entsteht
   * eine) und markieren. Liefert die ID des neuen Clips oder `null`.
   */
  function addText(data: Record<string, unknown>, duration: Time): string | null {
    return addOverlay('text', data, duration, 'T')
  }

  /** Form, Symbol oder Emoji am Abspielkopf anlegen und markieren (wie `addText`). */
  function addGraphic(data: Record<string, unknown>, duration: Time): string | null {
    return addOverlay('graphic', data, duration, 'G')
  }

  function addOverlay(
    kind: 'text' | 'graphic',
    data: Record<string, unknown>,
    duration: Time,
    prefix: string,
  ): string | null {
    const id = createId()
    const done = apply((d) =>
      insertOverlayClip(
        d,
        { id, kind, start: playhead.value, duration, data },
        nextTrackName(d, prefix),
      ),
    )
    if (!done) return null
    select([id])
    return id
  }

  /**
   * Mehrere Clips (z. B. Untertitel) gemeinsam auf eine Ebenen-Spur legen:
   * ein Verlaufsschritt.
   */
  const addOverlayClips = (clips: readonly OverlayClip[], prefix = 'T') =>
    apply((d) => insertOverlayClips(d, clips, nextTrackName(d, prefix)))

  /**
   * Darstellungsdaten mehrerer Clips in einem Verlaufsschritt ändern (z. B.
   * übersetzte Texte). Clips, die es nicht mehr gibt, werden übergangen.
   */
  const updateClipsData = (patches: readonly { id: string; patch: Record<string, unknown> }[]) =>
    apply((d) => {
      let next = d
      for (const { id, patch } of patches) {
        const r = updateClipDataOp(next, id, patch)
        if (r.ok) next = r.doc
        else if (r.error !== 'clip-not-found') return r
      }
      return { ok: true, doc: next }
    })

  /** Darstellungsdaten eines Clips auf einer Ebenen-Spur ändern (z. B. Text). */
  const updateClipData = (clipId: string, patch: Record<string, unknown>) =>
    apply((d) => updateClipDataOp(d, clipId, patch))

  /** Tempo eines Video-/Ton-Clips (samt verknüpftem Clip); `ripple` rückt Späteres mit. */
  const setClipSpeed = (clipId: string, speed: number, opts?: { ripple?: boolean }) =>
    apply((d) => setClipSpeedOp(d, clipId, speed, opts))

  /** Zuschnitt eines Video-Clips (`null` = ganzes Bild). */
  const setClipCrop = (clipId: string, crop: ClipCrop | null) =>
    apply((d) => setClipCropOp(d, clipId, crop))

  /** Übergang am Anfang eines Video-Clips; `null` hebt ihn auf. */
  const setClipTransition = (
    clipId: string,
    transition: { preset: ClipTransitionPreset; duration?: Time } | null,
  ) => apply((d) => setClipTransitionOp(d, clipId, transition))

  /** Ton eines Clips ein- (`in`) bzw. ausblenden (`out`); Dauer 0 oder `null` = aus. */
  const setClipFade = (
    clipId: string,
    side: 'in' | 'out',
    fade: { duration: Time; curve?: FadeCurve } | null,
  ) => apply((d) => setClipFadeOp(d, clipId, side, fade))

  /** Lautstärke eines Ton-Clips. */
  const setClipGain = (clipId: string, gain: number) => apply((d) => setClipGainOp(d, clipId, gain))

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

  // --- Ziehen mit der Maus ---------------------------------------------------

  /** Einrast-Toleranz in Zeit (aus Pixeln über den Zoom). */
  function snapTolerance(tolerancePx = 8): Time {
    return Math.round((tolerancePx / zoom.value) * 1_000_000)
  }

  /**
   * Clip beim Ziehen auf `start` legen (optional auf eine andere Spur).
   * Anfang oder Ende rasten an Clip-Rändern, Markern und dem Abspielkopf ein,
   * sonst gilt das Bildraster. Verknüpfte Clips wandern mit. Ist die Stelle
   * belegt, bleibt der Clip, wo er zuletzt lag (`false`).
   */
  function dragClipTo(clipId: string, start: Time, trackId?: string): boolean {
    const loc = findClip(doc.value, clipId)
    if (!loc || !Number.isFinite(start)) return false
    const members = linkGroupIds(doc.value, clipId)
    // Kein Mitglied der Gruppe darf vor 0 rutschen.
    let earliest = loc.clip.start
    for (const id of members) earliest = Math.min(earliest, findClip(doc.value, id)!.clip.start)
    const floor = loc.clip.start - earliest
    let target = Math.max(floor, Math.round(start))
    let snapped = false
    if (snapping.value) {
      const points = snapPoints(doc.value, { exclude: members, playhead: playhead.value })
      const tolerance = snapTolerance()
      const head = snapTime(target, points, tolerance)
      const tail = snapTime(target + loc.clip.duration, points, tolerance)
      const tailStart = tail.time - loc.clip.duration
      const useTail =
        tail.snapped &&
        tailStart >= floor &&
        (!head.snapped || Math.abs(tailStart - target) < Math.abs(head.time - target))
      if (useTail) {
        target = tailStart
        snapped = true
      } else if (head.snapped && head.time >= floor) {
        target = head.time
        snapped = true
      }
    }
    if (!snapped) target = Math.max(floor, snapToFrame(target, doc.value.settings.fps))
    if (trackId !== undefined && trackId !== loc.track.id) {
      const moved = moveClipOp(doc.value, clipId, { start: target, trackId })
      if (moved.ok) return apply(() => moved)
    }
    return apply((d) => moveClipOp(d, clipId, { start: target }))
  }

  /**
   * Rand eines Clips beim Ziehen auf `time` legen: eingerastet wie beim
   * Verschieben und auf das Mögliche begrenzt (Nachbarn, Quelle, Mindestlänge).
   */
  function dragTrimTo(clipId: string, edge: 'start' | 'end', time: Time): boolean {
    const range = trimRange(doc.value, clipId, edge)
    if (!range || !Number.isFinite(time)) return false
    let target = Math.round(time)
    let snapped = false
    if (snapping.value) {
      const points = snapPoints(doc.value, { exclude: [clipId], playhead: playhead.value })
      const hit = snapTime(target, points, snapTolerance())
      if (hit.snapped && hit.time >= range.min && hit.time <= range.max) {
        target = hit.time
        snapped = true
      }
    }
    if (!snapped) target = snapToFrame(Math.max(0, target), doc.value.settings.fps)
    target = Math.min(range.max, Math.max(range.min, target))
    return apply((d) => trimClipOp(d, clipId, edge, target))
  }

  /** Clips, die „Teilen“ am Abspielkopf trifft (siehe `splitAtPlayhead`). */
  const splitTargets = computed(() => {
    const at = playhead.value
    const under = doc.value.tracks.flatMap((t) =>
      t.clips
        .filter((c) => c.start < at && at < c.start + c.duration)
        .map((c) => ({ id: c.id, locked: t.locked })),
    )
    const chosen = under.filter((c) => selection.value.includes(c.id))
    return (chosen.length > 0 ? chosen : under.filter((c) => !c.locked)).map((c) => c.id)
  })

  /**
   * Am Abspielkopf teilen (ein Verlaufsschritt): die markierten Clips unter dem
   * Abspielkopf; liegt keiner davon dort, alle Clips unter dem Abspielkopf auf
   * nicht gesperrten Spuren.
   */
  function splitAtPlayhead(): boolean {
    const at = playhead.value
    const targets = splitTargets.value
    return apply((current) => {
      let next = current
      let split = false
      for (const id of targets) {
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

  /**
   * Clip samt verknüpften Clips markieren (Bild und Ton eines Videos gehören
   * zusammen). `toggle`: zur Auswahl hinzufügen bzw. daraus entfernen.
   */
  function selectClip(id: string, toggle = false): void {
    const group = linkGroupIds(doc.value, id)
    if (!toggle) return select(group)
    const drop = new Set(group)
    select(
      selection.value.includes(id)
        ? selection.value.filter((s) => !drop.has(s))
        : [...selection.value, ...group],
    )
  }

  /** Ist in der Auswahl etwas verknüpft (z. B. Bild und Ton eines Videos)? */
  const canUnlink = computed(() => selectedClips.value.some((c) => !!c.linkGroup))
  /** Mindestens zwei markierte Clips, die noch nicht alle zusammengehören. */
  const canLink = computed(() => {
    const clips = selectedClips.value
    if (clips.length < 2) return false
    const group = clips[0].linkGroup
    return !group || clips.some((c) => c.linkGroup !== group)
  })

  /**
   * Verknüpfung der markierten Clips lösen: Bild und Ton lassen sich danach
   * einzeln markieren, verschieben, kürzen und löschen. Die Auswahl wird
   * aufgehoben.
   */
  function unlinkSelection(): boolean {
    if (!apply((d) => unlinkClipsOp(d, selection.value))) return false
    // Auswahl aufheben: Sonst träfe „Löschen“ weiter Bild und Ton zusammen.
    select([])
    return true
  }
  /** Markierte Clips (wieder) verknüpfen: Sie wandern künftig gemeinsam. */
  const linkSelection = () => apply((d) => linkClipsOp(d, selection.value))

  function selectAll(): void {
    select(doc.value.tracks.flatMap((t) => t.clips.map((c) => c.id)))
  }

  /** Abspielkopf setzen: nie negativ, auf das Bildraster des Projekts gelegt. */
  function seek(time: Time): void {
    const t = Number.isFinite(time) ? Math.max(0, Math.round(time)) : 0
    playhead.value = snapToFrame(t, doc.value.settings.fps)
  }

  /** Projektformat ändern (rückgängig machbar); der Abspielkopf bleibt auf dem Bildraster. */
  function updateSettings(patch: SettingsPatch): boolean {
    const done = apply((d) => updateSettingsOp(d, patch))
    if (done) seek(playhead.value)
    return done
  }

  /** Vorschau starten bzw. anhalten (ohne Clips gibt es nichts abzuspielen). */
  function togglePlay(): void {
    playing.value = !playing.value && duration.value > 0
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
    playing,
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
    moveTrack,
    newTrack,
    insertClip,
    moveClip,
    trimClip,
    splitClip,
    removeClip,
    appendMedia,
    splitTargets,
    splitAtPlayhead,
    dragClipTo,
    dragTrimTo,
    removeSelection,
    select,
    toggleSelected,
    selectClip,
    selectAll,
    seek,
    togglePlay,
    addText,
    addGraphic,
    canUnlink,
    canLink,
    unlinkSelection,
    linkSelection,
    updateClipData,
    updateClipsData,
    addOverlayClips,
    setClipSpeed,
    setClipGain,
    setClipFade,
    setClipCrop,
    setClipTransition,
    updateSettings,
    setZoom,
    snap,
  }
})
