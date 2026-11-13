import { defineStore } from 'pinia'
import { computed, ref, shallowRef } from 'vue'
import {
  AI_CANCELLED,
  fetchAiStatus,
  parseSubtitles,
  parseSuggestions,
  parseTranscript,
  runAiJob,
  type AiRun,
  type AiStatus,
  type CutSuggestion,
  type SubtitleCue,
  type SubtitleTarget,
  type TranscribeLanguage,
  type TranscriptInfo,
} from '@/lib/aiApi'

/** Schnittvorschlag im Editor (mit lokaler ID und Auswahl). */
export interface SuggestionItem extends CutSuggestion {
  id: number
  checked: boolean
}

/** KI-Daten eines Bibliotheks-Videos. Gelten nur für genau diese Server-Datei. */
interface ItemAi {
  mediaId: string
  transcript: TranscriptInfo | null
  suggestions: SuggestionItem[]
}

export type AiTask = 'transcribe' | 'subtitles' | 'cuts'

/**
 * KI-Assistent: Transkript und Schnittvorschläge je Bibliotheks-Video
 * (Schlüssel = lokale Listen-ID). Ändert sich die Server-Datei (Schneiden,
 * Text einbrennen), sind die Daten veraltet und werden verworfen.
 * Es läuft höchstens ein KI-Auftrag gleichzeitig.
 */
export const useAiStore = defineStore('ai', () => {
  const status = ref<AiStatus | null>(null)
  /** Status konnte nicht geladen werden bzw. Backend kennt die KI nicht. */
  const statusChecked = ref(false)
  const byItem = ref<Record<number, ItemAi>>({})
  const task = ref<AiTask | null>(null)
  const taskItemId = ref<number | null>(null)
  const progress = ref(0)
  const run = shallowRef<AiRun<unknown> | null>(null)

  const running = computed(() => task.value !== null)

  async function loadStatus(): Promise<void> {
    if (statusChecked.value) return
    try {
      status.value = await fetchAiStatus()
    } catch {
      status.value = null
    } finally {
      statusChecked.value = true
    }
  }

  /** KI-Daten eines Videos – nur, wenn sie zur aktuellen Server-Datei gehören. */
  function dataFor(itemId: number, mediaId: string | null): ItemAi | null {
    const d = byItem.value[itemId]
    return d && mediaId && d.mediaId === mediaId ? d : null
  }

  function write(itemId: number, d: ItemAi): void {
    byItem.value = { ...byItem.value, [itemId]: d }
  }

  async function exec<T>(
    itemId: number,
    kind: AiTask,
    start: (onProgress: (p: number) => void) => AiRun<T>,
  ): Promise<T> {
    if (running.value) throw new Error('Es läuft bereits ein KI-Auftrag.')
    task.value = kind
    taskItemId.value = itemId
    progress.value = 0
    const r = start((p) => (progress.value = p))
    run.value = r as AiRun<unknown>
    try {
      return await r.promise
    } finally {
      task.value = null
      taskItemId.value = null
      run.value = null
    }
  }

  async function transcribe(
    itemId: number,
    mediaId: string,
    language: TranscribeLanguage,
  ): Promise<TranscriptInfo> {
    const t = await exec(itemId, 'transcribe', (p) =>
      runAiJob('transcribe', { mediaId, language }, parseTranscript, p),
    )
    // Neues Transkript -> alte Vorschläge passen nicht mehr.
    write(itemId, { mediaId, transcript: t, suggestions: [] })
    return t
  }

  function subtitles(
    itemId: number,
    mediaId: string,
    target: SubtitleTarget,
  ): Promise<{ cues: SubtitleCue[]; truncated: boolean }> {
    return exec(itemId, 'subtitles', (p) =>
      runAiJob('subtitles', { mediaId, target }, parseSubtitles, p),
    )
  }

  let nextId = 1
  async function suggestCuts(itemId: number, mediaId: string, minPause: number): Promise<void> {
    const list = await exec(itemId, 'cuts', (p) =>
      runAiJob('cuts', { mediaId, minPause }, parseSuggestions, p),
    )
    const d = dataFor(itemId, mediaId)
    if (!d) return
    write(itemId, {
      ...d,
      suggestions: list.map((s) => ({ ...s, id: nextId++, checked: true })),
    })
  }

  function setChecked(itemId: number, id: number, checked: boolean): void {
    const d = byItem.value[itemId]
    if (!d) return
    write(itemId, {
      ...d,
      suggestions: d.suggestions.map((s) => (s.id === id ? { ...s, checked } : s)),
    })
  }

  function setAllChecked(itemId: number, checked: boolean): void {
    const d = byItem.value[itemId]
    if (!d) return
    write(itemId, { ...d, suggestions: d.suggestions.map((s) => ({ ...s, checked })) })
  }

  /** Übernommene Vorschläge aus der Liste nehmen. */
  function dropSuggestions(itemId: number, ids: number[]): void {
    const d = byItem.value[itemId]
    if (!d) return
    const set = new Set(ids)
    write(itemId, { ...d, suggestions: d.suggestions.filter((s) => !set.has(s.id)) })
  }

  function cancel(): void {
    run.value?.cancel()
  }

  function clearItem(itemId: number): void {
    if (!(itemId in byItem.value)) return
    const next = { ...byItem.value }
    delete next[itemId]
    byItem.value = next
  }

  return {
    status,
    statusChecked,
    task,
    taskItemId,
    progress,
    running,
    loadStatus,
    dataFor,
    transcribe,
    subtitles,
    suggestCuts,
    setChecked,
    setAllChecked,
    dropSuggestions,
    cancel,
    clearItem,
  }
})

export { AI_CANCELLED }
