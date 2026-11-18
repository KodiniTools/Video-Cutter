import { defineStore } from 'pinia'
import { computed, ref, shallowRef } from 'vue'
import {
  AI_CANCELLED,
  fetchAiStatus,
  parseBrollSuggestions,
  parseHighlights,
  parsePublishTexts,
  parseSubtitles,
  parseSuggestions,
  parseTranscript,
  parseTranslation,
  runAiJob,
  type AiRun,
  type AiStatus,
  type BrollMode,
  type BrollSuggestion,
  type ImageStyle,
  type CutSuggestion,
  type Highlight,
  type PublishTexts,
  type SubtitleTarget,
  type TranscribeLanguage,
  type TranslateTarget,
} from '@/lib/aiApi'
import { mergeRanges, sourceRangeOnTimeline, type TimeRange } from '@/timeline/cutSuggestions'
import { buildShortDoc, gapsBetween, type ShortFormat } from '@/timeline/highlights'
import {
  findClip,
  linkGroupIds,
  MICROS_PER_SECOND,
  type OverlayClip,
  type Time,
  timeToSeconds,
} from '@/timeline/model'
import { cuesToClips, subtitleStyle } from '@/timeline/subtitles'
import { useTextDefaultStore } from './textDefault'
import { findSilences, type SilenceOptions } from '@/timeline/silence'
import {
  applyChapterMarkers,
  MAX_PUBLISH_MEDIA,
  segmentMedia,
  speechSegments,
  type ChapterMarkerResult,
} from '@/timeline/publish'
import { useTimelineStore } from './timeline'

export type TimelineAiTask =
  'transcribe' | 'subtitles' | 'translate' | 'cuts' | 'highlights' | 'publish' | 'broll'

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

/** Schnittvorschlag mit seiner Lage auf der Timeline (für Markierung und Probehören). */
export interface SuggestionMark {
  id: number
  kind: CutSuggestion['kind']
  checked: boolean
  start: Time
  end: Time
}

/** Von Claude ausgewählte Stelle mit Häkchen; Zeiten in Sekunden der Quelldatei. */
export interface ClipHighlight extends Highlight {
  id: number
  checked: boolean
}

/** Highlights für einen Clip der Timeline. */
export interface ClipHighlights {
  clipId: string
  mediaId: string
  items: ClipHighlight[]
}

/** Probehören bzw. Ansehen: übersprungene Bereiche + Halt an `stopAt`. */
export interface Audition {
  /** Vorschlag bzw. Highlight; `ALL_HIGHLIGHTS` = alle angehakten Highlights. */
  id: number
  skip: TimeRange[]
  stopAt: Time
}

/** Kennung beim Ansehen aller angehakten Highlights hintereinander. */
export const ALL_HIGHLIGHTS = -1

/** Fehler-Kennungen beim Erzeugen von Titel/Beschreibung (Text kommt aus i18n). */
export const NO_SPEECH = 'NO_SPEECH'
export const TOO_MANY_MEDIA = 'TOO_MANY_MEDIA'

/** So viel wird beim Probehören eines Vorschlags davor und danach abgespielt. */
export const AUDITION_LEAD: Time = 2 * MICROS_PER_SECOND

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
        subtitleStyle(timeline.doc, useTextDefaultStore().value),
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

  /** Alle Vorschläge einer Art an- bzw. abhaken (z. B. nur Füllwörter). */
  function setKindChecked(kind: CutSuggestion['kind'], checked: boolean): void {
    const current = suggestions.value
    if (!current) return
    suggestions.value = {
      ...current,
      items: current.items.map((s) => (s.kind === kind ? { ...s, checked } : s)),
    }
  }

  /**
   * Vorschläge mit ihrer Lage auf der Timeline und die Clips, auf denen sie
   * markiert werden (der untersuchte Clip und sein verknüpfter Partner).
   */
  const marks = computed<{ clipIds: string[]; items: SuggestionMark[] }>(() => {
    const current = suggestions.value
    if (!current) return { clipIds: [], items: [] }
    const items = current.items.flatMap((s) => {
      const r = suggestionRange(s)
      return r ? [{ id: s.id, kind: s.kind, checked: s.checked, start: r.start, end: r.end }] : []
    })
    const ids = linkGroupIds(timeline.doc, current.clipId)
    return { clipIds: ids.length ? ids : [current.clipId], items }
  })

  // --- Probehören ---------------------------------------------------------------

  /** Beim Abspielen die angehakten Stellen überspringen (so klingt es geschnitten). */
  const skipChecked = ref(false)
  /** Probehören eines einzelnen Vorschlags: übersprungener Bereich + Halt danach. */
  const audition = ref<Audition | null>(null)

  /** Bereiche, die die Vorschau beim Abspielen überspringt (sortiert, zusammengefasst). */
  const skipRanges = computed<TimeRange[]>(() => {
    if (audition.value) return audition.value.skip
    if (!skipChecked.value) return []
    return mergeRanges(marks.value.items.filter((m) => m.checked))
  })

  /**
   * Einen Vorschlag probehören: ab kurz davor abspielen, den Bereich
   * überspringen und kurz danach anhalten. Liefert false, wenn er nicht mehr
   * im Clip liegt.
   */
  function auditionSuggestion(id: number): boolean {
    const m = marks.value.items.find((s) => s.id === id)
    if (!m) return false
    timeline.playing = false
    audition.value = {
      id,
      skip: [{ start: m.start, end: m.end }],
      stopAt: Math.min(timeline.duration, m.end + AUDITION_LEAD),
    }
    timeline.seek(Math.max(0, m.start - AUDITION_LEAD))
    timeline.playing = true
    return true
  }

  function endAudition(): void {
    audition.value = null
  }

  function setAllSuggestionsChecked(checked: boolean): void {
    const current = suggestions.value
    if (!current) return
    suggestions.value = { ...current, items: current.items.map((s) => ({ ...s, checked })) }
  }

  function clearSuggestions(): void {
    suggestions.value = null
    audition.value = null
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
    audition.value = null
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

  // --- Highlights (kurzer Clip) ---------------------------------------------------

  /** Highlights für den zuletzt untersuchten Clip. */
  const highlights = ref<ClipHighlights | null>(null)

  /** Lage eines Highlights auf der Timeline, solange es im Clip liegt. */
  function highlightRange(h: Highlight): { start: Time; end: Time } | null {
    const current = highlights.value
    const clip = current ? findClip(timeline.doc, current.clipId)?.clip : undefined
    if (!clip || (clip.kind !== 'video' && clip.kind !== 'audio')) return null
    if (clip.asset !== current?.mediaId) return null
    return sourceRangeOnTimeline(clip, h, timeline.doc.settings.fps)
  }

  /**
   * Die besten Stellen des Clips für einen Short von etwa `target` Sekunden
   * holen (nur aus dem verwendeten Teil der Quelle). Liefert ihre Anzahl.
   */
  function suggestHighlights(
    clipId: string,
    language: TranscribeLanguage,
    target: number,
  ): Promise<number> {
    return guarded(async () => {
      const before = findClip(timeline.doc, clipId)?.clip
      if (!before || (before.kind !== 'video' && before.kind !== 'audio')) {
        throw new Error('Clip nicht gefunden.')
      }
      const mediaId = before.asset
      const from = timeToSeconds(before.sourceIn)
      const to = timeToSeconds(before.sourceIn + Math.round(before.duration * before.speed))
      highlights.value = null
      const list = await withTranscript(mediaId, language, () =>
        step('highlights', () =>
          runAiJob('highlights', { mediaId, target, from, to }, parseHighlights, onProgress),
        ),
      )
      highlights.value = { clipId, mediaId, items: [] }
      const items = list
        .filter((h) => highlightRange(h) !== null)
        .map((h) => ({ ...h, id: nextSuggestionId++, checked: true }))
      highlights.value = items.length > 0 ? { clipId, mediaId, items } : null
      return items.length
    })
  }

  function setHighlightChecked(id: number, checked: boolean): void {
    const current = highlights.value
    if (!current) return
    highlights.value = {
      ...current,
      items: current.items.map((h) => (h.id === id ? { ...h, checked } : h)),
    }
  }

  function setAllHighlightsChecked(checked: boolean): void {
    const current = highlights.value
    if (!current) return
    highlights.value = { ...current, items: current.items.map((h) => ({ ...h, checked })) }
  }

  /** Angehakte Highlights mit ihrer Lage auf der Timeline (chronologisch). */
  const checkedHighlightRanges = computed<TimeRange[]>(() =>
    (highlights.value?.items ?? []).flatMap((h) => {
      if (!h.checked) return []
      const r = highlightRange(h)
      return r ? [r] : []
    }),
  )

  /** Highlights mit ihrer Lage auf der Timeline und die Clips, auf denen sie markiert werden. */
  const highlightMarks = computed<{
    clipIds: string[]
    items: { id: number; title: string; checked: boolean; start: Time; end: Time }[]
  }>(() => {
    const current = highlights.value
    if (!current) return { clipIds: [], items: [] }
    const items = current.items.flatMap((h) => {
      const r = highlightRange(h)
      return r ? [{ id: h.id, title: h.title, checked: h.checked, start: r.start, end: r.end }] : []
    })
    const ids = linkGroupIds(timeline.doc, current.clipId)
    return { clipIds: ids.length ? ids : [current.clipId], items }
  })

  /** Ein Highlight ansehen: von seinem Anfang bis zu seinem Ende. */
  function playHighlight(id: number): boolean {
    const h = highlights.value?.items.find((x) => x.id === id)
    const r = h ? highlightRange(h) : null
    if (!r) return false
    return playRanges(id, [r])
  }

  /** Alle angehakten Highlights hintereinander ansehen (so wirkt der Short). */
  function playAllHighlights(): boolean {
    return playRanges(ALL_HIGHLIGHTS, checkedHighlightRanges.value)
  }

  function playRanges(id: number, ranges: TimeRange[]): boolean {
    const merged = mergeRanges(ranges)
    if (merged.length === 0) return false
    timeline.playing = false
    audition.value = { id, skip: gapsBetween(merged), stopAt: merged[merged.length - 1].end }
    timeline.seek(merged[0].start)
    timeline.playing = true
    return true
  }

  function clearHighlights(): void {
    highlights.value = null
    audition.value = null
  }

  /**
   * Angehakte Highlights als Short übernehmen: Die Timeline wird durch die
   * Stellen hintereinander ersetzt (ein Verlaufsschritt, Rückgängig holt die
   * alte Timeline zurück). Liefert die Zahl der Stellen.
   */
  function applyHighlights(format: ShortFormat): number {
    const current = highlights.value
    if (!current) return 0
    const ranges = current.items.filter((h) => h.checked && highlightRange(h) !== null)
    if (ranges.length === 0) return 0
    timeline.playing = false
    if (!timeline.apply((d) => buildShortDoc(d, current.clipId, ranges, format))) {
      throw new Error('Der kurze Clip konnte nicht erstellt werden.')
    }
    highlights.value = null
    suggestions.value = null
    audition.value = null
    // Die erste Stelle markieren: So bleibt der KI-Assistent für den Short offen.
    const first = timeline.doc.tracks.find((t) => t.kind === 'video')?.clips[0]
    timeline.select(first ? linkGroupIds(timeline.doc, first.id) : [])
    timeline.seek(0)
    return ranges.length
  }

  // --- Titel, Beschreibung, Hashtags und Kapitel ---------------------------------

  /** Zuletzt erzeugte Texte für das ganze Video (bis zum nächsten Erzeugen). */
  const publish = ref<PublishTexts | null>(null)

  /**
   * Titel, Beschreibung, Hashtags und Kapitel für die ganze Timeline erzeugen.
   * Transkribiert vorher jedes gesprochene Medium, für das noch kein
   * Transkript in der gewählten Sprache vorliegt.
   */
  function suggestPublish(
    language: TranscribeLanguage,
    target: SubtitleTarget,
  ): Promise<PublishTexts> {
    return guarded(async () => {
      const segments = speechSegments(timeline.doc)
      if (segments.length === 0) throw new Error(NO_SPEECH)
      const media = segmentMedia(segments)
      if (media.length > MAX_PUBLISH_MEDIA) throw new Error(TOO_MANY_MEDIA)
      const duration = timeToSeconds(timeline.duration)
      const job = () =>
        step('publish', () =>
          runAiJob('publish', { segments, target, duration }, parsePublishTexts, onProgress),
        )
      const missing = media.filter((id) => transcribed.value[id] !== language)
      for (const id of missing) await transcribe(id, language)
      let result: PublishTexts
      try {
        result = await job()
      } catch (e) {
        // Fehlt dem Server ein schon bekanntes Transkript (z. B. Neustart), neu erkennen.
        if ((e instanceof Error && e.message === AI_CANCELLED) || missing.length === media.length) {
          throw e
        }
        for (const id of media) if (!missing.includes(id)) await transcribe(id, language)
        result = await job()
      }
      publish.value = result
      return result
    })
  }

  /**
   * Gesprochenes aller Medien der Timeline transkribieren (soweit nötig) und
   * danach `job` ausführen. Fehlt dem Server ein schon bekanntes Transkript
   * (z. B. nach einem Neustart), wird neu erkannt und einmal wiederholt.
   */
  async function withSpeech<T>(
    language: TranscribeLanguage,
    job: (segments: ReturnType<typeof speechSegments>, duration: number) => Promise<T>,
  ): Promise<T> {
    const segments = speechSegments(timeline.doc)
    if (segments.length === 0) throw new Error(NO_SPEECH)
    const media = segmentMedia(segments)
    if (media.length > MAX_PUBLISH_MEDIA) throw new Error(TOO_MANY_MEDIA)
    const duration = timeToSeconds(timeline.duration)
    const missing = media.filter((id) => transcribed.value[id] !== language)
    for (const id of missing) await transcribe(id, language)
    try {
      return await job(segments, duration)
    } catch (e) {
      if ((e instanceof Error && e.message === AI_CANCELLED) || missing.length === media.length) {
        throw e
      }
      for (const id of media) if (!missing.includes(id)) await transcribe(id, language)
      return job(segments, duration)
    }
  }

  /**
   * Zwischenbilder (B-Roll) für die ganze Timeline vorschlagen lassen: Claude
   * sucht Stellen im Gesprochenen und schreibt je Stelle einen Prompt.
   */
  function suggestBroll(
    language: TranscribeLanguage,
    opts: { mode: BrollMode; style: ImageStyle; count: number; promptLanguage: 'de' | 'en' },
  ): Promise<BrollSuggestion[]> {
    return guarded(() =>
      withSpeech(language, (segments, duration) =>
        step('broll', () =>
          runAiJob(
            'broll',
            {
              segments,
              duration,
              mode: opts.mode,
              style: opts.style,
              count: opts.count,
              language: opts.promptLanguage,
              width: timeline.doc.settings.width,
              height: timeline.doc.settings.height,
            },
            parseBrollSuggestions,
            onProgress,
          ),
        ),
      ),
    )
  }

  /** Kapitel als Marker übernehmen (ein Verlaufsschritt). */
  function applyChapters(
    chapters: PublishTexts['chapters'],
    replace: boolean,
  ): ChapterMarkerResult {
    let info: ChapterMarkerResult = { added: 0, renamed: 0, removed: 0 }
    const ok = timeline.apply((d) => {
      const r = applyChapterMarkers(d, chapters, replace)
      if (r.ok && r.info) info = r.info
      return r
    })
    if (!ok) throw new Error('Die Kapitel konnten nicht als Marker gesetzt werden.')
    return info
  }

  function clearPublish(): void {
    publish.value = null
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
    setKindChecked,
    marks,
    skipChecked,
    audition,
    skipRanges,
    auditionSuggestion,
    endAudition,
    clearSuggestions,
    applyCuts,
    highlights,
    highlightRange,
    suggestHighlights,
    setHighlightChecked,
    setAllHighlightsChecked,
    checkedHighlightRanges,
    highlightMarks,
    playHighlight,
    playAllHighlights,
    clearHighlights,
    applyHighlights,
    publish,
    suggestPublish,
    applyChapters,
    clearPublish,
    suggestBroll,
    translateTexts,
    cancel,
  }
})
