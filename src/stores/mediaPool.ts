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
import {
  deleteMedia,
  fetchMediaFile,
  isAudioFile,
  isImageFile,
  MEDIA_IMAGE_UNSUPPORTED,
  uploadMedia,
  UPLOAD_ABORTED,
  type MediaView,
} from '@/lib/mediaApi'
import {
  hasImageAsset,
  getImageAsset,
  loadImageFile,
  registerImage,
  releaseDecodedImage,
  removeImageAsset,
  type DecodedImage,
} from '@/lib/imageAssets'
import { assetFromMedia } from '@/timeline/assets'
import { useTimelineStore } from './timeline'

/** Abstand der Stand-Abfragen, solange der Server noch rechnet. */
export const DERIVED_POLL_MS = 1000
/** Nach so vielen Abfragen wird seltener gefragt (lange Videos). */
const SLOW_AFTER_POLLS = 15
const SLOW_FACTOR = 3

export type PoolItemState = 'uploading' | 'ready' | 'error'

/** Fehler-Kennung: Ein Bild der Liste ließ sich nicht vom Server laden bzw. lesen. */
export const IMAGE_LOAD_FAILED = 'IMAGE_LOAD_FAILED'

/** Breite des kleinen Vorschaubilds eines Bildes in der Liste (px). */
const IMAGE_THUMB_WIDTH = 192

/** Kleines Vorschaubild (JPEG-Data-URL) eines geladenen Bildes; leer, wenn nicht möglich. */
function imageThumb(source: CanvasImageSource, width: number, height: number): string {
  try {
    if (!(width > 0 && height > 0)) return ''
    const scale = Math.min(1, IMAGE_THUMB_WIDTH / width)
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(width * scale))
    canvas.height = Math.max(1, Math.round(height * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) return ''
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/jpeg', 0.8)
  } catch {
    return ''
  }
}

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
  /**
   * Auf dem Server erzeugt (Bild-Clip, KI-Video, Video aus der Galerie). Solche
   * Medien hat der Nutzer nicht als Datei bei sich; ohne gespeichertes Projekt
   * verfallen sie mit dem Auto-Aufräumen der Bibliothek. Fehlt = hochgeladen
   * oder aus einem gespeicherten Projekt geöffnet.
   */
  generated?: boolean
  /** Nur Bilder: kleines Vorschaubild (Data-URL), sobald das Bild geladen ist. */
  thumb?: string
}

/**
 * Hinweis „Projekt speichern“ zeigen? Ja, sobald ein auf dem Server erzeugtes
 * Medium in der Liste liegt und der Stand nicht gespeichert ist.
 */
export function generatedAtRisk(items: readonly PoolItem[], unsaved: boolean): boolean {
  return unsaved && items.some((i) => i.generated === true && i.media !== null)
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
 * Medienliste des Timeline-Editors: lädt Videos und Tondateien auf den Server, meldet sie als
 * Medien im Timeline-Dokument an und lässt den Server Wellenform, Filmstreifen
 * und Vorschau-Kopie vorbereiten.
 */
export const useMediaPoolStore = defineStore('mediaPool', () => {
  const items = ref<PoolItem[]>([])
  /** Zuletzt abgelehnte Dateien (weder Video noch Ton). */
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

  /**
   * Videos und Tondateien hochladen. Alles andere wird abgelehnt (siehe `rejected`).
   * `onReady` meldet jedes Medium, sobald es im Timeline-Dokument angemeldet ist.
   */
  function add(files: readonly File[], onReady?: (media: MediaView) => void): void {
    const accepted = (f: File) => f.type.startsWith('video/') || isAudioFile(f) || isImageFile(f)
    rejected.value = files.filter((f) => !accepted(f)).map((f) => f.name)
    for (const file of files) {
      if (!accepted(file)) continue
      if (isImageFile(file)) {
        // Fehler zeigt der Eintrag in der Liste.
        addImage(file).then(
          (media) => onReady?.(media),
          () => {},
        )
        continue
      }
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
          onReady?.(media)
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

  /**
   * Bild (JPEG, PNG, WebP) hochladen: Es liegt danach wie ein Video in der
   * Server-Bibliothek, steht in der Liste und im Timeline-Dokument (Medium der
   * Art `image`) und wird mit dem Projekt gespeichert. Der Browser dekodiert es
   * parallel; registriert wird es unter der ID des Mediums.
   *
   * `quietUnsupported`: Nimmt ein älteres Backend keine Bilder an, verschwindet
   * der Eintrag wieder (der Aufrufer weicht auf das Bild nur im Browser aus).
   * Wirft die Fehlermeldung (bzw. eine Kennung wie MEDIA_IMAGE_UNSUPPORTED).
   */
  async function addImage(
    file: File,
    options: { quietUnsupported?: boolean } = {},
  ): Promise<MediaView> {
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
    const failImage = (err: unknown): never => {
      running.delete(key)
      const message = err instanceof Error ? err.message : String(err)
      const item = find(key)
      if (item && message !== UPLOAD_ABORTED) {
        if (message === MEDIA_IMAGE_UNSUPPORTED && options.quietUnsupported)
          items.value = items.value.filter((i) => i.key !== key)
        else {
          item.state = 'error'
          item.error = message
        }
      }
      throw err instanceof Error ? err : new Error(message)
    }
    const decoding = loadImageFile(file)
    // Nicht abgefangene Ablehnung vermeiden, falls der Upload zuerst scheitert.
    decoding.catch(() => {})
    const upload = uploadMedia(file, (ratio) => {
      const item = find(key)
      if (item) item.progress = Math.min(1, Math.max(0, ratio))
    })
    running.set(key, { abortUpload: upload.abort, controller: new AbortController() })
    let image: DecodedImage
    try {
      image = await decoding
    } catch (err) {
      upload.abort()
      upload.promise.catch(() => {})
      return failImage(err)
    }
    let media: MediaView
    try {
      media = await upload.promise
    } catch (err) {
      releaseDecodedImage(image)
      return failImage(err)
    }
    running.delete(key)
    const item = find(key)
    if (!item) {
      // Während des Uploads entfernt: auf dem Server nicht liegen lassen.
      releaseDecodedImage(image)
      void deleteMedia(media.id).catch(() => {})
      throw new Error(UPLOAD_ABORTED)
    }
    registerImage(media.id, image)
    item.state = 'ready'
    item.progress = 1
    item.media = media
    item.name = media.name
    item.size = media.size || item.size
    item.prepare = 'done'
    item.thumb = imageThumb(image.source, image.width, image.height)
    useTimelineStore().putAsset(assetFromMedia(media))
    return media
  }

  /**
   * Bild eines Mediums vom Server laden und registrieren (nach dem Öffnen
   * eines Projekts). `false`, wenn es fehlt oder nicht lesbar ist.
   */
  async function loadImage(media: MediaView): Promise<boolean> {
    if (hasImageAsset(media.id)) return true
    try {
      const blob = await fetchMediaFile(media.id)
      const file = new File([blob], media.name, { type: blob.type })
      registerImage(media.id, await loadImageFile(file))
      return true
    } catch {
      return false
    }
  }

  /** Mehrere Bilder laden (vor dem Übernehmen eines geöffneten Projekts). */
  async function loadImages(media: readonly MediaView[]): Promise<void> {
    await Promise.all(media.filter((m) => m.kind === 'image').map(loadImage))
  }

  /** Bild eines Eintrags laden (bzw. erneut versuchen) und Vorschaubild setzen. */
  async function prepareImage(key: string): Promise<void> {
    const item = find(key)
    if (!item?.media || item.prepare === 'busy') return
    item.prepare = 'busy'
    const ok = await loadImage(item.media)
    const current = find(key)
    if (!current?.media) return
    const asset = ok ? getImageAsset(current.media.id) : undefined
    if (asset) {
      current.prepare = 'done'
      current.thumb = imageThumb(asset.source, asset.width, asset.height)
    } else {
      current.prepare = 'failed'
      current.error = IMAGE_LOAD_FAILED
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
    // Bilder haben keine Wellenform/Filmstreifen: nur das Bild selbst laden.
    if (item.media.kind === 'image') return prepareImage(key)
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
    if (item.media) {
      if (item.media.kind === 'image') removeImageAsset(item.media.id)
      void deleteMedia(item.media.id).catch(() => {})
    }
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
      generated: true,
    })
    useTimelineStore().putAsset(assetFromMedia(media))
    void prepare(key)
  }

  /** Alle laufenden Uploads und Abfragen beenden. */
  function dispose(): void {
    for (const key of [...running.keys()]) stop(key)
  }

  return {
    items,
    rejected,
    byAsset,
    add,
    addImage,
    addMedia,
    loadImages,
    prepare,
    remove,
    replaceAll,
    dispose,
  }
})
