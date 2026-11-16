import { defineStore } from 'pinia'
import { computed, ref, shallowRef } from 'vue'
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
import {
  buildTimelineProject,
  parseTimelineProject,
  rebindProject,
  usedImageIds,
  type ProjectImageRef,
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

  async function refresh(): Promise<void> {
    projects.value = (await listProjects()).filter((p) => p.kind === 'timeline')
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
      await refresh().catch(() => {})
      return result.project
    } finally {
      busy.value = null
      progress.value = null
    }
  }

  /**
   * Öffnet ein Projekt und ersetzt die aktuelle Bearbeitung. Liefert, wie viele
   * Videos oder Bilder nicht wiederhergestellt werden konnten.
   */
  async function open(id: string): Promise<{ missing: number }> {
    if (busy.value) throw new Error(TIMELINE_PROJECT_BUSY)
    busy.value = 'open'
    progress.value = { key: 'timelineProjects.progress.opening' }
    try {
      const { project, state: raw } = await fetchProject(id)
      let state
      try {
        state = parseTimelineProject(raw)
      } catch {
        throw new Error(TIMELINE_PROJECT_INVALID)
      }
      const media = await openProjectMedia(id)

      const images = new Map<string, string>()
      const refs = Object.entries(state.images)
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
      timeline.playing = false
      if (timeline.load(rebound.doc).length > 0) throw new Error(TIMELINE_PROJECT_INVALID)
      pool.replaceAll(rebound.media)
      current.value = { id: project.id, name: project.name, savedAt: project.updatedAt }
      // Fehlte etwas, weicht das Dokument vom gespeicherten Stand ab.
      savedDoc.value = rebound.missing > 0 ? null : timeline.doc
      return { missing: rebound.missing }
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

  return {
    projects,
    loaded,
    current,
    busy,
    progress,
    hasContent,
    dirty,
    refresh,
    save,
    open,
    startNew,
    remove,
  }
})
