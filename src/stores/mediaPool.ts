import { defineStore } from 'pinia'
import { ref } from 'vue'
import {
  DERIVED_MEDIA_GONE,
  DERIVED_UNSUPPORTED,
  derivedBusy,
  derivedFailed,
  ensureDerived,
  fetchDerivedStatus,
  fetchPeaks,
  type DerivedStatus,
} from '@/lib/derivedApi'
import { deleteMedia, uploadMedia, UPLOAD_ABORTED, type MediaView } from '@/lib/mediaApi'
import { assetFromMedia } from '@/timeline/assets'
import { useTimelineStore } from './timeline'

/** Abstand der Stand-Abfragen, solange der Server noch rechnet. */
export const DERIVED_POLL_MS = 1000
/** Nach so vielen Abfragen wird seltener gefragt (lange Videos). */
const SLOW_AFTER_POLLS = 15
const SLOW_FACTOR = 3

export type PoolItemState = 'uploading' | 'ready' | 'error'

/** Stand der Vorbereitung (Wellenform, Filmstreifen, Vorschau-Kopie) eines Mediums. */
export type PrepareState = 'idle' | 'busy' | 'done' | 'failed' | 'unsupported'

export interface PoolItem {
  /** Lokaler Schlüssel (bleibt über den Upload hinweg gleich). */
  key: string
  name: string
  size: number
  state: PoolItemState
  /** Upload-Fortschritt 0–1. */
  progress: number
  /** Fehlermeldung des Uploads. */
  error: string | null
  /** Antwort des Servers nach dem Upload. */
  media: MediaView | null
  prepare: PrepareState
  derived: DerivedStatus | null
  /** Wellenform, sobald geladen. */
  peaks: Uint8Array | null
}

/** Warum ein Medium nicht entfernt wurde. */
export type RemoveResult = 'removed' | 'in-use' | 'not-found'

interface Running {
  abortUpload?: () => void
  controller: AbortController
  timer?: ReturnType<typeof setTimeout>
}

let keySeq = 0

/**
 * Medienliste des Timeline-Editors: lädt Videos auf den Server, meldet sie als
 * Medien im Timeline-Dokument an und lässt den Server Wellenform, Filmstreifen
 * und Vorschau-Kopie vorbereiten.
 */
export const useMediaPoolStore = defineStore('mediaPool', () => {
  const items = ref<PoolItem[]>([])
  /** Zuletzt abgelehnte Dateien (keine Videos). */
  const rejected = ref<string[]>([])
  const running = new Map<string, Running>()

  const find = (key: string) => items.value.find((i) => i.key === key)

  function stop(key: string): void {
    const r = running.get(key)
    if (!r) return
    if (r.timer !== undefined) clearTimeout(r.timer)
    r.controller.abort()
    r.abortUpload?.()
    running.delete(key)
  }

  /** Eintrag zu einem Medium des Timeline-Dokuments (Filmstreifen, Wellenform). */
  function byAsset(assetId: string): PoolItem | undefined {
    return items.value.find((i) => i.media?.id === assetId)
  }

  /** Videos hochladen. Dateien, die keine Videos sind, werden abgelehnt (siehe `rejected`). */
  function add(files: readonly File[]): void {
    rejected.value = files.filter((f) => !f.type.startsWith('video/')).map((f) => f.name)
    for (const file of files) {
      if (!file.type.startsWith('video/')) continue
      const key = `pool-${++keySeq}`
      items.value.push({
        key,
        name: file.name,
        size: file.size,
        state: 'uploading',
        progress: 0,
        error: null,
        media: null,
        prepare: 'idle',
        derived: null,
        peaks: null,
      })
      const upload = uploadMedia(file, (ratio) => {
        const item = find(key)
        if (item) item.progress = Math.min(1, Math.max(0, ratio))
      })
      running.set(key, { abortUpload: upload.abort, controller: new AbortController() })
      upload.promise.then(
        (media) => {
          const item = find(key)
          if (!item) {
            // Während des Uploads entfernt: auf dem Server nicht liegen lassen.
            void deleteMedia(media.id).catch(() => {})
            return
          }
          item.state = 'ready'
          item.progress = 1
          item.media = media
          item.name = media.name
          item.size = media.size || item.size
          useTimelineStore().putAsset(assetFromMedia(media))
          void prepare(key)
        },
        (err: unknown) => {
          const item = find(key)
          if (!item) return
          const message = err instanceof Error ? err.message : String(err)
          if (message === UPLOAD_ABORTED) return
          item.state = 'error'
          item.error = message
          running.delete(key)
        },
      )
    }
  }

  function applyStatus(item: PoolItem, status: DerivedStatus): void {
    item.derived = status
    item.prepare = derivedBusy(status) ? 'busy' : derivedFailed(status) ? 'failed' : 'done'
  }

  async function loadPeaks(key: string, signal: AbortSignal): Promise<void> {
    const item = find(key)
    if (!item?.media || item.peaks || item.derived?.peaks.state !== 'ready') return
    try {
      const peaks = await fetchPeaks(item.media.id, signal)
      const current = find(key)
      if (current) current.peaks = peaks
    } catch {
      // Wellenform ist nur Zierde in der Liste; ein Fehler blockiert nichts.
    }
  }

  function fail(key: string, err: unknown): void {
    const item = find(key)
    if (!item) return
    const message = err instanceof Error ? err.message : ''
    if (message === DERIVED_UNSUPPORTED) item.prepare = 'unsupported'
    else if (message === DERIVED_MEDIA_GONE) {
      // Auf dem Server gelöscht (z. B. Auto-Aufräumen): Eintrag als Fehler zeigen.
      item.state = 'error'
      item.error = DERIVED_MEDIA_GONE
      item.prepare = 'idle'
    } else item.prepare = 'failed'
  }

  function poll(key: string, count: number): void {
    const r = running.get(key)
    const item = find(key)
    if (!r || !item?.media) return
    const id = item.media.id
    r.timer = setTimeout(
      () => {
        fetchDerivedStatus(id, r.controller.signal).then(
          (status) => {
            const current = find(key)
            if (!current || r.controller.signal.aborted) return
            applyStatus(current, status)
            void loadPeaks(key, r.controller.signal)
            if (current.prepare === 'busy') poll(key, count + 1)
          },
          (err: unknown) => {
            if (!r.controller.signal.aborted) fail(key, err)
          },
        )
      },
      DERIVED_POLL_MS * (count >= SLOW_AFTER_POLLS ? SLOW_FACTOR : 1),
    )
  }

  /** Vorbereitung anstoßen (auch erneut nach einem Fehler). */
  async function prepare(key: string): Promise<void> {
    const item = find(key)
    if (!item?.media || item.prepare === 'busy') return
    let r = running.get(key)
    if (!r) {
      r = { controller: new AbortController() }
      running.set(key, r)
    }
    if (r.timer !== undefined) clearTimeout(r.timer)
    item.prepare = 'busy'
    try {
      const status = await ensureDerived(item.media.id, r.controller.signal)
      const current = find(key)
      if (!current || r.controller.signal.aborted) return
      applyStatus(current, status)
      void loadPeaks(key, r.controller.signal)
      if (current.prepare === 'busy') poll(key, 0)
    } catch (err) {
      if (!r.controller.signal.aborted) fail(key, err)
    }
  }

  /**
   * Medium entfernen: aus der Liste, aus dem Timeline-Dokument und vom Server.
   * Abgelehnt (`in-use`), solange ein Clip es verwendet.
   */
  function remove(key: string): RemoveResult {
    const item = find(key)
    if (!item) return 'not-found'
    const timeline = useTimelineStore()
    if (item.media && timeline.doc.assets[item.media.id]) {
      if (!timeline.removeAsset(item.media.id)) return 'in-use'
    }
    stop(key)
    items.value = items.value.filter((i) => i.key !== key)
    if (item.media) void deleteMedia(item.media.id).catch(() => {})
    return 'removed'
  }

  /**
   * Liste durch bereits angemeldete Videos ersetzen (Projekt geöffnet bzw. neues
   * Projekt). Das Timeline-Dokument setzt der Aufrufer; die bisherigen Videos
   * bleiben auf dem Server (ein gespeichertes Projekt kann sie noch nutzen, der
   * Rest verfällt von selbst).
   */
  function replaceAll(media: readonly MediaView[]): void {
    dispose()
    rejected.value = []
    items.value = media.map((m) => ({
      key: `pool-${++keySeq}`,
      name: m.name,
      size: m.size,
      state: 'ready',
      progress: 1,
      error: null,
      media: m,
      prepare: 'idle',
      derived: null,
      peaks: null,
    }))
    for (const item of items.value) void prepare(item.key)
  }

  /**
   * Medium aufnehmen, das schon auf dem Server liegt (Bild-Clip, KI-Video).
   * Ist es bereits in der Liste, bleibt alles, wie es ist.
   */
  function addMedia(media: MediaView): void {
    if (byAsset(media.id)) return
    const key = `pool-${++keySeq}`
    items.value.push({
      key,
      name: media.name,
      size: media.size,
      state: 'ready',
      progress: 1,
      error: null,
      media,
      prepare: 'idle',
      derived: null,
      peaks: null,
    })
    useTimelineStore().putAsset(assetFromMedia(media))
    void prepare(key)
  }

  /** Alle laufenden Uploads und Abfragen beenden. */
  function dispose(): void {
    for (const key of [...running.keys()]) stop(key)
  }

  return { items, rejected, byAsset, add, addMedia, prepare, remove, replaceAll, dispose }
})
