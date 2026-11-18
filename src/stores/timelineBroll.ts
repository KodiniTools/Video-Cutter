import { defineStore } from 'pinia'
import { computed, ref, shallowRef } from 'vue'
import {
  AI_CANCELLED,
  fetchAiModels,
  fetchGeneratedImage,
  parseGeneratedImages,
  parseGeneratedVideo,
  runAiJob,
  type AiModels,
  type AiRun,
  type BrollKind,
  type BrollSuggestion,
} from '@/lib/aiApi'
import { decodeImageFile } from '@/lib/imageAssets'
import { createStillClip, type MediaView } from '@/lib/mediaApi'
import { clampStillDuration, evenSize, renderStillPng, stillFps } from '@/lib/stillClip'
import { brollSpan, brollVideoSeconds, insertBrollClip } from '@/timeline/broll'
import { findClip, type OpResult } from '@/timeline/model'
import { useMediaPoolStore } from './mediaPool'
import { useTimelineStore } from './timeline'

/**
 * Zwischenbilder (B-Roll) im Timeline-Editor: Claudes Vorschläge (Stelle,
 * Art, Prompt) lassen sich prüfen und ändern, dann erzeugt Gemini je
 * angehakter Stelle ein Bild (wird zum Bild-Clip) oder ein kurzes Video. Erst
 * „Einfügen“ legt die fertigen Zwischenbilder über das Video (ein
 * Verlaufsschritt). Die Liste liegt im Store, damit lange Video-Aufträge
 * weiterlaufen, auch wenn das Feld kurz verschwindet.
 */

export type BrollItemState = 'idle' | 'generating' | 'ready' | 'error'

export interface BrollItem extends BrollSuggestion {
  id: number
  checked: boolean
  state: BrollItemState
  error: string
  /** Fertiges Medium (Bild-Clip bzw. KI-Video) in der Medienliste. */
  media: MediaView | null
  /** Vorschaubild (Objekt-URL) bei Bildern. */
  thumb: string
  /** Eingefügter Clip (zählt nur, solange er auf der Timeline liegt). */
  clipId: string
}

/** Gemerkte Modellwahl, wie beim Bild-Clip (StillAiImage.vue). */
const MODEL_KEY = 'vc.aiModel.'

export const useTimelineBrollStore = defineStore('timelineBroll', () => {
  const timeline = useTimelineStore()
  const pool = useMediaPoolStore()

  const items = ref<BrollItem[]>([])
  /** Stelle, die gerade erzeugt wird (`null` = keine). */
  const current = ref<number | null>(null)
  const progress = ref(0)
  const run = shallowRef<AiRun<unknown> | null>(null)
  let stopRequested = false
  let nextId = 1

  const models = ref<AiModels | null>(null)
  const model = ref<Record<BrollKind, string>>({ image: '', video: '' })

  const generating = computed(() => current.value !== null)

  /** Liegt der Clip der Stelle noch auf der Timeline (nach Rückgängig evtl. nicht)? */
  function isInserted(item: BrollItem): boolean {
    return item.clipId !== '' && findClip(timeline.doc, item.clipId) !== null
  }

  /** Neue Vorschläge übernehmen (ersetzt die bisherige Liste). */
  function setSuggestions(list: readonly BrollSuggestion[]): void {
    clear()
    items.value = list.map((s) => ({
      ...s,
      id: nextId++,
      checked: true,
      state: 'idle',
      error: '',
      media: null,
      thumb: '',
      clipId: '',
    }))
  }

  /** Prompt, Art oder Häkchen einer Stelle ändern. Neue Art/Prompt = neu erzeugen. */
  function update(
    id: number,
    patch: Partial<Pick<BrollItem, 'prompt' | 'kind' | 'checked'>>,
  ): void {
    const item = items.value.find((i) => i.id === id)
    if (!item || item.state === 'generating') return
    const changed =
      (patch.prompt !== undefined && patch.prompt !== item.prompt) ||
      (patch.kind !== undefined && patch.kind !== item.kind)
    Object.assign(item, patch)
    if (changed && item.state !== 'idle') resetResult(item)
  }

  function resetResult(item: BrollItem): void {
    if (item.thumb) URL.revokeObjectURL(item.thumb)
    item.thumb = ''
    item.media = null
    item.state = 'idle'
    item.error = ''
    item.clipId = ''
  }

  async function loadModels(): Promise<void> {
    if (models.value) return
    try {
      const m = await fetchAiModels()
      if (!m) return
      for (const kind of ['image', 'video'] as const) {
        let saved = ''
        try {
          saved = localStorage.getItem(MODEL_KEY + kind) ?? ''
        } catch {
          /* ohne gemerkte Auswahl */
        }
        model.value[kind] = m[kind].models.includes(saved) ? saved : m[kind].default
      }
      models.value = m
    } catch {
      /* ohne Liste gilt die Voreinstellung des Servers */
    }
  }

  function setModel(kind: BrollKind, value: string): void {
    model.value[kind] = value
    try {
      localStorage.setItem(MODEL_KEY + kind, value)
    } catch {
      /* Speicher gesperrt – Auswahl gilt nur für diese Sitzung */
    }
  }

  function size(): { width: number; height: number } {
    const s = timeline.doc.settings
    return { width: evenSize(s.width), height: evenSize(s.height) }
  }

  async function makeImage(item: BrollItem): Promise<void> {
    const s = size()
    const job = runAiJob(
      'images',
      {
        prompt: item.prompt,
        ...s,
        count: 1,
        ...(model.value.image ? { model: model.value.image } : {}),
      },
      parseGeneratedImages,
      (p) => (progress.value = Math.round(p * 0.8)),
    )
    run.value = job as AiRun<unknown>
    const result = await job.promise
    run.value = null
    const file = await fetchGeneratedImage(result.images[0], `zwischenbild-${item.id}`)
    const decoded = await decodeImageFile(file)
    const png = await renderStillPng(
      s,
      { source: decoded.source, width: decoded.w, height: decoded.h },
      'cover',
      timeline.doc.settings.background,
    )
    if (typeof ImageBitmap !== 'undefined' && decoded.source instanceof ImageBitmap) {
      decoded.source.close()
    }
    if (stopRequested) throw new Error(AI_CANCELLED)
    progress.value = 90
    const media = await createStillClip({
      image: png,
      duration: clampStillDuration(item.end - item.at),
      ...s,
      fps: stillFps(timeline.doc.settings.fps),
      audio: false,
      name: `Zwischenbild ${item.id}.mp4`,
    })
    pool.addMedia(media)
    item.media = media
    item.thumb = URL.createObjectURL(file)
  }

  async function makeVideo(item: BrollItem): Promise<void> {
    const job = runAiJob(
      'video',
      {
        prompt: item.prompt,
        ...size(),
        duration: brollVideoSeconds(item.end - item.at),
        ...(model.value.video ? { model: model.value.video } : {}),
      },
      parseGeneratedVideo,
      (p) => (progress.value = p),
    )
    run.value = job as AiRun<unknown>
    const result = await job.promise
    run.value = null
    pool.addMedia(result.media)
    item.media = result.media
  }

  /**
   * Angehakte Stellen ohne fertiges Ergebnis nacheinander erzeugen (oder nur
   * `ids`). Ein Fehler betrifft nur seine Stelle; Abbrechen hält alles an.
   */
  async function generate(ids?: readonly number[]): Promise<{ done: number; failed: number }> {
    if (generating.value) throw new Error('Es werden bereits Zwischenbilder erzeugt.')
    stopRequested = false
    let done = 0
    let failed = 0
    const queue = items.value.filter((i) =>
      ids ? ids.includes(i.id) : i.checked && i.state !== 'ready',
    )
    for (const item of queue) {
      if (stopRequested) break
      if (item.state === 'ready') resetResult(item)
      current.value = item.id
      progress.value = 0
      item.state = 'generating'
      item.error = ''
      try {
        if (item.kind === 'video') await makeVideo(item)
        else await makeImage(item)
        item.state = 'ready'
        done++
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (msg === AI_CANCELLED) {
          item.state = 'idle'
          break
        }
        item.state = 'error'
        item.error = msg
        failed++
      } finally {
        run.value = null
        current.value = null
      }
    }
    return { done, failed }
  }

  /** Fertige, angehakte und noch nicht eingefügte Stellen. */
  const insertable = computed(() =>
    items.value.filter((i) => i.checked && i.state === 'ready' && i.media && !isInserted(i)),
  )

  /** Fertige Zwischenbilder über das Video legen (ein Verlaufsschritt). */
  function insert(): number {
    const list = insertable.value
    if (list.length === 0) return 0
    const placed: { item: BrollItem; clipId: string }[] = []
    const ok = timeline.apply((d) => {
      let doc = d
      placed.length = 0
      for (const item of list) {
        const media = item.media as MediaView
        const span = brollSpan(item.at, item.end)
        const r: OpResult & { clipId?: string } = insertBrollClip(
          doc,
          media.id,
          span.start,
          span.duration,
        )
        if (!r.ok) return r
        doc = r.doc
        if (r.clipId) placed.push({ item, clipId: r.clipId })
      }
      return { ok: true, doc }
    })
    if (!ok) throw new Error('Die Zwischenbilder konnten nicht eingefügt werden.')
    for (const p of placed) p.item.clipId = p.clipId
    timeline.select(placed.map((p) => p.clipId))
    return placed.length
  }

  function cancel(): void {
    stopRequested = true
    run.value?.cancel()
  }

  function clear(): void {
    if (generating.value) cancel()
    for (const i of items.value) if (i.thumb) URL.revokeObjectURL(i.thumb)
    items.value = []
  }

  return {
    items,
    current,
    progress,
    generating,
    models,
    model,
    insertable,
    isInserted,
    setSuggestions,
    update,
    loadModels,
    setModel,
    generate,
    insert,
    cancel,
    clear,
  }
})
