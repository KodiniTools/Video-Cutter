import { speedFactor } from '@/lib/clipSpeed'
import type { MediaView } from '@/lib/mediaApi'
import { mergeTimeline } from '@/lib/mergeTimeline'
import type { ProjectItemState, ProjectState } from '@/lib/projectState'
import type { SeamPreset } from '@/stores/library'
import { assetFromMedia } from './assets'
import {
  addTrack,
  createDoc,
  createId,
  insertClip,
  insertOverlayClip,
  MIN_CLIP_DURATION,
  nextTrackName,
  normalizeCrop,
  putAsset,
  secondsToTime,
  setClipFade,
  setClipHold,
  setClipTransition,
  snapToFrame,
  type OpResult,
  type OverlayClip,
  type Time,
  type TimelineDoc,
  type TimelineSettings,
} from './model'
import { buildTimelineProject, type TimelineProjectState } from './projectFile'

/**
 * Wandelt ein Projekt der bisherigen App (Stand v1: Videoliste mit Von/Bis,
 * Tempo, Stumm, Texten und Grafiken je Video) in ein Timeline-Dokument um.
 * Das gespeicherte Projekt selbst bleibt unverändert.
 *
 *  - Videos mit Häkchen „verwenden“ liegen in Listenreihenfolge auf V1, ihr
 *    Ton verknüpft auf A1 (stumme Videos ohne Ton-Clip). Lage und Kürzung
 *    rechnet dieselbe Funktion wie beim Zusammenfügen (`mergeTimeline`).
 *  - Texte und Grafiken eines Videos werden zu Clips auf Ebenen-Spuren; ihre
 *    Zeiten (im Originalvideo) werden auf die Timeline umgerechnet.
 *  - Der Zuschnitt des markierten Videos wird zum Zuschnitt seines Clips.
 *  - Übergänge je Nahtstelle (bzw. die globale Animation) werden zum Übergang
 *    am Anfang des jeweils folgenden Clips; die Clips überlappen dabei nicht.
 *  - Eine Lücke bis zum nächsten Video (dessen „Von“ liegt später) zeigt wie
 *    bisher das letzte Bild: Der Clip davor bekommt `hold`.
 *  - Die Ton-Blende wird zur Einblendung des ersten und Ausblendung des
 *    letzten Ton-Clips.
 *  - Was der neue Editor noch nicht kann, wird ausgelassen und in `skipped`
 *    genannt.
 */

/** Was nicht übernommen werden konnte. */
export type ClassicSkip = 'music' | 'audioFade' | 'crop'

export interface ClassicConversion {
  /** Dokument mit den IDs der jetzt angemeldeten Videos; Bilder noch per Schlüssel. */
  state: TimelineProjectState
  /** Die verwendeten Videos, je ID im Dokument. */
  media: Record<string, MediaView>
  skipped: ClassicSkip[]
  /** So viele Videos des Projekts fehlten auf dem Server. */
  missingMedia: number
}

const OUTPUT_SIZES: Record<string, { width: number; height: number }> = {
  '16:9': { width: 1920, height: 1080 },
  '9:16': { width: 1080, height: 1920 },
  '1:1': { width: 1080, height: 1080 },
}

interface Placed {
  item: ProjectItemState
  view: MediaView
  /** Verwendeter Bereich der Quelle in Sekunden. */
  from: number
  to: number
  factor: number
}

function must(result: OpResult): TimelineDoc {
  if (!result.ok) throw new Error(`Umwandlung fehlgeschlagen (${result.error}).`)
  return result.doc
}

/** Ohne lokale ID und Zeiten: Die trägt im neuen Editor der Clip. */
function overlayData(o: object): Record<string, unknown> {
  const data: Record<string, unknown> = { ...o }
  delete data.id
  delete data.start
  delete data.end
  return data
}

export function convertClassicProject(
  classic: ProjectState,
  media: Readonly<Record<string, MediaView>>,
): ClassicConversion {
  const skipped = new Set<ClassicSkip>()
  let missingMedia = 0

  // Alle vorhandenen Videos anmelden (auch die ohne Häkchen: Sie bleiben in der Medienliste).
  let doc = createDoc()
  const present: { item: ProjectItemState; view: MediaView }[] = []
  for (const item of classic.items) {
    const view = media[item.media]
    if (!view) {
      missingMedia++
      continue
    }
    present.push({ item, view })
    doc = putAsset(doc, assetFromMedia(view))
  }

  const wanted = present.some((p) => p.item.include)
    ? present.filter((p) => p.item.include)
    : present
  const placed: Placed[] = wanted.flatMap(({ item, view }) => {
    const from = Math.min(Math.max(0, item.start), view.duration)
    const to = Math.min(item.end ?? view.duration, view.duration)
    const factor = speedFactor(item.speed ?? 0)
    return (to - from) / factor >= 0.05 ? [{ item, view, from, to, factor }] : []
  })

  const first = placed[0]?.view
  const settings: Partial<TimelineSettings> = {}
  const fixed = OUTPUT_SIZES[classic.output.aspect]
  if (fixed) Object.assign(settings, fixed)
  else if (first && first.width > 0 && first.height > 0) {
    settings.width = first.width
    settings.height = first.height
  }
  if (first && first.fps > 0) settings.fps = first.fps
  doc = { ...doc, settings: { ...doc.settings, ...settings } }
  const fps = doc.settings.fps

  const layout = mergeTimeline(
    placed.map((p, i) => ({
      length: (p.to - p.from) / p.factor,
      at: i === 0 ? null : (p.item.at ?? null),
    })),
    [],
    'none',
    0,
  )
  /** Übergang vor dem Clip `i`: je Nahtstelle gewählt, sonst die globale Animation. */
  const seamBefore = (i: number): SeamPreset => {
    const from = classic.items.indexOf(placed[i - 1].item)
    const to = classic.items.indexOf(placed[i].item)
    const seam = classic.seams.find((s) => s.from === from && s.to === to)
    return seam?.preset ?? (classic.anim.animation as SeamPreset)
  }
  if (classic.music) skipped.add('music')
  // Der Zuschnitt gehört zum markierten Video der Liste.
  const crop = normalizeCrop(classic.editor?.crop)
  const cropItem = classic.selected === null ? undefined : classic.items[classic.selected]
  let cropUsed = false

  if (layout && placed.length > 0) {
    const videoTrack = createId()
    doc = must(addTrack(doc, { id: videoTrack, kind: 'video', name: nextTrackName(doc, 'V') }, 0))
    let audioTrack: string | null = null
    const starts = layout.entries.map((e) => snapToFrame(secondsToTime(e.start), fps))
    const overlays: OverlayClip[] = []

    placed.forEach((p, i) => {
      const entry = layout.entries[i]
      const start = starts[i]
      const sourceIn = secondsToTime(p.from)
      const assetDuration = doc.assets[p.view.id].duration ?? 0
      let end = snapToFrame(secondsToTime(entry.start + entry.used), fps)
      if (i + 1 < starts.length) end = Math.min(end, starts[i + 1])
      // Nie über das Ende der Quelle hinaus (Rundung auf das Bildraster).
      const maxDuration = Math.floor((assetDuration - sourceIn) / p.factor)
      const duration: Time = Math.min(end - start, maxDuration)
      if (duration < MIN_CLIP_DURATION) return

      const withAudio = p.view.hasAudio && p.item.muted !== true
      const linkGroup = withAudio ? createId() : undefined
      const base = { asset: p.view.id, start, duration, sourceIn, speed: p.factor }
      const withCrop = crop !== null && p.item === cropItem
      if (withCrop) cropUsed = true
      const videoId = createId()
      doc = must(
        insertClip(doc, videoTrack, {
          ...base,
          id: videoId,
          kind: 'video',
          ...(linkGroup ? { linkGroup } : {}),
          ...(withCrop ? { crop } : {}),
        }),
      )
      // Standbild bis zum nächsten Clip (Lücke durch „Von“ des folgenden Videos).
      if (entry.hold > 0.001 && i + 1 < placed.length) doc = must(setClipHold(doc, videoId, true))
      // Übergang zur vorigen Nahtstelle. Anders als bisher überlappen die Clips
      // nicht: Die Länge bleibt, der Übergang liegt am Anfang dieses Clips.
      const preset = i > 0 ? seamBefore(i) : 'none'
      if (preset !== 'none') {
        doc = must(
          setClipTransition(doc, videoId, {
            preset,
            duration: secondsToTime(classic.anim.duration),
          }),
        )
      }
      if (withAudio) {
        if (audioTrack === null) {
          audioTrack = createId()
          doc = must(
            addTrack(
              doc,
              { id: audioTrack, kind: 'audio', name: nextTrackName(doc, 'A') },
              doc.tracks.length,
            ),
          )
        }
        doc = must(
          insertClip(doc, audioTrack, {
            ...base,
            id: createId(),
            kind: 'audio',
            gain: 1,
            linkGroup,
          }),
        )
      }

      // Texte und Grafiken: Zeit im Originalvideo -> Zeit auf der Timeline.
      const clipEnd = start + duration
      const toTimeline = (seconds: number): Time =>
        Math.min(clipEnd, Math.max(start, start + secondsToTime((seconds - p.from) / p.factor)))
      const add = (kind: 'text' | 'graphic', o: { start: number; end: number }) => {
        const s = snapToFrame(toTimeline(o.start), fps)
        const e = Math.min(clipEnd, snapToFrame(toTimeline(o.end), fps))
        if (e - s < MIN_CLIP_DURATION) return
        overlays.push({ id: createId(), kind, start: s, duration: e - s, data: overlayData(o) })
      }
      // Grafiken zuerst: Ihre Spuren liegen dann unter denen der Texte.
      for (const g of p.item.graphics) add('graphic', g)
      for (const t of p.item.texts) if (t.text.trim()) add('text', t)
    })

    for (const kind of ['graphic', 'text'] as const) {
      for (const clip of overlays) {
        if (clip.kind !== kind) continue
        doc = must(insertOverlayClip(doc, clip, nextTrackName(doc, kind === 'text' ? 'T' : 'G')))
      }
    }
  }

  if (crop !== null && !cropUsed) skipped.add('crop')

  // Die Blende galt für das ganze Ergebnis: Einblenden am ersten, Ausblenden
  // am letzten Ton-Clip.
  const { fadeIn, fadeOut } = classic.audioFade
  if (fadeIn.enabled || fadeOut.enabled) {
    const sound = doc.tracks
      .flatMap((t) => (t.kind === 'audio' ? t.clips : []))
      .sort((a, b) => a.start - b.start)
    if (sound.length === 0) skipped.add('audioFade')
    else {
      if (fadeIn.enabled) {
        const fade = { duration: secondsToTime(fadeIn.duration), curve: fadeIn.curve }
        doc = must(setClipFade(doc, sound[0].id, 'in', fade))
      }
      if (fadeOut.enabled) {
        const fade = { duration: secondsToTime(fadeOut.duration), curve: fadeOut.curve }
        doc = must(setClipFade(doc, sound[sound.length - 1].id, 'out', fade))
      }
    }
  }

  return {
    state: buildTimelineProject(doc, { ...classic.images }),
    media: Object.fromEntries(present.map((p) => [p.view.id, p.view])),
    skipped: [...skipped],
    missingMedia,
  }
}
