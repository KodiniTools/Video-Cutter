import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import { useLibraryStore } from '@/stores/library'
import { useVideoEditorStore } from '@/stores/videoEditor'
import { useTextOverlayStore } from '@/stores/textOverlays'
import { useGraphicOverlayStore } from '@/stores/graphicOverlays'
import { useAudioFadeStore } from '@/stores/audioFade'
import { useHistoryStore } from '@/stores/history'
import { useAiStore } from '@/stores/ai'
import { useAnimationPref } from '@/composables/useAnimationPref'
import { addImageAsset, getImageAsset } from '@/lib/imageAssets'
import { fetchMediaFile } from '@/lib/mediaApi'
import {
  deleteProject,
  fetchAsset,
  fetchProject,
  listProjects,
  MissingMediaError,
  openProjectMedia,
  saveProject,
  sha256Hex,
  uploadAsset,
  type AssetRef,
  type ProjectSummary,
} from '@/lib/projectApi'
import {
  fitEditorSnapshot,
  parseProjectState,
  PROJECT_STATE_VERSION,
  type ProjectFileRef,
  type ProjectState,
} from '@/lib/projectState'
import type { GraphicOverlay } from '@/lib/graphicOverlay'

/** Fehler-Kennung: Speichern erst, wenn alle Videos hochgeladen sind. */
export const PROJECT_UPLOADS_PENDING = 'PROJECT_UPLOADS_PENDING'
/** Fehler-Kennung: keine Videos – nichts zu speichern. */
export const PROJECT_EMPTY = 'PROJECT_EMPTY'

/** Fortschritt für die Anzeige (i18n-Schlüssel + Werte). */
export interface ProjectProgress {
  key: string
  params?: Record<string, string | number>
}

export interface OpenResult {
  /** Videos/Dateien, die nicht wiederhergestellt werden konnten. */
  missing: number
}

function fileName(f: { name?: string }, fb: string): string {
  return f.name || fb
}

/**
 * Projekte: den Bearbeitungsstand (Videos, Von/Bis, Texte, Grafiken, Bilder,
 * Musik, Ton-Blende, Übergänge, Ausgabeformat, Auswahl) auf dem Server
 * speichern und später fortsetzen. Der Rückgängig-Verlauf beginnt nach dem
 * Öffnen neu.
 */
export const useProjectStore = defineStore('projects', () => {
  const library = useLibraryStore()
  const editor = useVideoEditorStore()
  const texts = useTextOverlayStore()
  const graphics = useGraphicOverlayStore()
  const audioFade = useAudioFadeStore()
  const history = useHistoryStore()
  const ai = useAiStore()
  const anim = useAnimationPref()

  const projects = ref<ProjectSummary[]>([])
  const loaded = ref(false)
  /** Aktuell geöffnetes/gespeichertes Projekt. */
  const current = ref<{ id: string; name: string; savedAt: number } | null>(null)
  const busy = ref<'save' | 'open' | 'delete' | null>(null)
  const progress = ref<ProjectProgress | null>(null)
  /** Letzte Meldung der Projekt-Karte (übersetzt; überlebt den Wechsel Startseite -> Editor). */
  const error = ref('')
  const notice = ref('')

  /** Wartet auf das Laden des markierten Videos, um die Auswahl herzustellen. */
  let stopPending: (() => void) | null = null

  async function refresh(): Promise<void> {
    projects.value = await listProjects()
    loaded.value = true
  }

  // --- Speichern -----------------------------------------------------------

  async function fileRef(
    file: File,
    assets: Map<string, { ref: AssetRef; file: File }>,
  ): Promise<ProjectFileRef> {
    const hash = await sha256Hex(file)
    const type = file.type || 'application/octet-stream'
    const name = fileName(file, 'datei')
    if (!assets.has(hash)) assets.set(hash, { ref: { hash, size: file.size, type, name }, file })
    return { asset: hash, name, type }
  }

  /** Baut den Stand aus den Stores. */
  async function buildState(): Promise<{
    state: ProjectState
    media: string[]
    assets: Map<string, { ref: AssetRef; file: File }>
  }> {
    const assets = new Map<string, { ref: AssetRef; file: File }>()
    const images: ProjectState['images'] = {}
    const list = library.items
    for (const it of list) {
      for (const g of graphics.listFor(it.id)) {
        if (g.kind !== 'image' || images[g.image]) continue
        const file = getImageAsset(g.image)?.file
        if (file) images[g.image] = await fileRef(file, assets)
      }
    }
    const m = editor.music
    const music = m
      ? {
          ...(await fileRef(m.file, assets)),
          volume: m.volume,
          originalVolume: m.originalVolume,
          fade: m.fade,
          loop: m.loop,
        }
      : null
    const index = new Map(list.map((it, i) => [it.id, i]))
    const seams: ProjectState['seams'] = []
    for (const [key, preset] of Object.entries(library.seamTransitions)) {
      const [a, b] = key.split('>').map(Number)
      const from = index.get(a)
      const to = index.get(b)
      if (from !== undefined && to !== undefined) seams.push({ from, to, preset })
    }
    const sel = library.selectedId === null ? undefined : index.get(library.selectedId)
    const state: ProjectState = {
      version: PROJECT_STATE_VERSION,
      items: list.map((it) => ({
        media: it.mediaId as string,
        name: it.name,
        start: it.start,
        end: it.end,
        include: it.include,
        texts: texts.listFor(it.id).map((o) => ({ ...o })),
        graphics: graphics.listFor(it.id).map((o) => ({ ...o })),
      })),
      selected: sel ?? null,
      seams,
      normalizeAudio: library.normalizeAudio,
      editor: editor.file && editor.duration > 0 ? editor.snapshot() : null,
      output: { aspect: editor.outputAspect, fill: editor.outputFill },
      music,
      audioFade: JSON.parse(JSON.stringify(audioFade.settings)),
      anim: { animation: anim.animation.value, duration: anim.duration.value },
      images,
    }
    return { state, media: list.map((it) => it.mediaId as string), assets }
  }

  /**
   * Speichert den Stand. `asNew` legt ein neues Projekt an, sonst wird das
   * aktuelle überschrieben. Fehlen Videos auf dem Server (Auto-Aufräumen),
   * werden sie einmal neu hochgeladen.
   */
  async function save(name: string, asNew = false): Promise<ProjectSummary> {
    if (busy.value) throw new Error('Bitte warten …')
    if (!library.items.length) throw new Error(PROJECT_EMPTY)
    if (library.items.some((it) => it.status !== 'ready' || !it.mediaId)) {
      throw new Error(PROJECT_UPLOADS_PENDING)
    }
    busy.value = 'save'
    progress.value = { key: 'projects.progress.saving' }
    try {
      const id = asNew ? undefined : current.value?.id
      let built = await buildState()
      let result
      try {
        result = await saveProject({
          id,
          name,
          state: built.state,
          media: built.media,
          assets: [...built.assets.values()].map((a) => a.ref),
        })
      } catch (e) {
        if (!(e instanceof MissingMediaError)) throw e
        // Videos neu hochladen und noch einmal versuchen.
        const missing = new Set(e.missing)
        const affected = library.items.filter((it) => it.mediaId && missing.has(it.mediaId))
        progress.value = { key: 'projects.progress.reupload', params: { n: affected.length } }
        await Promise.all(affected.map((it) => library.reupload(it.id)))
        progress.value = { key: 'projects.progress.saving' }
        built = await buildState()
        result = await saveProject({
          id,
          name,
          state: built.state,
          media: built.media,
          assets: [...built.assets.values()].map((a) => a.ref),
        })
      }
      const missingAssets = result.missingAssets
      for (let i = 0; i < missingAssets.length; i++) {
        const a = built.assets.get(missingAssets[i])
        if (!a) continue
        progress.value = {
          key: 'projects.progress.files',
          params: { i: i + 1, n: missingAssets.length },
        }
        await uploadAsset(result.project.id, a.ref.hash, a.file)
      }
      current.value = { id: result.project.id, name: result.project.name, savedAt: Date.now() }
      await refresh().catch(() => {})
      return result.project
    } finally {
      busy.value = null
      progress.value = null
    }
  }

  // --- Öffnen --------------------------------------------------------------

  async function loadFile(id: string, ref: ProjectFileRef): Promise<File | null> {
    try {
      const blob = await fetchAsset(id, ref.asset)
      return new File([blob], ref.name, { type: ref.type || blob.type })
    } catch {
      return null
    }
  }

  /** Stellt die Auswahl her, sobald das markierte Video geladen ist. */
  function applyEditorWhenLoaded(file: File, snap: ProjectState['editor']): void {
    stopPending?.()
    stopPending = null
    if (!snap) return
    const stop = watch(
      () => editor.loadSeq,
      () => {
        if (editor.file !== file) {
          if (editor.file !== null) stopPending?.() // anderes Video gewählt
          return
        }
        if (!(editor.duration > 0)) return
        editor.applySnapshot(fitEditorSnapshot(snap, editor.duration))
        history.reset()
        stopPending?.()
      },
      { flush: 'post' },
    )
    stopPending = () => {
      stop()
      stopPending = null
    }
  }

  /** Öffnet ein Projekt und ersetzt die aktuelle Bearbeitung. */
  async function open(id: string): Promise<OpenResult> {
    if (busy.value) throw new Error('Bitte warten …')
    busy.value = 'open'
    progress.value = { key: 'projects.progress.opening' }
    let missing = 0
    try {
      const { project, state: raw } = await fetchProject(id)
      const state = parseProjectState(raw)
      const media = await openProjectMedia(id)

      // Videos laden (für Vorschau und Wiedergabe im Browser).
      const entries: Parameters<typeof library.replaceAll>[0] = []
      const kept: number[] = [] // Index im Stand je übernommenem Video
      for (let i = 0; i < state.items.length; i++) {
        const it = state.items[i]
        const mv = media[it.media]
        if (!mv) {
          missing++
          continue
        }
        progress.value = {
          key: 'projects.progress.video',
          params: { i: i + 1, n: state.items.length },
        }
        const blob = await fetchMediaFile(mv.id)
        const file = new File([blob], it.name || mv.name, { type: blob.type || 'video/mp4' })
        entries.push({
          file,
          media: mv,
          name: it.name || mv.name,
          start: it.start,
          end: it.end,
          include: it.include,
        })
        kept.push(i)
      }

      // Bilder und Musik.
      progress.value = { key: 'projects.progress.files', params: { i: 1, n: 1 } }
      const imageIds = new Map<string, string>()
      for (const [key, ref] of Object.entries(state.images)) {
        const f = await loadFile(id, ref)
        try {
          if (f) imageIds.set(key, (await addImageAsset(f)).id)
          else missing++
        } catch {
          missing++
        }
      }
      const musicFile = state.music ? await loadFile(id, state.music) : null
      if (state.music && !musicFile) missing++

      // --- Ab hier synchron übernehmen ---
      const oldIds = library.items.map((it) => it.id)
      const pos = new Map(kept.map((orig, j) => [orig, j]))
      const selected = state.selected === null ? null : (pos.get(state.selected) ?? null)
      const seams = state.seams.flatMap((s) => {
        const from = pos.get(s.from)
        const to = pos.get(s.to)
        return from !== undefined && to !== undefined ? [{ from, to, preset: s.preset }] : []
      })
      const next = library.replaceAll(entries, {
        selected,
        seams,
        normalizeAudio: state.normalizeAudio,
      })
      for (const oid of oldIds) {
        texts.clearItem(oid)
        graphics.clearItem(oid)
        ai.clearItem(oid)
      }
      next.forEach((item, j) => {
        const src = state.items[kept[j]]
        texts.importFor(item.id, src.texts)
        const gs: GraphicOverlay[] = src.graphics.flatMap((g) => {
          if (g.kind !== 'image') return [g]
          const img = imageIds.get(g.image)
          return img ? [{ ...g, image: img }] : []
        })
        graphics.importFor(item.id, gs)
      })
      editor.setOutputAspect(state.output.aspect)
      editor.setOutputFill(state.output.fill)
      editor.music =
        state.music && musicFile
          ? {
              file: musicFile,
              volume: state.music.volume,
              originalVolume: state.music.originalVolume,
              fade: state.music.fade,
              loop: state.music.loop,
            }
          : null
      audioFade.settings = state.audioFade
      anim.animation.value = state.anim.animation
      anim.duration.value = state.anim.duration

      current.value = { id: project.id, name: project.name, savedAt: project.updatedAt }
      history.reset()
      const sel = library.selected
      if (sel && selected !== null) applyEditorWhenLoaded(sel.file, state.editor)
      return { missing }
    } finally {
      busy.value = null
      progress.value = null
    }
  }

  async function remove(id: string): Promise<void> {
    if (busy.value) throw new Error('Bitte warten …')
    busy.value = 'delete'
    try {
      await deleteProject(id)
      if (current.value?.id === id) current.value = null
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
    error,
    notice,
    refresh,
    save,
    open,
    remove,
  }
})
