import { defineStore } from 'pinia'
import { computed, ref, shallowRef } from 'vue'
import {
  AI_CANCELLED,
  fetchAiStatus,
  parseSubtitles,
  parseTranscript,
  parseTranslation,
  runAiJob,
  type AiRun,
  type AiStatus,
  type SubtitleTarget,
  type TranscribeLanguage,
  type TranslateTarget,
} from '@/lib/aiApi'
import { findClip, type OverlayClip } from '@/timeline/model'
import { cuesToClips, subtitleStyle } from '@/timeline/subtitles'
import { useTimelineStore } from './timeline'

export type TimelineAiTask = 'transcribe' | 'subtitles' | 'translate'

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
 * KI-Assistent des Timeline-Editors: Untertitel eines Clips als Text-Clips
 * und Übersetzen der vorhandenen Texte. Nutzt dieselben Server-Aufträge wie
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
      const subtitles = () =>
        step('subtitles', () =>
          runAiJob('subtitles', { mediaId, target }, parseSubtitles, onProgress),
        )
      let result: Awaited<ReturnType<typeof subtitles>>
      if (transcribed.value[mediaId] === language) {
        try {
          result = await subtitles()
        } catch (e) {
          if (e instanceof Error && e.message === AI_CANCELLED) throw e
          // Der Server hat das Transkript nicht mehr (z. B. Neustart): neu erkennen.
          await transcribe(mediaId, language)
          result = await subtitles()
        }
      } else {
        await transcribe(mediaId, language)
        result = await subtitles()
      }
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
    loadStatus,
    makeSubtitles,
    translateTexts,
    cancel,
  }
})
