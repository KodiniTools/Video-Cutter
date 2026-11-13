import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { useVideoEditorStore, type EditorSnapshot, type MusicSettings } from '@/stores/videoEditor'
import { useTextOverlayStore } from '@/stores/textOverlays'
import { useGraphicOverlayStore } from '@/stores/graphicOverlays'
import { useLibraryStore, type ItemVersion, type MergeState } from '@/stores/library'
import { useAudioFadeStore } from '@/stores/audioFade'
import { useAnimationPref, type AnimationId } from '@/composables/useAnimationPref'
import { deleteMedia } from '@/lib/mediaApi'
import type { TextOverlay } from '@/lib/textOverlay'
import type { GraphicOverlay } from '@/lib/graphicOverlay'

/**
 * Rückgängig/Wiederholen für alle Bearbeitungen im Editor.
 *
 * Der Verlauf gehört zum markierten Video (je Video ein eigener Verlauf).
 * Er ist in „Bereiche" aufgeteilt (Auswahl, Texte, Grafiken, Ton-Blende …).
 * Ein Schritt speichert nur die Bereiche, die sich geändert haben – Rückgängig
 * stellt genau diese wieder her und lässt alles andere unberührt.
 *
 * Änderungsserien (Ziehen, Spinner gedrückt halten, mehrfaches Tippen) werden
 * zu einem Schritt zusammengefasst: per Verzögerung und, solange eine Maus-/
 * Fingergeste läuft, bis zu deren Ende.
 *
 * Schneiden und Einbrennen ersetzen die Datei. Die vorherige Fassung bleibt
 * (lokal und auf dem Server) erhalten, solange ein Schritt sie braucht – so
 * lässt sich auch das rückgängig machen. Zusammenfügen erzeugt dagegen ein
 * neues Video (rückgängig = löschen) und ist kein Verlaufsschritt.
 */

/** Verzögerung, bis eine Änderungsserie als ein Schritt gilt. */
export const HISTORY_DEBOUNCE_MS = 400
/** Höchstzahl Schritte je Video. */
export const MAX_HISTORY_STEPS = 100
/** Höchstzahl rückgängig machbarer Schnitte/Einbrennvorgänge je Video (Speicher). */
export const MAX_VERSION_STEPS = 5

interface OutputState {
  aspect: string
  fill: string
}
interface AnimState {
  animation: AnimationId
  duration: number
}

/** Alle Bereiche des Verlaufs mit ihrem Zustandstyp. */
interface SliceStates {
  version: ItemVersion | null
  /** `null` = Auswahl, die nach dem Laden einer neuen Fassung entsteht. */
  editor: EditorSnapshot | null
  texts: TextOverlay[]
  graphics: GraphicOverlay[]
  output: OutputState
  music: MusicSettings | null
  audioFade: string
  anim: AnimState
  merge: MergeState
}
type SliceKey = keyof SliceStates
type State = { [K in SliceKey]: SliceStates[K] }
type Change<K extends SliceKey> = { before: SliceStates[K]; after: SliceStates[K] }
type Changes = { [K in SliceKey]?: Change<K> }

export interface HistoryEntry {
  changes: Changes
}

interface ItemHistory {
  undo: HistoryEntry[]
  redo: HistoryEntry[]
}

const SLICE_KEYS: SliceKey[] = [
  'version',
  'editor',
  'texts',
  'graphics',
  'output',
  'music',
  'audioFade',
  'anim',
  'merge',
]

const json = (v: unknown): string => JSON.stringify(v)

/**
 * Gleiche Fassung = gleiche Datei. Eine neue Server-ID derselben Datei
 * (Upload fertig, Neu-Upload) ist keine Bearbeitung.
 */
function sameVersion(a: ItemVersion | null, b: ItemVersion | null): boolean {
  if (a === null || b === null) return a === b
  return a.file === b.file
}

function sameMusic(a: MusicSettings | null, b: MusicSettings | null): boolean {
  if (a === null || b === null) return a === b
  return (
    a.file === b.file &&
    a.volume === b.volume &&
    a.originalVolume === b.originalVolume &&
    a.fade === b.fade &&
    a.loop === b.loop
  )
}

function sameIds(a: MergeState, b: MergeState): boolean {
  if (a.order.length !== b.order.length) return false
  const set = new Set(a.order)
  return b.order.every((id) => set.has(id))
}

export const useHistoryStore = defineStore('history', () => {
  const editor = useVideoEditorStore()
  const texts = useTextOverlayStore()
  const graphics = useGraphicOverlayStore()
  const library = useLibraryStore()
  const audioFade = useAudioFadeStore()
  const anim = useAnimationPref()

  /** Video, dessen Verlauf gerade gilt (= markiertes Video). */
  const itemId = ref<number | null>(null)
  const stacks = ref<Record<number, ItemHistory>>({})

  let baseline: State | null = null
  let applying = false
  let gestures = 0
  let commitTimer: ReturnType<typeof setTimeout> | null = null
  /** Auswahl vor einem Dateiwechsel (Schneiden/Einbrennen), bis der Schritt steht. */
  let editorBeforeLoad: EditorSnapshot | null = null
  /** Auswahl, die nach dem Laden einer wiederhergestellten Fassung gilt. */
  let deferredEditor: { file: File; state: EditorSnapshot } | null = null

  const current = computed<ItemHistory | null>(() =>
    itemId.value === null ? null : (stacks.value[itemId.value] ?? null),
  )
  const canUndo = computed(() => (current.value?.undo.length ?? 0) > 0)
  const canRedo = computed(() => (current.value?.redo.length ?? 0) > 0)

  // --- Bereiche lesen / schreiben / vergleichen ---------------------------

  function read<K extends SliceKey>(key: K, id: number): SliceStates[K] {
    const r: { [P in SliceKey]: () => SliceStates[P] } = {
      version: () => library.versionOf(id),
      editor: () => editor.snapshot(),
      texts: () => texts.listFor(id),
      graphics: () => graphics.listFor(id),
      output: () => ({ aspect: editor.outputAspect, fill: editor.outputFill }),
      music: () => (editor.music ? { ...editor.music } : null),
      audioFade: () => json(audioFade.settings),
      anim: () => ({ animation: anim.animation.value, duration: anim.duration.value }),
      merge: () => library.mergeState(),
    }
    return r[key]()
  }

  function readAll(id: number): State {
    const s = {} as Record<SliceKey, unknown>
    for (const k of SLICE_KEYS) s[k] = read(k, id)
    return s as State
  }

  function same<K extends SliceKey>(key: K, a: SliceStates[K], b: SliceStates[K]): boolean {
    switch (key) {
      case 'version':
        return sameVersion(a as ItemVersion | null, b as ItemVersion | null)
      case 'music':
        return sameMusic(a as MusicSettings | null, b as MusicSettings | null)
      case 'audioFade':
        return a === b
      case 'texts':
      case 'graphics':
        return a === b || json(a) === json(b)
      case 'editor':
      case 'output':
      case 'anim':
      case 'merge':
        return json(a) === json(b)
      default: {
        const never: never = key
        throw new Error(`Unbekannter Verlaufsbereich: ${String(never)}`)
      }
    }
  }

  function write<K extends SliceKey>(key: K, id: number, v: SliceStates[K]): void {
    switch (key) {
      case 'version': {
        const ver = v as ItemVersion | null
        if (ver) library.restoreVersion(id, ver)
        return
      }
      case 'editor':
        if (v) editor.applySnapshot(v as EditorSnapshot)
        return
      case 'texts':
        texts.setListFor(id, v as TextOverlay[])
        return
      case 'graphics':
        graphics.setListFor(id, v as GraphicOverlay[])
        return
      case 'output': {
        const o = v as OutputState
        editor.setOutputAspect(o.aspect as typeof editor.outputAspect)
        editor.setOutputFill(o.fill as typeof editor.outputFill)
        return
      }
      case 'music': {
        const m = v as MusicSettings | null
        editor.music = m ? { ...m } : null
        return
      }
      case 'audioFade':
        audioFade.settings = JSON.parse(v as string)
        return
      case 'anim': {
        const a = v as AnimState
        anim.animation.value = a.animation
        anim.duration.value = a.duration
        return
      }
      case 'merge':
        library.applyMergeState(v as MergeState)
        return
      default: {
        const never: never = key
        throw new Error(`Unbekannter Verlaufsbereich: ${String(never)}`)
      }
    }
  }

  // --- Verlauf festschreiben ----------------------------------------------

  function stackFor(id: number): ItemHistory {
    return stacks.value[id] ?? { undo: [], redo: [] }
  }

  function setStack(id: number, h: ItemHistory): void {
    stacks.value = { ...stacks.value, [id]: h }
  }

  function clearTimer(): void {
    if (commitTimer) {
      clearTimeout(commitTimer)
      commitTimer = null
    }
  }

  function rebase(): void {
    baseline = itemId.value === null ? null : readAll(itemId.value)
  }

  /** Übernimmt die bisherigen Änderungen als einen Schritt (falls es welche gibt). */
  function commit(): void {
    clearTimer()
    const id = itemId.value
    if (id === null || !baseline) return rebase()
    if (!library.versionOf(id)) return rebase() // Video gelöscht
    const cur = readAll(id)
    const changes: Changes = {}
    let any = false
    for (const k of SLICE_KEYS) {
      // Videos hinzugefügt/entfernt: keine eigene Bearbeitung -> still übernehmen.
      if (k === 'merge' && !sameIds(baseline.merge, cur.merge)) continue
      if (same(k, baseline[k], cur[k])) continue
      ;(changes as Record<SliceKey, unknown>)[k] = { before: baseline[k], after: cur[k] }
      any = true
    }
    if (changes.version && editorBeforeLoad) {
      // Neue Fassung: Auswahl davor merken; danach gilt die Auswahl nach dem Laden.
      changes.editor = { before: editorBeforeLoad, after: null }
    }
    editorBeforeLoad = null
    baseline = cur
    if (!any) return
    const h = stackFor(id)
    const dropped = [...h.redo]
    let undo = [...h.undo, { changes }]
    // Begrenzen: Schrittzahl und Zahl der Fassungen (Speicher, Server).
    while (
      undo.length > MAX_HISTORY_STEPS ||
      undo.filter((e) => e.changes.version).length > MAX_VERSION_STEPS
    ) {
      dropped.push(undo[0])
      undo = undo.slice(1)
    }
    setStack(id, { undo, redo: [] })
    release(dropped)
  }

  function schedule(): void {
    if (applying || itemId.value === null) return
    clearTimer()
    if (gestures > 0) return // wird am Ende der Geste festgeschrieben
    commitTimer = setTimeout(commit, HISTORY_DEBOUNCE_MS)
  }

  // --- Rückgängig / Wiederholen -------------------------------------------

  function apply(entry: HistoryEntry, dir: 'before' | 'after'): void {
    const id = itemId.value
    if (id === null) return
    applying = true
    try {
      for (const k of SLICE_KEYS) {
        const ch = entry.changes[k] as Change<typeof k> | undefined
        if (!ch) continue
        if (k === 'editor' && entry.changes.version) continue // nach dem Laden (s. u.)
        write(k, id, ch[dir])
      }
      const ver = entry.changes.version?.[dir]
      if (ver) {
        // Die Datei wechselt: Der Editor lädt neu und setzt die Auswahl zurück.
        // Beim Rückgängig danach die Auswahl von vor dem Schnitt herstellen.
        const ed = entry.changes.editor?.[dir]
        deferredEditor = ed ? { file: ver.file, state: ed } : null
      }
    } finally {
      applying = false
    }
    rebase()
  }

  /** Macht den letzten Schritt rückgängig. Liefert die betroffenen Bereiche. */
  function undo(): SliceKey[] {
    commit() // noch nicht festgeschriebene Änderung zuerst übernehmen
    const id = itemId.value
    if (id === null) return []
    const h = stackFor(id)
    const entry = h.undo[h.undo.length - 1]
    if (!entry) return []
    setStack(id, { undo: h.undo.slice(0, -1), redo: [...h.redo, entry] })
    apply(entry, 'before')
    return Object.keys(entry.changes) as SliceKey[]
  }

  /** Stellt den zuletzt rückgängig gemachten Schritt wieder her. */
  function redo(): SliceKey[] {
    commit()
    const id = itemId.value
    if (id === null) return []
    const h = stackFor(id)
    const entry = h.redo[h.redo.length - 1]
    if (!entry) return []
    setStack(id, { undo: [...h.undo, entry], redo: h.redo.slice(0, -1) })
    apply(entry, 'after')
    return Object.keys(entry.changes) as SliceKey[]
  }

  /** Maus-/Fingergeste beginnt: Änderungen bis zum Ende sammeln. */
  function beginGesture(): void {
    gestures++
    clearTimer()
  }

  /** Geste endet: gesammelte Änderungen als einen Schritt festschreiben. */
  function endGesture(): void {
    if (gestures === 0) return
    gestures--
    if (gestures === 0 && baseline && itemId.value !== null) {
      clearTimer()
      commitTimer = setTimeout(commit, HISTORY_DEBOUNCE_MS)
    }
  }

  // --- Fassungen freigeben ------------------------------------------------

  function referencedMedia(): Set<string> {
    const used = new Set<string>()
    for (const it of library.items) if (it.mediaId) used.add(it.mediaId)
    for (const h of Object.values(stacks.value)) {
      for (const e of [...h.undo, ...h.redo]) {
        const v = e.changes.version
        if (v?.before?.mediaId) used.add(v.before.mediaId)
        if (v?.after?.mediaId) used.add(v.after.mediaId)
      }
    }
    return used
  }

  /** Löscht Server-Fassungen, die nach dem Verwerfen von Schritten niemand mehr braucht. */
  function release(dropped: HistoryEntry[]): void {
    syncRetainedImages()
    if (!dropped.length) return
    const used = referencedMedia()
    for (const e of dropped) {
      const v = e.changes.version
      for (const ver of [v?.before, v?.after]) {
        const mid = ver?.mediaId
        if (mid && !used.has(mid)) {
          used.add(mid) // nur einmal löschen
          void deleteMedia(mid).catch(() => {})
        }
      }
    }
  }

  /** Bilder gelöschter Bild-Grafiken vorhalten, solange ein Schritt sie braucht. */
  function syncRetainedImages(): void {
    const ids: string[] = []
    for (const h of Object.values(stacks.value)) {
      for (const e of [...h.undo, ...h.redo]) {
        const g = e.changes.graphics
        for (const list of [g?.before, g?.after]) {
          for (const o of list ?? []) if (o.kind === 'image') ids.push(o.image)
        }
      }
    }
    graphics.setRetainedImages(ids)
  }

  // --- Beobachter ---------------------------------------------------------

  // Bearbeitungen -> (verzögert) festschreiben. flush 'sync', damit der
  // applying-Schutz beim Wiederherstellen greift.
  watch(
    [
      () => editor.startTime,
      () => editor.endTime,
      () => editor.mode,
      () => editor.operation,
      () => editor.segments,
      () => editor.crop,
      () => editor.outputAspect,
      () => editor.outputFill,
      () => editor.music,
      () => audioFade.settings,
      anim.animation,
      anim.duration,
      () => (itemId.value === null ? null : texts.listFor(itemId.value)),
      () => (itemId.value === null ? null : graphics.listFor(itemId.value)),
      // Nur bearbeitbare Felder (nicht Upload-Fortschritt, der sonst die
      // Verzögerung ständig neu startet).
      () => library.items.map((it) => `${it.id}:${it.start}:${it.end}:${it.include}`).join(),
      () => (itemId.value === null ? null : (library.versionOf(itemId.value)?.file ?? null)),
      () => library.seamTransitions,
      () => library.normalizeAudio,
    ],
    schedule,
    { flush: 'sync' },
  )

  // Neues/geladenes Video im Editor: Auswahl-Werte sind kein Bearbeitungsschritt.
  watch(
    () => editor.loadSeq,
    () => {
      const id = itemId.value
      if (id === null || !baseline) return rebase()
      const ver = library.versionOf(id)
      if (deferredEditor && ver && editor.file === deferredEditor.file && editor.duration > 0) {
        // Wiederhergestellte Fassung geladen -> Auswahl von damals herstellen.
        const state = deferredEditor.state
        deferredEditor = null
        applying = true
        try {
          editor.applySnapshot(state)
        } finally {
          applying = false
        }
      } else if (!applying && !sameVersion(baseline.version, ver) && !editorBeforeLoad) {
        // Schneiden/Einbrennen: Auswahl vor dem Schnitt für Rückgängig merken.
        editorBeforeLoad = baseline.editor ?? editor.snapshot()
      }
      baseline = { ...baseline, editor: editor.snapshot() }
    },
    { flush: 'sync' },
  )

  // Server-ID der aktuellen Fassung geändert (Upload fertig, Neu-Upload): keine
  // Bearbeitung, aber der Ausgangspunkt muss die gültige ID kennen.
  watch(
    () => (itemId.value === null ? null : (library.versionOf(itemId.value)?.mediaId ?? null)),
    () => {
      const id = itemId.value
      if (id === null || !baseline) return
      const ver = library.versionOf(id)
      if (ver && sameVersion(baseline.version, ver)) baseline = { ...baseline, version: ver }
    },
    { flush: 'sync' },
  )

  // Anderes Video markiert: offenen Schritt beim bisherigen Video festschreiben.
  watch(
    () => library.selectedId,
    (id) => {
      if (id === itemId.value) return
      commit()
      itemId.value = id
      editorBeforeLoad = null
      deferredEditor = null
      gestures = 0
      rebase()
    },
    { flush: 'sync', immediate: true },
  )

  // Gelöschte Videos: Verlauf verwerfen und behaltene Fassungen freigeben.
  watch(
    () => library.items.map((it) => it.id),
    (ids) => {
      const alive = new Set(ids)
      const dropped: HistoryEntry[] = []
      const next: Record<number, ItemHistory> = {}
      let changed = false
      for (const [key, h] of Object.entries(stacks.value)) {
        const id = Number(key)
        if (alive.has(id)) next[id] = h
        else {
          dropped.push(...h.undo, ...h.redo)
          changed = true
        }
      }
      if (!changed) return
      stacks.value = next
      release(dropped)
    },
    { flush: 'sync' },
  )

  /** Nur für Tests: offenen Schritt sofort festschreiben. */
  function flush(): void {
    commit()
  }

  return {
    itemId,
    canUndo,
    canRedo,
    undo,
    redo,
    flush,
    beginGesture,
    endGesture,
  }
})
