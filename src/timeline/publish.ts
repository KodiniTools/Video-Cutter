import type { PublishChapter, PublishSegment } from '@/lib/aiApi'
import { chapterTime } from './markers'
import {
  addMarker,
  isMusicTrack,
  markerClipIds,
  MAX_MARKERS,
  removeMarker,
  secondsToTime,
  snapToFrame,
  timeToSeconds,
  updateMarker,
  type AudioClip,
  type OpResult,
  type TimelineDoc,
} from './model'

/**
 * Titel, Beschreibung, Hashtags und Kapitel für das ganze Video: Welche Teile
 * der Timeline gesprochen werden, wie Kapitel zu Markern werden und wie der
 * Text für die Videobeschreibung aussieht. Reines TypeScript, ohne Vue.
 */

/** So viele verschiedene Medien werden höchstens transkribiert. */
export const MAX_PUBLISH_MEDIA = 10

/**
 * Hörbare Ton-Clips, aus denen Claude das Video kennenlernt: die Ton-Clips der
 * Videos auf nicht stummen Spuren. Gibt es keine (z. B. ein reines
 * Ton-Projekt), zählen die Tondateien auf nicht stummen Spuren. Musik neben
 * Videos bleibt so außen vor.
 */
export function speechClips(doc: TimelineDoc): AudioClip[] {
  const audible = doc.tracks.flatMap((t) =>
    t.kind === 'audio' && !t.muted
      ? t.clips
          .filter((c) => doc.assets[c.asset]?.hasAudio !== false)
          .map((c) => ({ clip: c, music: isMusicTrack(doc, t) }))
      : [],
  )
  const speech = audible.filter((c) => !c.music && doc.assets[c.clip.asset]?.kind === 'video')
  const pick = speech.length > 0 ? speech : audible
  return pick.map((c) => c.clip).sort((a, b) => a.start - b.start)
}

/** Abschnitte für `/api/ai/publish` (Sekunden). */
export function speechSegments(doc: TimelineDoc): PublishSegment[] {
  return speechClips(doc).map((c) => ({
    mediaId: c.asset,
    from: timeToSeconds(c.sourceIn),
    to: timeToSeconds(c.sourceIn + Math.round(c.duration * c.speed)),
    at: timeToSeconds(c.start),
    speed: c.speed,
  }))
}

/** Verschiedene Medien der Abschnitte (Reihenfolge des ersten Auftretens). */
export function segmentMedia(segments: readonly PublishSegment[]): string[] {
  return [...new Set(segments.map((s) => s.mediaId))]
}

export interface ChapterMarkerResult {
  /** Neu gesetzte Marker. */
  added: number
  /** Vorhandene Marker an derselben Stelle, die den Kapitelnamen bekommen haben. */
  renamed: number
  /** Entfernte bisherige Kapitel-Marker. */
  removed: number
}

/**
 * Bisherige Kapitel-Marker, die beim Ersetzen weichen dürfen: keine
 * Takt-Marker, kein Drop-Effekt, keine daran gebundenen Clips.
 */
export function replaceableChapterMarkers(doc: TimelineDoc): string[] {
  return doc.markers
    .filter((m) => !m.beat && !m.effect && markerClipIds(doc, m.id).length === 0)
    .map((m) => m.id)
}

/**
 * Kapitel als Marker setzen (aufs Bildraster gerundet). `replace` entfernt
 * vorher die bisherigen Kapitel-Marker ohne Effekt und gebundene Clips. Liegt
 * an der Stelle schon ein Marker, bekommt er den Kapitelnamen; ist es ein
 * Takt-Marker, rückt das Kapitel ein Bild weiter, damit es als Kapitel zählt.
 */
export function applyChapterMarkers(
  doc: TimelineDoc,
  chapters: readonly PublishChapter[],
  replace: boolean,
): OpResult & { info?: ChapterMarkerResult } {
  const fps = doc.settings.fps
  const frame = Math.round(1_000_000 / fps)
  let next = doc
  let removed = 0
  if (replace) {
    for (const id of replaceableChapterMarkers(doc)) {
      const r = removeMarker(next, id)
      if (!r.ok) return r
      next = r.doc
      removed++
    }
  }
  let added = 0
  let renamed = 0
  for (const c of chapters) {
    let at = snapToFrame(secondsToTime(Math.max(0, c.at)), fps)
    let existing = next.markers.find((m) => m.at === at)
    while (existing?.beat) {
      at += frame
      existing = next.markers.find((m) => m.at === at)
    }
    if (existing) {
      if (existing.label === c.title) continue
      const r = updateMarker(next, existing.id, { label: c.title })
      if (!r.ok) return r
      next = r.doc
      renamed++
      continue
    }
    if (next.markers.length >= MAX_MARKERS) break
    const r = addMarker(next, { at, label: c.title })
    if (!r.ok) return r
    next = r.doc
    added++
  }
  return { ok: true, doc: next, info: { added, renamed, removed } }
}

/** Kapitelliste („0:00 Name“) aus den Kapiteln der KI. */
export function chapterLines(chapters: readonly PublishChapter[]): string {
  return chapters
    .slice()
    .sort((a, b) => a.at - b.at)
    .map((c) => `${chapterTime(secondsToTime(c.at))} ${c.title}`)
    .join('\n')
}

/**
 * Text für die Videobeschreibung: Beschreibung, Kapitelliste und Hashtags,
 * durch Leerzeilen getrennt; leere Teile fallen weg.
 */
export function descriptionText(
  description: string,
  chapters: readonly PublishChapter[],
  hashtags: readonly string[],
): string {
  return [description.trim(), chapterLines(chapters), hashtags.join(' ')]
    .filter((p) => p !== '')
    .join('\n\n')
}
