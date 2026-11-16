/**
 * Datenmodell des Timeline-Editors (reines TypeScript, ohne Vue).
 *
 * Grundsätze:
 *  - Nicht-destruktiv: Das Dokument beschreibt nur, *was* zu sehen/hören ist;
 *    gerechnet wird ausschließlich auf dem Server (Vorschau und Export).
 *  - Zeiten sind ganze Mikrosekunden (`Time`) – keine Rundungsdrift.
 *  - Clips einer Spur überlappen sich nicht.
 *  - Reihenfolge von `tracks` = Stapel: Index 0 liegt oben (vorne).
 */

/** Zeit bzw. Dauer in ganzen Mikrosekunden. */
export type Time = number

export const TIMELINE_DOC_VERSION = 2

export type AssetId = string

export type AssetKind = 'video' | 'audio' | 'image'

/** Verweis auf ein Medium auf dem Server. */
export interface AssetRef {
  id: AssetId
  kind: AssetKind
  name: string
  /** Länge der Quelle; `null` bei Bildern (beliebig lang verwendbar). */
  duration: Time | null
  width?: number
  height?: number
  fps?: number
  hasAudio?: boolean
}

export interface TimelineSettings {
  width: number
  height: number
  /** Projekt-Bildrate; Raster für das Einrasten auf Bilder. */
  fps: number
  /** Farbe hinter allen Spuren (CSS-Hex). */
  background: string
  sampleRate: number
}

export type TrackKind = 'video' | 'audio' | 'overlay'

interface ClipBase {
  id: string
  /** Beginn auf der Timeline. */
  start: Time
  /** Länge auf der Timeline (bei Medien-Clips: nach Tempo). */
  duration: Time
  /** Clips mit gleicher Gruppe (z. B. Bild + Ton eines Videos) bewegen sich gemeinsam. */
  linkGroup?: string
}

interface MediaClipBase extends ClipBase {
  asset: AssetId
  /** Ab hier wird die Quelle verwendet. */
  sourceIn: Time
  /** Tempo-Faktor (1 = normal, 2 = doppelt so schnell). */
  speed: number
}

/** Räumlicher Zuschnitt als Anteile [0, 1] der Quelle (wie im bisherigen Editor). */
export interface ClipCrop {
  x: number
  y: number
  width: number
  height: number
}

/** Übergänge vom vorigen Clip (wie im bisherigen Editor). */
export const CLIP_TRANSITIONS = ['fade', 'slide', 'scale', 'flip'] as const
export type ClipTransitionPreset = (typeof CLIP_TRANSITIONS)[number]

/**
 * Übergang am Anfang eines Clips. `duration` ist die Gesamtdauer: Die Hälfte
 * liegt am Anfang dieses Clips; bei `fade` (Blende über den Hintergrund)
 * blendet in der anderen Hälfte der vorige Clip aus. Die übrigen Übergänge
 * laufen über dem angehaltenen letzten Bild des vorigen Clips. Zeiten auf der
 * Timeline ändern sich nicht.
 */
export interface ClipTransition {
  preset: ClipTransitionPreset
  duration: Time
}

export interface VideoClip extends MediaClipBase {
  /** `still` = Standbild (Bild-Asset) mit frei wählbarer Dauer. */
  kind: 'video' | 'still'
  crop?: ClipCrop | null
  /** Übergang vom vorigen Clip derselben Spur (oder aus dem Hintergrund). */
  transitionIn?: ClipTransition
}

/** Kurvenformen der Ton-Blende (FFmpeg `afade curve=`, wie im bisherigen Editor). */
export const FADE_CURVES = [
  'tri',
  'exp',
  'log',
  'qsin',
  'hsin',
  'esin',
  'qua',
  'cub',
  'squ',
] as const
export type FadeCurve = (typeof FADE_CURVES)[number]

/** Ton-Blende am Anfang bzw. Ende eines Clips (Dauer auf der Timeline). */
export interface ClipFade {
  duration: Time
  curve: FadeCurve
}

export interface AudioClip extends MediaClipBase {
  kind: 'audio'
  /** Lautstärke 0–1 (und darüber für Verstärkung). */
  gain: number
  /** Ton am Clip-Anfang einblenden. */
  fadeIn?: ClipFade
  /** Ton am Clip-Ende ausblenden. */
  fadeOut?: ClipFade
}

/**
 * Text, Form/Emoji oder Bild über dem Video. Die Darstellungsdaten (`data`)
 * werden in einer späteren Phase an die bestehenden Text-/Grafik-Typen gebunden.
 */
export interface OverlayClip extends ClipBase {
  kind: 'text' | 'graphic' | 'image'
  asset?: AssetId
  data: Record<string, unknown>
}

export type Clip = VideoClip | AudioClip | OverlayClip
export type ClipKind = Clip['kind']

interface TrackBase {
  id: string
  name: string
  /** Gesperrte Spuren lehnen jede Änderung ihrer Clips ab. */
  locked: boolean
}

export interface VideoTrack extends TrackBase {
  kind: 'video'
  hidden: boolean
  clips: VideoClip[]
}

export interface AudioTrack extends TrackBase {
  kind: 'audio'
  muted: boolean
  solo: boolean
  volume: number
  clips: AudioClip[]
}

export interface OverlayTrack extends TrackBase {
  kind: 'overlay'
  hidden: boolean
  clips: OverlayClip[]
}

export type Track = VideoTrack | AudioTrack | OverlayTrack

export interface Marker {
  id: string
  at: Time
  label: string
}

export interface TimelineDoc {
  version: typeof TIMELINE_DOC_VERSION
  settings: TimelineSettings
  assets: Record<AssetId, AssetRef>
  tracks: Track[]
  markers: Marker[]
}

/** Warum ein Befehl abgelehnt wurde. */
export type OpError =
  | 'track-not-found'
  | 'clip-not-found'
  | 'asset-not-found'
  | 'asset-in-use'
  | 'track-locked'
  | 'kind-mismatch'
  | 'overlap'
  | 'invalid-time'
  | 'too-short'
  | 'out-of-source'
  | 'duplicate-id'
  | 'invalid-settings'

/** Ergebnis eines Befehls: neues Dokument oder Ablehnungsgrund (Eingabe bleibt unverändert). */
export type OpResult = { ok: true; doc: TimelineDoc } | { ok: false; error: OpError }
