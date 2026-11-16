import { defineStore } from 'pinia'
import { computed, ref, shallowRef } from 'vue'
import {
  AI_CANCELLED,
  fetchAiStatus,
  parseSubtitles,
  parseSuggestions,
  parseTranscript,
  parseTranslation,
  runAiJob,
  type AiRun,
  type AiStatus,
  type CutSuggestion,
  type SubtitleTarget,
  type TranscribeLanguage,
  type TranslateTarget,
} from '@/lib/aiApi'
import { sourceRangeOnTimeline } from '@/timeline/cutSuggestions'
import { findClip, type OverlayClip, type Time } from '@/timeline/model'
import { cuesToClips, subtitleStyle } from '@/timeline/subtitles'
import { findSilences, type SilenceOptions } from '@/timeline/silence'
import { useTimelineStore } from './timeline'

export type TimelineAiTask = 'transcribe' | 'subtitles' | 'translate' | 'cuts'

/** Schnittvorschlag mit Häkchen; Zeiten in Sekunden der Quelldatei. */
export interface ClipSuggestion extends CutSuggestion {
  id: number
  checked: boolean
}

/** Vorschläge für einen Clip der Timeline. */
export interface ClipSuggestions {
  clipId: string
  mediaId: string
  items: ClipSuggestion[]
}

export interface CutResult {
  /** Herausgeschnittene Bereiche. */
  cut: number
  /** Vorschläge, die nicht mehr im Clip liegen. */
  dropped: number
}

export interface SubtitleResult {
  /** Eingefügte Text-Clips. */
  added: number
  /** Untertitel, die außerhalb des Clips liegen oder zu kurz wären. */
  dropped: number
  /** Der Server hat die Liste gekürzt (Obergrenze erreicht). */
  truncated: boolean
}

export interface TranslateResult {
  translated: number
  /** Texte ohne Übersetzung (bleiben unverändert). */
  missing: number
}

/**
 * KI-Assistent des Timeline-Editors: Untertitel eines Clips als Text-Clips,
 * Übersetzen der vorhandenen Texte und Schnittvorschläge für einen Clip. Nutzt dieselben Server-Aufträge wie
 * der bisherige Editor (`/api/ai/*`). Es läuft höchstens ein Auftrag.
 */
export const useTimelineAiStore = defineStore('timelineAi', () => {
  const timeline = useTimelineStore()
  const status = ref<AiStatus | null>(null)
  const statusChecked = ref(false)
  const task = ref<TimelineAiTask | null>(null)
  const progress = ref(0)
  const run = shallowRef<AiRun<unknown> | null>(null)
  /** Für welche Medien der Server in dieser Sitzung ein Transkript hat (und in welcher Sprache). */
  const transcribed = ref<Record<string, TranscribeLanguage>>({})

  /** Schnittvorschläge für den zuletzt untersuchten Clip. */
  const suggestions = ref<ClipSuggestions | null>(null)
  let nextSuggestionId = 1

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

  async function step<T>(kind: TimelineAiTask, start: () => AiRun<T>): Promise<T> {
    task.value = kind
    progress.value = 0
    const r = start()
    run.value = r as AiRun<unknown>
    return r.promise
  }

  async function guarded<T>(work: () => Promise<T>): Promise<T> {
    if (running.value) throw new Error('Es läuft bereits ein KI-Auftrag.')
    try {
      return await work()
    } finally {
      task.value = null
      run.value = null
    }
  }

  const onProgress = (p: number) => (progress.value = p)

  async function transcribe(mediaId: string, language: TranscribeLanguage): Promise<void> {
    await step('transcribe', () =>
      runAiJob('transcribe', { mediaId, language }, parseTranscript, onProgress),
    )
    transcribed.value = { ...transcribed.value, [mediaId]: language }
  }

  /**
   * Untertitel für den Clip erzeugen und als Text-Clips einfügen (ein
   * Verlaufsschritt). Transkribiert vorher, wenn für das Medium noch kein
   * Transkript in der gewählten Sprache vorliegt.
   */
  function makeSubtitles(
    clipId: string,
    language: TranscribeLanguage,
    target: SubtitleTarget,
  ): Promise<SubtitleResult> {
    return guarded(async () => {
      const before = findClip(timeline.doc, clipId)?.clip
      if (!before || (before.kind !== 'video' && before.kind !== 'audio')) {
        throw new Error('Clip nicht gefunden.')
      }
      const mediaId = before.asset
      const result = await withTranscript(mediaId, language, () =>
        step('subtitles', () =>
          runAiJob('subtitles', { mediaId, target }, parseSubtitles, onProgress),
        ),
      )
      // Der Clip kann inzwischen verschoben, gekürzt oder gelöscht sein.
      const clip = findClip(timeline.doc, clipId)?.clip
      if (!clip || (clip.kind !== 'video' && clip.kind !== 'audio') || clip.asset !== mediaId) {
        throw new Error('Der Clip wurde inzwischen entfernt.')
      }
      const clips: OverlayClip[] = cuesToClips(
        clip,
        result.cues,
        timeline.doc.settings.fps,
        subtitleStyle(timeline.doc),
      )
      if (clips.length > 0 && !timeline.addOverlayClips(clips)) {
        throw new Error('Die Untertitel konnten nicht eingefügt werden.')
      }
      return {
        added: clips.length,
        dropped: result.cues.length - clips.length,
        truncated: result.truncated,
      }
    })
  }

  /** Auftrag mit Transkript ausführen; fehlt es (oder andere Sprache), vorher erkennen. */
  async function withTranscript<T>(
    mediaId: string,
    language: TranscribeLanguage,
    job: () => Promise<T>,
  ): Promise<T> {
    if (transcribed.value[mediaId] === language) {
      try {
        return await job()
      } catch (e) {
        if (e instanceof Error && e.message === AI_CANCELLED) throw e
        // Der Server hat das Transkript nicht mehr (z. B. Neustart): neu erkennen.
      }
    }
    await transcribe(mediaId, language)
    return job()
  }

  /** Lage eines Vorschlags auf der Timeline, solange er im Clip liegt. */
  function suggestionRange(s: CutSuggestion): { start: Time; end: Time } | null {
    const current = suggestions.value
    const clip = current ? findClip(timeline.doc, current.clipId)?.clip : undefined
    if (!clip || (clip.kind !== 'video' && clip.kind !== 'audio')) return null
    if (clip.asset !== current?.mediaId) return null
    return sourceRangeOnTimeline(clip, s, timeline.doc.settings.fps)
  }

  /**
   * Schnittvorschläge (Füllwörter, Versprecher, Wiederholungen, Pausen) für
   * den Clip holen. Behalten werden nur Vorschläge, die im verwendeten Teil
   * der Quelle liegen. Liefert ihre Anzahl.
   */
  function suggestCuts(
    clipId: string,
    language: TranscribeLanguage,
    minPause: number,
  ): Promise<number> {
    return guarded(async () => {
      const before = findClip(timeline.doc, clipId)?.clip
      if (!before || (before.kind !== 'video' && before.kind !== 'audio')) {
        throw new Error('Clip nicht gefunden.')
      }
      const mediaId = before.asset
      suggestions.value = null
      const list = await withTranscript(mediaId, language, () =>
        step('cuts', () => runAiJob('cuts', { mediaId, minPause }, parseSuggestions, onProgress)),
      )
      suggestions.value = { clipId, mediaId, items: [] }
      const items = list
        .filter((s) => suggestionRange(s) !== null)
        .map((s) => ({ ...s, id: nextSuggestionId++, checked: true }))
      suggestions.value = items.length > 0 ? { clipId, mediaId, items } : null
      return items.length
    })
  }

  /**
   * Stille im Clip als Schnittvorschläge („Pause“) eintragen – ohne Server,
   * aus der Wellenform des Mediums. Liefert ihre Anzahl.
   */
  function suggestSilence(
    clipId: string,
    peaks: Uint8Array | null | undefined,
    rate: number,
    options: SilenceOptions,
  ): number {
    if (running.value) return 0
    const clip = findClip(timeline.doc, clipId)?.clip
    if (!clip || (clip.kind !== 'video' && clip.kind !== 'audio')) return 0
    const mediaId = clip.asset
    suggestions.value = { clipId, mediaId, items: [] }
    const items = findSilences(peaks, rate, options)
      .map((r): CutSuggestion => ({ ...r, kind: 'pause', text: '', reason: '' }))
      .filter((s) => suggestionRange(s) !== null)
      .map((s) => ({ ...s, id: nextSuggestionId++, checked: true }))
    suggestions.value = items.length > 0 ? { clipId, mediaId, items } : null
    return items.length
  }

  function setSuggestionChecked(id: number, checked: boolean): void {
    const current = suggestions.value
    if (!current) return
    suggestions.value = {
      ...current,
      items: current.items.map((s) => (s.id === id ? { ...s, checked } : s)),
    }
  }

  function setAllSuggestionsChecked(checked: boolean): void {
    const current = suggestions.value
    if (!current) return
    suggestions.value = { ...current, items: current.items.map((s) => ({ ...s, checked })) }
  }

  function clearSuggestions(): void {
    suggestions.value = null
  }

  /**
   * Angehakte Vorschläge aus dem Clip herausschneiden und die Lücken schließen
   * (ein Verlaufsschritt). Danach ist die Liste leer: Der Clip besteht nun aus
   * mehreren Teilen.
   */
  function applyCuts(): CutResult {
    const current = suggestions.value
    if (!current) return { cut: 0, dropped: 0 }
    const checked = current.items.filter((s) => s.checked)
    const ranges = checked.flatMap((s) => {
      const r = suggestionRange(s)
      return r ? [r] : []
    })
    if (ranges.length > 0 && !timeline.cutClipRanges(current.clipId, ranges)) {
      throw new Error('Die Bereiche konnten nicht herausgeschnitten werden.')
    }
    suggestions.value = null
    return { cut: ranges.length, dropped: checked.length - ranges.length }
  }

  /** Text-Clips auf nicht gesperrten Spuren (in Zeitreihenfolge). */
  const textClips = computed(() =>
    timeline.doc.tracks
      .flatMap((t) => (t.kind === 'overlay' && !t.locked ? t.clips : []))
      .filter((c) => c.kind === 'text' && typeof c.data.text === 'string' && c.data.text !== '')
      .sort((a, b) => a.start - b.start),
  )

  /** Alle Texte übersetzen und ersetzen (ein Verlaufsschritt). */
  function translateTexts(target: TranslateTarget): Promise<TranslateResult> {
    return guarded(async () => {
      const list = textClips.value.map((c) => ({ id: c.id, text: c.data.text as string }))
      if (list.length === 0) return { translated: 0, missing: 0 }
      const texts = list.map((c) => c.text)
      const r = await step('translate', () =>
        runAiJob(
          'translate',
          { texts, target },
          (d) => parseTranslation(d, texts.length),
          onProgress,
        ),
      )
      // Zuordnung über die ID: Inzwischen gelöschte Texte werden übergangen.
      const patches = list
        .map((c, i) => ({ id: c.id, patch: { text: r.texts[i] } }))
        .filter((p, i) => p.patch.text.trim() !== '' && p.patch.text !== list[i].text)
      if (patches.length > 0 && !timeline.updateClipsData(patches)) {
        throw new Error('Die Texte konnten nicht ersetzt werden.')
      }
      return { translated: patches.length, missing: r.missing }
    })
  }

  function cancel(): void {
    run.value?.cancel()
  }

  return {
    status,
    statusChecked,
    task,
    progress,
    running,
    textClips,
    suggestions,
    loadStatus,
    makeSubtitles,
    suggestCuts,
    suggestSilence,
    suggestionRange,
    setSuggestionChecked,
    setAllSuggestionsChecked,
    clearSuggestions,
    applyCuts,
    translateTexts,
    cancel,
  }
})
