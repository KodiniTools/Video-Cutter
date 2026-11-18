import { defineStore } from 'pinia'
import { computed, ref, shallowRef, watch } from 'vue'
import { addImageAsset, getImageAsset } from '@/lib/imageAssets'
import {
  deleteProject,
  fetchAsset,
  fetchProject,
  listProjects,
  MissingMediaError,
  openProjectMedia,
  PROJECTS_UNSUPPORTED,
  saveProject,
  sha256Hex,
  uploadAsset,
  type AssetRef,
  type ProjectSummary,
} from '@/lib/projectApi'
import { uploadMedia, type MediaView } from '@/lib/mediaApi'
import { parseProjectState } from '@/lib/projectState'
import { convertClassicProject, type ClassicSkip } from '@/timeline/convertClassic'
import {
  buildTimelineProject,
  isTimelineProject,
  parseTimelineProject,
  rebindProject,
  usedImageIds,
  type ProjectImageRef,
  type TimelineProjectState,
} from '@/timeline/projectFile'
import type { TimelineDoc } from '@/timeline/model'
import { useMediaPoolStore } from './mediaPool'
import { useTimelineStore } from './timeline'

/** Fehler-Kennungen (die Oberfläche übersetzt sie). */
export const TIMELINE_PROJECT_EMPTY = 'TIMELINE_PROJECT_EMPTY'
export const TIMELINE_PROJECT_UPLOADS_PENDING = 'TIMELINE_PROJECT_UPLOADS_PENDING'
/** Videos sind auf dem Server verfallen, bevor das Projekt gespeichert wurde. */
export const TIMELINE_PROJECT_MEDIA_GONE = 'TIMELINE_PROJECT_MEDIA_GONE'
export const TIMELINE_PROJECT_TOO_MANY = 'TIMELINE_PROJECT_TOO_MANY'
export const TIMELINE_PROJECT_INVALID = 'TIMELINE_PROJECT_INVALID'
export const TIMELINE_PROJECT_BUSY = 'TIMELINE_PROJECT_BUSY'

/** Grenzen des Servers je Projekt. */
export const MAX_PROJECT_MEDIA = 50
export const MAX_PROJECT_IMAGES = 200

/** So lange nach der letzten Änderung wird automatisch gespeichert. */
export const AUTOSAVE_DELAY_MS = 3000
const AUTOSAVE_KEY = 'vc-timeline-autosave'

/** Stand des automatischen Speicherns (für die Anzeige). */
export type AutosaveState = 'idle' | 'pending' | 'saving' | 'error'

function readAutosave(): boolean {
  try {
    return localStorage.getItem(AUTOSAVE_KEY) !== 'off'
  } catch {
    return true // localStorage nicht verfügbar -> Standard
  }
}

export interface TimelineOpenResult {
  /** So viele Videos oder Bilder ließen sich nicht wiederherstellen. */
  missing: number
  /** Projekt der bisherigen App: wurde umgewandelt und ist noch nicht gespeichert. */
  converted: boolean
  /** Was die Umwandlung auslassen musste. */
  skipped: ClassicSkip[]
  name: string
}

export interface TimelineProjectProgress {
  key: string
  params?: Record<string, string | number>
}

/**
 * Projekte des Timeline-Editors: das Dokument samt Videos und den Originalen
 * der Bild-Clips auf dem Server speichern, später öffnen oder löschen.
 *
 * Gespeichert wird über dieselben Endpunkte wie in der bisherigen App; der
 * Stand trägt das Kennzeichen `format: 'timeline'`. Der Rückgängig-Verlauf
 * beginnt nach dem Öffnen neu.
 */
export const useTimelineProjectStore = defineStore('timelineProjects', () => {
  const timeline = useTimelineStore()
  const pool = useMediaPoolStore()

  const projects = ref<ProjectSummary[]>([])
  const loaded = ref(false)
  /** Aktuell geöffnetes bzw. zuletzt gespeichertes Projekt. */
  const current = ref<{ id: string; name: string; savedAt: number } | null>(null)
  /** Namensvorschlag für ein umgewandeltes, noch nicht gespeichertes Projekt. */
  const suggestedName = ref('')
  const busy = ref<'save' | 'open' | 'delete' | null>(null)
  const progress = ref<TimelineProjectProgress | null>(null)
  /** Das Dokument, wie es zuletzt gespeichert oder geöffnet wurde. */
  const savedDoc = shallowRef<TimelineDoc | null>(null)
  /** Prüfsummen bereits gelesener Bilddateien. */
  const hashes = new WeakMap<File, string>()

  const hasContent = computed(
    () => timeline.doc.tracks.length > 0 || Object.keys(timeline.doc.assets).length > 0,
  )
  /** Gibt es Änderungen, die noch nicht gespeichert sind? */
  const dirty = computed(() => hasContent.value && timeline.doc !== savedDoc.value)

  /** Geöffnete Projekte nach jeder Änderung von selbst speichern (merkt sich der Browser). */
  const autosave = ref(readAutosave())
  const autosaveState = ref<AutosaveState>('idle')
  /** Fehler des letzten automatischen Speicherns (Kennung oder Meldung des Servers). */
  const autosaveError = ref('')
  let autosaveTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * Beim Öffnen fehlte etwas (Video, Bild): Ein automatisches Speichern würde
   * den Verlust im Projekt festschreiben. Erst wieder nach bewusstem Speichern.
   */
  const incomplete = ref(false)

  async function refresh(): Promise<void> {
    // Auch Projekte der bisherigen App: Sie lassen sich hier umgewandelt öffnen.
    projects.value = await listProjects()
    loaded.value = true
  }

  async function hashOf(file: File): Promise<string> {
    let hash = hashes.get(file)
    if (!hash) {
      hash = await sha256Hex(file)
      hashes.set(file, hash)
    }
    return hash
  }

  /**
   * Speichert das Dokument. `asNew` legt ein weiteres Projekt an, sonst wird
   * das geöffnete überschrieben.
   */
  async function save(name: string, asNew = false): Promise<ProjectSummary> {
    if (busy.value) throw new Error(TIMELINE_PROJECT_BUSY)
    if (!hasContent.value) throw new Error(TIMELINE_PROJECT_EMPTY)
    if (pool.items.some((i) => i.state === 'uploading')) {
      throw new Error(TIMELINE_PROJECT_UPLOADS_PENDING)
    }
    const doc = timeline.doc
    const media = Object.keys(doc.assets)
    const imageIds = usedImageIds(doc)
    if (media.length > MAX_PROJECT_MEDIA || imageIds.length > MAX_PROJECT_IMAGES) {
      throw new Error(TIMELINE_PROJECT_TOO_MANY)
    }
    busy.value = 'save'
    progress.value = { key: 'timelineProjects.progress.saving' }
    try {
      const files = new Map<string, { ref: AssetRef; file: File }>()
      const images: Record<string, ProjectImageRef> = {}
      for (const imageId of imageIds) {
        // Nicht geladene Bilder (Datei fehlte beim Öffnen) haben nichts zu speichern.
        const file = getImageAsset(imageId)?.file
        if (!file) continue
        const hash = await hashOf(file)
        const type = file.type || 'application/octet-stream'
        const fileName = file.name || 'bild'
        if (!files.has(hash)) {
          files.set(hash, { ref: { hash, size: file.size, type, name: fileName }, file })
        }
        images[imageId] = { asset: hash, name: fileName, type }
      }
      const id = asNew ? undefined : current.value?.id
      let result
      try {
        result = await saveProject({
          id,
          name,
          state: buildTimelineProject(doc, images),
          media,
          assets: [...files.values()].map((f) => f.ref),
        })
      } catch (e) {
        if (e instanceof MissingMediaError) throw new Error(TIMELINE_PROJECT_MEDIA_GONE)
        throw e
      }
      if (result.project.kind !== 'timeline') {
        // Älteres Backend: Es würde das Projekt als eines der bisherigen App führen.
        if (!id) await deleteProject(result.project.id).catch(() => {})
        throw new Error(PROJECTS_UNSUPPORTED)
      }
      const missing = result.missingAssets
      for (let i = 0; i < missing.length; i++) {
        const entry = files.get(missing[i])
        if (!entry) continue
        progress.value = {
          key: 'timelineProjects.progress.files',
          params: { i: i + 1, n: missing.length },
        }
        await uploadAsset(result.project.id, entry.ref.hash, entry.file)
      }
      current.value = { id: result.project.id, name: result.project.name, savedAt: Date.now() }
      savedDoc.value = doc
      suggestedName.value = ''
      incomplete.value = false
      await refresh().catch(() => {})
      return result.project
    } finally {
      busy.value = null
      progress.value = null
    }
  }

  /**
   * Öffnet ein Projekt und ersetzt die aktuelle Bearbeitung. Ein Projekt der
   * bisherigen App wird dabei umgewandelt (das gespeicherte bleibt, wie es ist)
   * und gilt als neues, noch nicht gespeichertes Projekt.
   */
  async function open(id: string): Promise<TimelineOpenResult> {
    if (busy.value) throw new Error(TIMELINE_PROJECT_BUSY)
    busy.value = 'open'
    progress.value = { key: 'timelineProjects.progress.opening' }
    try {
      const { project, state: raw } = await fetchProject(id)
      const converted = !isTimelineProject(raw)
      let state: TimelineProjectState
      let media: Record<string, MediaView>
      let skipped: ClassicSkip[] = []
      let missing = 0
      try {
        if (converted) {
          const classic = parseProjectState(raw)
          const videos = await openProjectMedia(id)
          // Die Musik liegt als Zusatzdatei im Projekt: als Medium neu hochladen.
          let music: MediaView | null = null
          if (classic.music) {
            progress.value = { key: 'timelineProjects.progress.files', params: { i: 1, n: 1 } }
            try {
              const blob = await fetchAsset(id, classic.music.asset)
              const type = classic.music.type || blob.type
              const file = new File([blob], classic.music.name, { type })
              music = await uploadMedia(file).promise
            } catch {
              // Fehlt, oder das Backend nimmt noch keine Tondateien an: ohne Musik öffnen.
            }
          }
          const conversion = convertClassicProject(classic, videos, music)
          state = conversion.state
          skipped = conversion.skipped
          missing = conversion.missingMedia
          // Das umgewandelte Dokument nennt die Videos schon bei ihren neuen IDs.
          media = conversion.media
        } else {
          state = parseTimelineProject(raw)
          media = await openProjectMedia(id)
        }
      } catch (e) {
        if (e instanceof Error && e.message === PROJECTS_UNSUPPORTED) throw e
        throw new Error(TIMELINE_PROJECT_INVALID)
      }

      const images = new Map<string, string>()
      const refs = usedImageIds(state.doc).flatMap((imageId) => {
        const ref = state.images[imageId]
        return ref ? [[imageId, ref] as const] : []
      })
      for (let i = 0; i < refs.length; i++) {
        const [imageId, ref] = refs[i]
        progress.value = {
          key: 'timelineProjects.progress.files',
          params: { i: i + 1, n: refs.length },
        }
        try {
          const blob = await fetchAsset(id, ref.asset)
          const file = new File([blob], ref.name, { type: ref.type || blob.type })
          hashes.set(file, ref.asset)
          images.set(imageId, (await addImageAsset(file)).id)
        } catch {
          // Fehlt oder nicht lesbar: Der Clip bleibt, der Editor zeigt „Bild fehlt“.
        }
      }

      // --- Ab hier synchron übernehmen ---
      const rebound = rebindProject(state.doc, media, images)
      missing += rebound.missing
      timeline.playing = false
      if (timeline.load(rebound.doc).length > 0) throw new Error(TIMELINE_PROJECT_INVALID)
      pool.replaceAll(rebound.media)
      if (converted) {
        current.value = null
        savedDoc.value = null
        suggestedName.value = project.name
        incomplete.value = false
      } else {
        suggestedName.value = ''
        current.value = { id: project.id, name: project.name, savedAt: project.updatedAt }
        // Fehlte etwas, weicht das Dokument vom gespeicherten Stand ab.
        savedDoc.value = missing > 0 ? null : timeline.doc
        incomplete.value = missing > 0
      }
      return { missing, converted, skipped, name: project.name }
    } finally {
      busy.value = null
      progress.value = null
    }
  }

  /** Leeres Projekt beginnen (die aktuelle Bearbeitung wird verworfen). */
  function startNew(): void {
    if (busy.value) return
    timeline.reset()
    pool.replaceAll([])
    current.value = null
    savedDoc.value = null
    suggestedName.value = ''
    incomplete.value = false
  }

  /**
   * Die Timeline vom geöffneten Projekt lösen (z. B. nachdem daraus ein kurzer
   * Clip wurde): Das Projekt auf dem Server bleibt unverändert, das automatische
   * Speichern greift nicht, und „Speichern“ legt ein neues Projekt an.
   */
  function detach(name: string): void {
    current.value = null
    savedDoc.value = null
    suggestedName.value = name
    incomplete.value = false
  }

  async function remove(id: string): Promise<void> {
    if (busy.value) throw new Error(TIMELINE_PROJECT_BUSY)
    busy.value = 'delete'
    try {
      await deleteProject(id)
      if (current.value?.id === id) {
        current.value = null
        savedDoc.value = null
      }
      projects.value = projects.value.filter((p) => p.id !== id)
    } finally {
      busy.value = null
    }
  }

  // --- Automatisches Speichern ----------------------------------------------

  function clearAutosaveTimer(): void {
    if (autosaveTimer !== null) clearTimeout(autosaveTimer)
    autosaveTimer = null
  }

  function scheduleAutosave(): void {
    clearAutosaveTimer()
    autosaveState.value = 'pending'
    autosaveTimer = setTimeout(() => void runAutosave(), AUTOSAVE_DELAY_MS)
  }

  async function runAutosave(): Promise<void> {
    autosaveTimer = null
    const open = current.value
    if (!autosave.value || !open || !dirty.value || incomplete.value) {
      autosaveState.value = 'idle'
      return
    }
    // Gerade beschäftigt (Speichern, Öffnen, Upload): später noch einmal versuchen.
    if (busy.value || pool.items.some((i) => i.state === 'uploading')) {
      scheduleAutosave()
      return
    }
    autosaveState.value = 'saving'
    try {
      await save(open.name)
      autosaveError.value = ''
      // Währenddessen geändert? Dann läuft bereits die nächste Frist.
      if (autosaveTimer === null) autosaveState.value = 'idle'
    } catch (e) {
      // Kein Dauerversuch: Die nächste Änderung (oder „Speichern“) versucht es erneut.
      autosaveError.value = e instanceof Error ? e.message : String(e)
      if (autosaveTimer === null) autosaveState.value = 'error'
    }
  }

  function setAutosave(on: boolean): void {
    autosave.value = on
    try {
      localStorage.setItem(AUTOSAVE_KEY, on ? 'on' : 'off')
    } catch {
      /* localStorage nicht verfügbar -> gilt nur für diese Sitzung */
    }
  }

  // Nur ein bereits gespeichertes (geöffnetes) Projekt wird von selbst
  // überschrieben; ein neues braucht erst einen Namen.
  watch(
    [() => timeline.doc, savedDoc, () => current.value?.id ?? null, autosave, incomplete],
    () => {
      if (autosave.value && current.value && dirty.value && !incomplete.value) scheduleAutosave()
      else {
        clearAutosaveTimer()
        if (autosaveState.value !== 'saving') {
          autosaveState.value = 'idle'
          autosaveError.value = ''
        }
      }
    },
    { flush: 'sync' },
  )

  return {
    autosave,
    autosaveState,
    autosaveError,
    incomplete,
    setAutosave,
    projects,
    loaded,
    current,
    suggestedName,
    busy,
    progress,
    hasContent,
    dirty,
    refresh,
    save,
    open,
    startNew,
    detach,
    remove,
  }
})
