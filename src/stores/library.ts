import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { clamp } from '@/lib/ffmpegCommand'
import {
  uploadMedia,
  deleteMedia,
  fetchMediaInfo,
  UPLOAD_ABORTED,
  type MediaUpload,
  type MediaView,
} from '@/lib/mediaApi'

/**
 * Video-Bibliothek („Meine Videos"): mehrere Videos werden einmal auf den
 * Server geladen und per ID referenziert. Das markierte Video wird im
 * Haupt-Editor geschnitten; „Zusammenfügen" verbindet die markierten Videos
 * der Liste in Listenreihenfolge.
 */

export type LibraryStatus = 'uploading' | 'ready' | 'error'

export interface LibraryItem {
  /** Lokale, stabile ID (Liste, Reihenfolge, Nahtstellen). */
  id: number
  /** ID auf dem Server; `null`, solange der Upload läuft oder fehlgeschlagen ist. */
  mediaId: string | null
  /** Lokale Datei (Vorschau, Download). */
  file: File
  name: string
  size: number
  /** Gesamtdauer in Sekunden; 0 = (noch) unbekannt. */
  duration: number
  width: number
  height: number
  hasAudio: boolean
  /** Bildrate (Bilder/s) laut Server, 0 = unbekannt. */
  fps: number
  /** Verwendeter Bereich beim Zusammenfügen: Start (s) … Ende (s); `null` = bis zum Ende. */
  start: number
  end: number | null
  /** Beim Zusammenfügen verwenden? */
  include: boolean
  status: LibraryStatus
  /** Upload-Fortschritt 0–1. */
  progress: number
  /** Fehlermeldung bei status 'error'. */
  error: string
}

/** Übergang an einer Nahtstelle (wie die globale Animation). */
export type SeamPreset = 'none' | 'fade' | 'slide' | 'scale' | 'flip'

/** Höchstzahl beim Zusammenfügen: 1 Hauptvideo + 5 angehängte (MAX_APPEND_FILES im Backend). */
export const MAX_MERGE_ITEMS = 6

/** Mindestlänge eines verwendeten Bereichs in Sekunden. */
const MIN_LENGTH = 0.05

/** Schlüssel einer Nahtstelle aus ihren beiden Nachbarn. */
export function seamKey(left: Pick<LibraryItem, 'id'>, right: Pick<LibraryItem, 'id'>): string {
  return `${left.id}>${right.id}`
}

/** Verwendete Länge (0, solange die Dauer unbekannt ist). */
export function itemLength(it: Pick<LibraryItem, 'start' | 'end' | 'duration'>): number {
  const end = it.end ?? it.duration
  return end > 0 ? Math.max(0, end - it.start) : 0
}

/** Ist der verwendete Bereich gekürzt? */
export function isItemTrimmed(it: Pick<LibraryItem, 'start' | 'end'>): boolean {
  return it.start > 0 || it.end !== null
}

/** Begrenzt Start/Ende auf die (bekannte) Dauer mit Mindestlänge. */
function clampRange(it: LibraryItem): LibraryItem {
  const dur = it.duration
  let start = Math.max(0, Number.isFinite(it.start) ? it.start : 0)
  let end = it.end
  if (dur > 0) {
    start = Math.min(start, Math.max(0, dur - MIN_LENGTH))
    if (end !== null) end = clamp(end, Math.min(start + MIN_LENGTH, dur), dur)
    // Ende = Dateiende -> wieder „bis zum Ende" (ungekürzt).
    if (end !== null && dur - end < 1e-3) end = null
  } else if (end !== null) {
    end = Math.max(end, start + MIN_LENGTH)
  }
  return { ...it, start, end }
}

/**
 * Eine Fassung eines Videos (Datei + Server-Video). Schneiden/Einbrennen
 * erzeugen eine neue Fassung; der Verlauf kann zur vorherigen zurückkehren.
 */
export interface ItemVersion {
  file: File
  mediaId: string | null
  name: string
  size: number
  duration: number
  width: number
  height: number
  hasAudio: boolean
  fps: number
}

/** Zusammenfügen-Einstellungen (Reihenfolge, Von/Bis, Auswahl, Übergänge). */
export interface MergeState {
  order: number[]
  ranges: Record<number, { start: number; end: number | null; include: boolean }>
  seams: Record<string, SeamPreset>
  normalizeAudio: boolean
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export const useLibraryStore = defineStore('library', () => {
  const items = ref<LibraryItem[]>([])
  const selectedId = ref<number | null>(null)
  /** Lautstärke aller Clips beim Zusammenfügen angleichen. */
  const normalizeAudio = ref(false)
  /** Übergang je Nahtstelle (Schlüssel: seamKey). Fehlt = globaler Übergang. */
  const seamTransitions = ref<Record<string, SeamPreset>>({})

  let nextId = 1
  /** Laufende Uploads (für Abbruch beim Löschen). */
  const uploads = new Map<number, MediaUpload>()
  /** Uploads laufen nacheinander (volle Bandbreite je Datei, klarer Fortschritt). */
  let queue: Promise<void> = Promise.resolve()

  const selected = computed(() => items.value.find((it) => it.id === selectedId.value) ?? null)
  /** Videos, die beim Zusammenfügen verwendet werden (in Listenreihenfolge). */
  const mergeItems = computed(() => items.value.filter((it) => it.include))
  const isUploading = computed(() => items.value.some((it) => it.status === 'uploading'))
  /** Zusammenfügen möglich: 2 bis MAX_MERGE_ITEMS markierte, fertig hochgeladene Videos. */
  const canMerge = computed(
    () =>
      mergeItems.value.length >= 2 &&
      mergeItems.value.length <= MAX_MERGE_ITEMS &&
      mergeItems.value.every((it) => it.status === 'ready' && it.mediaId !== null),
  )
  /** Übergang je Nahtstelle der zusammenzufügenden Videos (`null` = global). */
  const seamPresets = computed<(SeamPreset | null)[]>(() =>
    mergeItems.value
      .slice(1)
      .map((it, i) => seamTransitions.value[seamKey(mergeItems.value[i], it)] ?? null),
  )

  function find(id: number): LibraryItem | undefined {
    return items.value.find((it) => it.id === id)
  }

  function update(id: number, fn: (it: LibraryItem) => LibraryItem): void {
    items.value = items.value.map((it) => (it.id === id ? fn(it) : it))
  }

  function applyMedia(it: LibraryItem, m: MediaView): LibraryItem {
    return clampRange({
      ...it,
      mediaId: m.id,
      size: m.size || it.size,
      duration: m.duration || it.duration,
      width: m.width,
      height: m.height,
      hasAudio: m.hasAudio,
      fps: m.fps,
      status: 'ready',
      progress: 1,
      error: '',
    })
  }

  async function runUpload(id: number): Promise<void> {
    const item = find(id)
    if (!item || item.status !== 'uploading') return // inzwischen gelöscht
    const up = uploadMedia(item.file, (ratio) => update(id, (it) => ({ ...it, progress: ratio })))
    uploads.set(id, up)
    try {
      const media = await up.promise
      if (!find(id)) {
        // Während des Uploads gelöscht -> auch auf dem Server entfernen.
        await deleteMedia(media.id).catch(() => {})
        return
      }
      update(id, (it) => applyMedia(it, media))
    } catch (e) {
      const msg = messageOf(e)
      if (msg === UPLOAD_ABORTED) return
      update(id, (it) => ({ ...it, status: 'error', error: msg }))
    } finally {
      uploads.delete(id)
    }
  }

  function newItem(file: File, over: Partial<LibraryItem> = {}): LibraryItem {
    return {
      id: nextId++,
      mediaId: null,
      file,
      name: file.name,
      size: file.size,
      duration: 0,
      width: 0,
      height: 0,
      hasAudio: false,
      fps: 0,
      start: 0,
      end: null,
      include: true,
      status: 'uploading',
      progress: 0,
      error: '',
      ...over,
    }
  }

  /**
   * Nimmt Videos auf und lädt sie (nacheinander) auf den Server. Ist noch
   * nichts markiert, wird das erste neue Video markiert.
   */
  function addFiles(files: File[]): LibraryItem[] {
    const added = files.map((f) => newItem(f))
    if (!added.length) return added
    items.value = [...items.value, ...added]
    if (selected.value === null) selectedId.value = added[0].id
    for (const it of added) queue = queue.then(() => runUpload(it.id))
    return added
  }

  /** Lädt ein fehlgeschlagenes Video erneut hoch. */
  function retry(id: number): void {
    const it = find(id)
    if (!it || it.status !== 'error') return
    update(id, (x) => ({ ...x, status: 'uploading', progress: 0, error: '' }))
    queue = queue.then(() => runUpload(id))
  }

  function select(id: number): void {
    if (find(id)) selectedId.value = id
  }

  /**
   * Entfernt ein Video aus der Liste und löscht es sofort vom Server (ein
   * laufender Upload wird abgebrochen). Die Markierung wandert zum Nachbarn.
   * Wirft, wenn das Löschen auf dem Server fehlschlägt (das Video verschwindet
   * dann spätestens mit dem Auto-Aufräumen).
   */
  async function remove(id: number): Promise<void> {
    const idx = items.value.findIndex((it) => it.id === id)
    if (idx < 0) return
    const item = items.value[idx]
    uploads.get(id)?.abort()
    items.value = items.value.filter((it) => it.id !== id)
    if (selectedId.value === id) {
      const next = items.value[idx] ?? items.value[idx - 1] ?? null
      selectedId.value = next ? next.id : null
    }
    if (item.mediaId) await deleteMedia(item.mediaId)
  }

  /**
   * Ersetzt ein Video durch sein Schnitt-Ergebnis (neues Server-Video). Das
   * bisherige Video wird vom Server gelöscht (Fehler dabei sind unkritisch –
   * das Auto-Aufräumen entfernt es später).
   */
  function replaceWithResult(
    id: number,
    media: MediaView,
    file: File,
    opts: { keepOld?: boolean } = {},
  ): void {
    const old = find(id)
    if (!old) return
    update(id, (it) =>
      applyMedia({ ...it, file, name: file.name, size: file.size, start: 0, end: null }, media),
    )
    // keepOld: Der Rückgängig-Verlauf behält die alte Fassung und gibt sie frei.
    if (!opts.keepOld && old.mediaId && old.mediaId !== media.id) {
      void deleteMedia(old.mediaId).catch(() => {})
    }
  }

  /** Aktuelle Fassung eines Videos (`null`, falls es nicht mehr existiert). */
  function versionOf(id: number): ItemVersion | null {
    const it = find(id)
    if (!it) return null
    const { file, mediaId, name, size, duration, width, height, hasAudio, fps } = it
    return { file, mediaId, name, size, duration, width, height, hasAudio, fps }
  }

  /**
   * Stellt eine frühere Fassung wieder her (Rückgängig von Schneiden/
   * Einbrennen). Fehlt sie inzwischen auf dem Server (Auto-Aufräumen), wird
   * die lokale Datei neu hochgeladen.
   */
  function restoreVersion(id: number, v: ItemVersion): void {
    if (!find(id)) return
    update(id, (it) =>
      clampRange({
        ...it,
        ...v,
        start: 0,
        end: null,
        status: v.mediaId ? 'ready' : 'uploading',
        progress: v.mediaId ? 1 : 0,
        error: '',
      }),
    )
    if (!v.mediaId) {
      queue = queue.then(() => runUpload(id))
      return
    }
    const mediaId = v.mediaId
    void fetchMediaInfo(mediaId).catch(() => {
      const cur = find(id)
      // Inzwischen weiter bearbeitet/gewechselt -> nichts tun.
      if (!cur || cur.mediaId !== mediaId || cur.file !== v.file) return
      update(id, (it) => ({ ...it, mediaId: null, status: 'uploading', progress: 0 }))
      queue = queue.then(() => runUpload(id))
    })
  }

  /** Zusammenfügen-Einstellungen als unabhängige Kopie. */
  function mergeState(): MergeState {
    const ranges: MergeState['ranges'] = {}
    for (const it of items.value) {
      ranges[it.id] = { start: it.start, end: it.end, include: it.include }
    }
    return {
      order: items.value.map((it) => it.id),
      ranges,
      seams: { ...seamTransitions.value },
      normalizeAudio: normalizeAudio.value,
    }
  }

  /** Stellt Zusammenfügen-Einstellungen wieder her (nur für noch vorhandene Videos). */
  function applyMergeState(s: MergeState): void {
    const rank = new Map(s.order.map((id, i) => [id, i]))
    const known = items.value.filter((it) => rank.has(it.id))
    const unknown = items.value.filter((it) => !rank.has(it.id))
    known.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0))
    items.value = [...known, ...unknown].map((it) => {
      const r = s.ranges[it.id]
      return r ? clampRange({ ...it, start: r.start, end: r.end, include: r.include }) : it
    })
    seamTransitions.value = { ...s.seams }
    normalizeAudio.value = s.normalizeAudio
  }

  /**
   * Fügt ein Ergebnis (z. B. vom Zusammenfügen) als neues Video hinzu und
   * markiert es. Es ist zunächst NICHT fürs Zusammenfügen vorgemerkt, damit
   * ein erneutes Zusammenfügen die Quellen nicht doppelt enthält.
   */
  function addResult(media: MediaView, file: File): LibraryItem {
    const item = applyMedia(newItem(file, { include: false }), media)
    items.value = [...items.value, item]
    selectedId.value = item.id
    return item
  }

  /**
   * Lädt ein Video erneut hoch (z. B. weil es auf dem Server aufgeräumt wurde).
   * Löst auf, sobald es wieder bereit ist; wirft bei Fehler/Löschen.
   */
  function reupload(id: number): Promise<void> {
    const it = find(id)
    if (!it) return Promise.reject(new Error('Video nicht mehr vorhanden.'))
    uploads.get(id)?.abort()
    update(id, (x) => ({ ...x, mediaId: null, status: 'uploading', progress: 0, error: '' }))
    const run = queue.then(() => runUpload(id))
    queue = run
    return run.then(() => {
      const cur = find(id)
      if (!cur || cur.status !== 'ready' || !cur.mediaId) {
        throw new Error(cur?.error || 'Upload fehlgeschlagen.')
      }
    })
  }

  /**
   * Ersetzt die ganze Liste (Projekt öffnen). Laufende Uploads werden
   * abgebrochen, bisherige Videos vom Server gelöscht – außer sie gehören auch
   * zur neuen Liste. Liefert die neuen Einträge in derselben Reihenfolge.
   */
  function replaceAll(
    entries: {
      file: File
      media: MediaView
      name: string
      start: number
      end: number | null
      include: boolean
    }[],
    opts: {
      selected: number | null
      seams: { from: number; to: number; preset: SeamPreset }[]
      normalizeAudio: boolean
    },
  ): LibraryItem[] {
    for (const up of uploads.values()) up.abort()
    const old = items.value
    const next = entries.map((e) =>
      applyMedia(
        newItem(e.file, { name: e.name, start: e.start, end: e.end, include: e.include }),
        e.media,
      ),
    )
    items.value = next
    selectedId.value = next[opts.selected ?? 0]?.id ?? next[0]?.id ?? null
    const seams: Record<string, SeamPreset> = {}
    for (const s of opts.seams) {
      const a = next[s.from]
      const b = next[s.to]
      if (a && b) seams[seamKey(a, b)] = s.preset
    }
    seamTransitions.value = seams
    normalizeAudio.value = opts.normalizeAudio
    const keep = new Set(next.map((it) => it.mediaId))
    for (const it of old) {
      if (it.mediaId && !keep.has(it.mediaId)) void deleteMedia(it.mediaId).catch(() => {})
    }
    return next
  }

  /** Lokal ermittelte Dauer (nur falls der Server sie noch nicht geliefert hat). */
  function setDuration(id: number, d: number): void {
    if (!(Number.isFinite(d) && d > 0)) return
    update(id, (it) => (it.duration > 0 ? it : clampRange({ ...it, duration: d })))
  }

  /** Setzt den Start des verwendeten Bereichs; ein zu frühes Ende fällt weg. */
  function setStart(id: number, t: number): void {
    update(id, (it) => {
      const start = Number.isFinite(t) ? Math.max(0, t) : 0
      const end = it.end !== null && it.end < start + MIN_LENGTH ? null : it.end
      return clampRange({ ...it, start, end })
    })
  }

  /** Setzt das Ende des verwendeten Bereichs; `null` = bis zum Dateiende. */
  function setEnd(id: number, t: number | null): void {
    update(id, (it) => clampRange({ ...it, end: t === null || !Number.isFinite(t) ? null : t }))
  }

  /** Kürzung aufheben (ganzes Video verwenden). */
  function resetRange(id: number): void {
    update(id, (it) => ({ ...it, start: 0, end: null }))
  }

  function setInclude(id: number, on: boolean): void {
    update(id, (it) => ({ ...it, include: on }))
  }

  /** Verschiebt ein Video an Stelle `toIndex` (Index in der Liste OHNE das Video). */
  function move(id: number, toIndex: number): void {
    const from = items.value.findIndex((it) => it.id === id)
    if (from < 0 || !Number.isFinite(toIndex)) return
    const next = [...items.value]
    const [moved] = next.splice(from, 1)
    const to = Math.min(Math.max(0, Math.trunc(toIndex)), next.length)
    next.splice(to, 0, moved)
    items.value = next
  }

  /** Verschiebt ein Video um einen Platz (▲▼). */
  function moveBy(id: number, delta: number): void {
    if (delta === 0) return
    const from = items.value.findIndex((it) => it.id === id)
    const to = from + (delta < 0 ? -1 : 1)
    if (from < 0 || to < 0 || to >= items.value.length) return
    move(id, to)
  }

  function setNormalizeAudio(on: boolean): void {
    normalizeAudio.value = on
  }

  /** Übergang einer Nahtstelle setzen; `null` = wieder globaler Übergang. */
  function setSeamTransition(key: string, preset: SeamPreset | null): void {
    const next = { ...seamTransitions.value }
    if (preset === null) delete next[key]
    else next[key] = preset
    seamTransitions.value = next
  }

  return {
    // state
    items,
    selectedId,
    normalizeAudio,
    seamTransitions,
    // getters
    selected,
    mergeItems,
    isUploading,
    canMerge,
    seamPresets,
    // actions
    addFiles,
    retry,
    select,
    remove,
    replaceWithResult,
    versionOf,
    restoreVersion,
    mergeState,
    applyMergeState,
    addResult,
    reupload,
    replaceAll,
    setDuration,
    setStart,
    setEnd,
    resetRange,
    setInclude,
    move,
    moveBy,
    setNormalizeAudio,
    setSeamTransition,
  }
})
