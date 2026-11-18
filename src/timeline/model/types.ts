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
  /**
   * An diesen Marker gebunden (wie ein Beat-Drop-Marker im Visualizer): Wird
   * der Marker verschoben, wandert der Clip mit; sein Abstand zum Marker bleibt.
   */
  marker?: string
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

/**
 * Lage eines Video-Clips im Bild (Bild-in-Bild). Fehlt sie, füllt der Clip das
 * Projektformat. `scale` ist der Anteil des Projektformats, in den das Bild
 * eingepasst wird; `x`/`y` sind die Mitte als Anteile [0, 1] (das Bild bleibt
 * dabei ganz im Projektformat); `opacity` ist die Deckkraft.
 */
export interface ClipLayout {
  x: number
  y: number
  scale: number
  opacity: number
  /**
   * Keyframes, nach Zeit aufsteigend: Mitte, Größe und Deckkraft ändern sich
   * dazwischen gleichmäßig, davor und dahinter gilt der erste bzw. letzte.
   * Die Werte oben sind dann die des ersten Keyframes.
   */
  keys?: LayoutKey[]
  /** `smooth`: Zwischen den Keyframes sanft anlaufen und abbremsen statt gleichmäßig. */
  ease?: 'smooth'
}

/**
 * Keyframe der Lage. `at` ist die Zeit in der Quelle (wie bei der
 * Lautstärke-Kurve), damit Teilen, Trimmen und Tempo nichts verschieben.
 */
export interface LayoutKey {
  at: Time
  x: number
  y: number
  scale: number
  /** Deckkraft; fehlt sie (ältere Projekte), gilt die des Clips. */
  opacity?: number
}

/**
 * Farbkorrektur eines Video-Clips. Jeder Wert liegt in [−1, 1], 0 lässt das
 * Bild unverändert. Fehlt sie, ist nichts korrigiert.
 */
export interface ClipColor {
  brightness: number
  contrast: number
  saturation: number
}

export interface VideoClip extends MediaClipBase {
  /** `still` = Standbild (Bild-Asset) mit frei wählbarer Dauer. */
  kind: 'video' | 'still'
  crop?: ClipCrop | null
  layout?: ClipLayout
  color?: ClipColor
  /** Übergang vom vorigen Clip derselben Spur (oder aus dem Hintergrund). */
  transitionIn?: ClipTransition
  /** Letztes Bild halten, bis der nächste Clip der Spur beginnt (Standbild in der Lücke). */
  hold?: boolean
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
  /**
   * Lautstärke-Kurve: Punkte nach Quellzeit aufsteigend, dazwischen linear,
   * davor und dahinter gilt der erste bzw. letzte Wert. Wirkt zusätzlich zu
   * `gain`. Die Zeiten hängen an der Quelle, damit die Kurve beim Teilen,
   * Trimmen und bei anderem Tempo an derselben Stelle des Tons bleibt.
   */
  envelope?: VolumePoint[]
}

/** Punkt einer Lautstärke-Kurve: Zeit in der Quelle und Faktor (1 = unverändert). */
export interface VolumePoint {
  at: Time
  gain: number
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
  /**
   * Automatisches Absenken (0 < duck ≤ 1): Anteil, um den die Spur leiser wird,
   * solange auf den übrigen Ton-Spuren etwas zu hören ist. Fehlt = aus.
   */
  duck?: number
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
  | 'marker-not-found'
  | 'too-many'
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
