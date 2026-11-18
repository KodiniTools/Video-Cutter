import { API_BASE } from './apiBase'
import { fallbackErrorMessage, retryAfterOf } from './httpError'
import { parseMediaView, type MediaView } from './mediaApi'

/**
 * Client für die KI-Funktionen des Servers (`/api/ai/*`): Transkription
 * (whisper.cpp), Untertitel und Schnittvorschläge (Claude). Jeder Aufruf
 * startet einen Job; Fortschritt und Ergebnis kommen per SSE.
 */

/** Fehler-Kennung: Das Backend kennt die KI-Funktionen noch nicht (veraltet). */
export const AI_UNSUPPORTED = 'AI_UNSUPPORTED'
/** Fehler-Kennung: Job vom Nutzer abgebrochen. */
export const AI_CANCELLED = 'AI_CANCELLED'

/**
 * Sprachen für „Sprache erkennen“ (Whisper-Kürzel, wie
 * server/src/lib/whisper.ts TRANSCRIBE_LANGUAGES). Reihenfolge = Auswahlliste.
 */
export const TRANSCRIBE_LANGUAGES = [
  'auto',
  'de',
  'en',
  'hr',
  'bs',
  'sr',
  'sl',
  'it',
  'fr',
  'es',
  'pt',
  'nl',
  'pl',
  'cs',
  'sk',
  'hu',
  'ro',
  'tr',
  'ru',
  'uk',
] as const
export type TranscribeLanguage = (typeof TRANSCRIBE_LANGUAGES)[number]
export type SubtitleTarget = 'original' | 'de' | 'en'
export type TranslateTarget = 'en' | 'de'
export type CutKind = 'filler' | 'slip' | 'repeat' | 'pause'

export interface AiStatus {
  transcribe: boolean
  claude: boolean
  /** Bilderzeugung (Gemini) für Bild-Clips eingerichtet? */
  image: boolean
}

export interface TranscriptInfo {
  language: string
  words: number
  text: string
}

export interface SubtitleCue {
  start: number
  end: number
  text: string
}

export interface CutSuggestion {
  start: number
  end: number
  kind: CutKind
  text: string
  reason: string
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** Status aus /api/health; `null` = Backend kennt die KI noch nicht (veraltet). */
export function parseAiStatus(data: unknown): AiStatus | null {
  if (!isRecord(data) || !isRecord(data.ai)) return null
  return {
    transcribe: data.ai.transcribe === true,
    claude: data.ai.claude === true,
    image: data.ai.image === true,
  }
}

export function parseTranscript(data: unknown): TranscriptInfo {
  const d = isRecord(data) ? data : {}
  return {
    language: typeof d.language === 'string' ? d.language : '',
    words: finite(d.words) ? d.words : 0,
    text: typeof d.text === 'string' ? d.text : '',
  }
}

export function parseSubtitles(data: unknown): { cues: SubtitleCue[]; truncated: boolean } {
  const d = isRecord(data) ? data : {}
  const list = Array.isArray(d.cues) ? d.cues : []
  const cues = list
    .filter(isRecord)
    .filter(
      (c) => finite(c.start) && finite(c.end) && c.end > c.start && typeof c.text === 'string',
    )
    .map((c) => ({ start: c.start as number, end: c.end as number, text: c.text as string }))
  return { cues, truncated: d.truncated === true }
}

/**
 * Übersetzungen: gleich viele Texte wie geschickt, sonst ungültig (die
 * Zuordnung zu den Einblendungen läuft über die Reihenfolge).
 */
export function parseTranslation(
  data: unknown,
  expected: number,
): { texts: string[]; missing: number } {
  const d = isRecord(data) ? data : {}
  const list = Array.isArray(d.texts) ? d.texts : []
  if (list.length !== expected || !list.every((t) => typeof t === 'string')) {
    throw new Error('Ungültiges Ergebnis der Übersetzung.')
  }
  return { texts: list as string[], missing: finite(d.missing) ? d.missing : 0 }
}

const KINDS: readonly CutKind[] = ['filler', 'slip', 'repeat', 'pause']

export function parseSuggestions(data: unknown): CutSuggestion[] {
  const d = isRecord(data) ? data : {}
  const list = Array.isArray(d.suggestions) ? d.suggestions : []
  return list
    .filter(isRecord)
    .filter((s) => finite(s.start) && finite(s.end) && s.end > s.start)
    .map((s) => ({
      start: s.start as number,
      end: s.end as number,
      kind: KINDS.includes(s.kind as CutKind) ? (s.kind as CutKind) : 'filler',
      text: typeof s.text === 'string' ? s.text : '',
      reason: typeof s.reason === 'string' ? s.reason : '',
    }))
}

// --- Highlights für einen Short ----------------------------------------------------

/** Ziel-Länge eines Shorts in Sekunden (wie server/src/lib/claude.ts). */
export const MIN_HIGHLIGHT_TARGET = 15
export const MAX_HIGHLIGHT_TARGET = 90
export const DEFAULT_HIGHLIGHT_TARGET = 45

/** Von Claude ausgewählte Stelle für einen Short; Zeiten in Sekunden der Quelle. */
export interface Highlight {
  start: number
  end: number
  title: string
  reason: string
  /** 1–10, 10 = stärkste Stelle. */
  score: number
}

export function parseHighlights(data: unknown): Highlight[] {
  const d = isRecord(data) ? data : {}
  const list = Array.isArray(d.highlights) ? d.highlights : []
  return list
    .filter(isRecord)
    .filter((h) => finite(h.start) && finite(h.end) && h.end > h.start)
    .map((h) => ({
      start: h.start as number,
      end: h.end as number,
      title: typeof h.title === 'string' ? h.title : '',
      reason: typeof h.reason === 'string' ? h.reason : '',
      score: finite(h.score) ? Math.min(10, Math.max(1, Math.round(h.score))) : 5,
    }))
    .sort((a, b) => a.start - b.start)
}

// --- Titel, Beschreibung, Hashtags und Kapitel -------------------------------------

/**
 * Ton-Abschnitt der Timeline für `/api/ai/publish`: Quelle von `from` bis `to`
 * (Sekunden der Quelle) liegt ab `at` (Sekunden der Timeline) mit Tempo `speed`.
 */
export interface PublishSegment {
  mediaId: string
  from: number
  to: number
  at: number
  speed: number
}

/** Kapitel; `at` in Sekunden der Timeline. */
export interface PublishChapter {
  at: number
  title: string
}

export interface PublishTexts {
  titles: string[]
  description: string
  /** Mit führendem „#“. */
  hashtags: string[]
  chapters: PublishChapter[]
}

export function parsePublishTexts(data: unknown): PublishTexts {
  const d = isRecord(data) ? data : {}
  const strings = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : []
  const chapters = (Array.isArray(d.chapters) ? d.chapters : [])
    .filter(isRecord)
    .filter((c) => finite(c.at) && c.at >= 0)
    .map((c) => ({ at: c.at as number, title: typeof c.title === 'string' ? c.title : '' }))
    .sort((a, b) => a.at - b.at)
  return {
    titles: strings(d.titles),
    description: typeof d.description === 'string' ? d.description : '',
    hashtags: strings(d.hashtags).map((h) => (h.startsWith('#') ? h : `#${h}`)),
    chapters,
  }
}

// --- Zwischenbilder (B-Roll) -------------------------------------------------------

export type BrollKind = 'image' | 'video'
/** Welche Art Claude vorschlagen darf (`auto` = Claude entscheidet je Stelle). */
export const BROLL_MODES = ['auto', 'image', 'video'] as const
export type BrollMode = (typeof BROLL_MODES)[number]
export const MAX_BROLLS = 12
export const DEFAULT_BROLLS = 5

/** Vorgeschlagene Stelle; `at`/`end` in Sekunden der Timeline. */
export interface BrollSuggestion {
  at: number
  end: number
  kind: BrollKind
  title: string
  reason: string
  prompt: string
}

export function parseBrollSuggestions(data: unknown): BrollSuggestion[] {
  const d = isRecord(data) ? data : {}
  const list = Array.isArray(d.suggestions) ? d.suggestions : []
  const text = (v: unknown) => (typeof v === 'string' ? v : '')
  return list
    .filter(isRecord)
    .filter((s) => finite(s.at) && finite(s.end) && s.at >= 0 && s.end > s.at)
    .filter((s) => typeof s.prompt === 'string' && s.prompt.trim() !== '')
    .map((s) => ({
      at: s.at as number,
      end: s.end as number,
      kind: s.kind === 'video' ? ('video' as const) : ('image' as const),
      title: text(s.title),
      reason: text(s.reason),
      prompt: (s.prompt as string).trim(),
    }))
    .sort((a, b) => a.at - b.at)
}

// --- KI-Bilder für Bild-Clips ----------------------------------------------------

/** Stilvorlagen (wie server/src/lib/claude.ts IMAGE_STYLES). */
export const IMAGE_STYLES = [
  'auto',
  'photo',
  'illustration',
  'minimal',
  'gradient',
  'cinematic',
  '3d',
] as const
export type ImageStyle = (typeof IMAGE_STYLES)[number]

export const MAX_IMAGE_IDEA = 500
export const MAX_IMAGE_PROMPT = 2000
export const MIN_IMAGE_COUNT = 1
export const MAX_IMAGE_COUNT = 4

export interface GeneratedImageRef {
  id: string
  mime: string
}

export function parseImagePrompt(data: unknown): string {
  const p = isRecord(data) && typeof data.prompt === 'string' ? data.prompt.trim() : ''
  if (!p) throw new Error('Ungültiges Ergebnis (kein Prompt).')
  return p
}

export function parseGeneratedImages(data: unknown): {
  images: GeneratedImageRef[]
  failed: number
  /** In der Galerie gespeicherte Bilder; `null` = Backend ohne Galerie. */
  saved: number | null
  galleryError: string
  /** Verwendetes Gemini-Modell ('' = Backend meldet es nicht). */
  model: string
} {
  const d = isRecord(data) ? data : {}
  const list = Array.isArray(d.images) ? d.images : []
  const images = list
    .filter(isRecord)
    .filter((i) => typeof i.id === 'string' && i.id !== '')
    .map((i) => ({ id: i.id as string, mime: typeof i.mime === 'string' ? i.mime : 'image/png' }))
  if (images.length === 0) throw new Error('Ungültiges Ergebnis (keine Bilder).')
  return {
    images,
    failed: finite(d.failed) ? d.failed : 0,
    saved: finite(d.saved) ? d.saved : null,
    galleryError: typeof d.galleryError === 'string' ? d.galleryError : '',
    model: typeof d.model === 'string' ? d.model : '',
  }
}

// --- Modellauswahl -------------------------------------------------------------------

export interface ModelChoices {
  /** Voreinstellung des Servers. */
  default: string
  models: string[]
}

export interface AiModels {
  image: ModelChoices
  video: ModelChoices
}

function parseChoices(v: unknown): ModelChoices {
  const d = isRecord(v) ? v : {}
  const models = (Array.isArray(d.models) ? d.models : []).filter(
    (m): m is string => typeof m === 'string' && m !== '',
  )
  const def = typeof d.default === 'string' && d.default ? d.default : (models[0] ?? '')
  return { default: def, models: def && !models.includes(def) ? [def, ...models] : models }
}

export function parseAiModels(data: unknown): AiModels {
  const d = isRecord(data) ? data : {}
  return { image: parseChoices(d.image), video: parseChoices(d.video) }
}

/** Wählbare Gemini-Modelle; `null` = Backend kennt die Auswahl noch nicht. */
export async function fetchAiModels(): Promise<AiModels | null> {
  const res = await fetch(`${API_BASE}/api/ai/models`)
  if (res.status === 404) return null
  if (!res.ok) throw await readError(res)
  return parseAiModels(await res.json())
}

/** Lädt ein erzeugtes Bild als Datei (für Vorschau und Bild-Clip). */
export async function fetchGeneratedImage(ref: GeneratedImageRef, name: string): Promise<File> {
  const res = await fetch(`${API_BASE}/api/ai/images/${encodeURIComponent(ref.id)}`)
  if (!res.ok) throw await readError(res)
  const blob = await res.blob()
  const type = blob.type || ref.mime
  const ext = type === 'image/jpeg' ? 'jpg' : type === 'image/webp' ? 'webp' : 'png'
  return new File([blob], `${name}.${ext}`, { type })
}

// --- Galerie der KI-Bilder (dauerhaft auf dem Server) ------------------------------

export interface GalleryImage {
  id: string
  mime: string
  prompt: string
  createdAt: number
  size: number
  /** Gemini-Modell ('' = unbekannt). */
  model: string
}

export interface GalleryList {
  images: GalleryImage[]
  totalBytes: number
}

export function parseGallery(data: unknown): GalleryList {
  const d = isRecord(data) ? data : {}
  const list = Array.isArray(d.images) ? d.images : []
  const images = list
    .filter(isRecord)
    .filter((i) => typeof i.id === 'string' && i.id !== '')
    .map((i) => ({
      id: i.id as string,
      mime: typeof i.mime === 'string' ? i.mime : 'image/png',
      prompt: typeof i.prompt === 'string' ? i.prompt : '',
      createdAt: finite(i.createdAt) ? i.createdAt : 0,
      size: finite(i.size) ? i.size : 0,
      model: typeof i.model === 'string' ? i.model : '',
    }))
  return { images, totalBytes: finite(d.totalBytes) ? d.totalBytes : 0 }
}

/** Alle gespeicherten KI-Bilder, neueste zuerst. */
export async function fetchGallery(): Promise<GalleryList> {
  const res = await fetch(`${API_BASE}/api/ai/gallery`)
  if (!res.ok) throw await readError(res)
  return parseGallery(await res.json())
}

export function galleryThumbUrl(id: string): string {
  return `${API_BASE}/api/ai/gallery/${encodeURIComponent(id)}/thumb`
}

function imageExt(type: string): string {
  if (type === 'video/mp4') return 'mp4'
  return type === 'image/jpeg' ? 'jpg' : type === 'image/webp' ? 'webp' : 'png'
}

/** Ist der Galerie-Eintrag ein KI-Video? */
export function isGalleryVideo(img: { mime: string }): boolean {
  return img.mime.startsWith('video/')
}

/** Dateiname eines Galerie-Bildes: ki-bild-JJJJMMTT-HHMMSS.<ext> (Ortszeit). */
export function galleryFileName(img: GalleryImage): string {
  const d = new Date(img.createdAt)
  const p = (n: number) => String(n).padStart(2, '0')
  const stamp = Number.isNaN(d.getTime())
    ? img.id.slice(0, 8)
    : `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  return `${isGalleryVideo(img) ? 'ki-video' : 'ki-bild'}-${stamp}.${imageExt(img.mime)}`
}

/** Lädt das Original eines Galerie-Bildes als Datei. */
export async function fetchGalleryFile(img: GalleryImage): Promise<File> {
  const res = await fetch(`${API_BASE}/api/ai/gallery/${encodeURIComponent(img.id)}/file`)
  if (!res.ok) throw await readError(res)
  const blob = await res.blob()
  return new File([blob], galleryFileName(img), { type: blob.type || img.mime })
}

// --- KI-Videos (Gemini Omni) ---------------------------------------------------------

/** Wählbare Clip-Längen in Sekunden (Server begrenzt auf 3–15). */
export const VIDEO_DURATIONS = [4, 6, 8, 10, 15] as const
export const DEFAULT_VIDEO_DURATION = 8

/** Ergebnis von POST /api/ai/video: das neue Bibliotheks-Video. */
export function parseGeneratedVideo(data: unknown): {
  media: MediaView
  saved: number | null
  galleryError: string
  model: string
} {
  const d = isRecord(data) ? data : {}
  return {
    media: parseMediaView(d.media),
    saved: finite(d.saved) ? d.saved : null,
    galleryError: typeof d.galleryError === 'string' ? d.galleryError : '',
    model: typeof d.model === 'string' ? d.model : '',
  }
}

/** Holt ein Galerie-Video als (temporäres) Bibliotheks-Video zurück. */
export async function galleryVideoToMedia(id: string): Promise<MediaView> {
  const res = await fetch(`${API_BASE}/api/ai/gallery/${encodeURIComponent(id)}/media`, {
    method: 'POST',
  })
  if (!res.ok) throw await readError(res)
  return parseMediaView(await res.json())
}

/** Löscht ein Galerie-Bild endgültig vom Server. */
export async function deleteGalleryImage(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/ai/gallery/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
  // 404 = schon weg: gilt als gelöscht.
  if (!res.ok && res.status !== 404) throw await readError(res)
}

async function readError(res: Response): Promise<Error> {
  let msg = ''
  try {
    msg = ((await res.json()) as { error?: string }).error ?? ''
  } catch {
    /* keine JSON-Antwort */
  }
  // Altes Backend: Route unbekannt.
  if (res.status === 404 && (!msg || msg === 'Nicht gefunden.')) return new Error(AI_UNSUPPORTED)
  return new Error(msg || fallbackErrorMessage(res.status, retryAfterOf(res)))
}

/** Einrichtungsstand der KI auf dem Server. */
export async function fetchAiStatus(): Promise<AiStatus | null> {
  const res = await fetch(`${API_BASE}/api/health`)
  if (!res.ok) throw new Error(fallbackErrorMessage(res.status, retryAfterOf(res)))
  return parseAiStatus(await res.json())
}

/** Laufender KI-Job: Ergebnis + Abbruch. */
export interface AiRun<T> {
  promise: Promise<T>
  cancel: () => void
}

/**
 * Startet einen KI-Job (`POST /api/ai/<action>`) und wartet per SSE auf das
 * Ergebnis. `parse` prüft das Ergebnis. Abbruch stoppt auch den Server-Job.
 */
export function runAiJob<T>(
  action:
    | 'transcribe'
    | 'subtitles'
    | 'cuts'
    | 'translate'
    | 'highlights'
    | 'publish'
    | 'broll'
    | 'image-prompt'
    | 'images'
    | 'video-prompt'
    | 'video',
  body: Record<string, unknown>,
  parse: (data: unknown) => T,
  onProgress?: (percent: number) => void,
): AiRun<T> {
  let jobId: string | null = null
  let source: EventSource | null = null
  let cancelled = false
  let rejectRun: ((e: Error) => void) | null = null

  const promise = new Promise<T>((resolve, reject) => {
    rejectRun = reject
    void (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/ai/${action}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (!res.ok) throw await readError(res)
        const data = (await res.json()) as { jobId?: unknown }
        if (typeof data.jobId !== 'string') throw new Error('Ungültige Serverantwort.')
        jobId = data.jobId
        if (cancelled) {
          void cancelJob(jobId)
          throw new Error(AI_CANCELLED)
        }
        const es = new EventSource(`${API_BASE}/api/ai/jobs/${encodeURIComponent(jobId)}/events`)
        source = es
        es.onmessage = (ev) => {
          let s: { state?: string; progress?: number; error?: string | null; result?: unknown }
          try {
            s = JSON.parse(ev.data as string) as typeof s
          } catch {
            return
          }
          if (finite(s.progress)) onProgress?.(s.progress)
          if (s.state === 'done') {
            es.close()
            try {
              resolve(parse(s.result))
            } catch (e) {
              reject(e instanceof Error ? e : new Error('Ungültiges Ergebnis.'))
            }
          } else if (s.state === 'error') {
            es.close()
            reject(new Error(cancelled ? AI_CANCELLED : (s.error ?? 'KI-Auftrag fehlgeschlagen.')))
          }
        }
        es.onerror = () => {
          es.close()
          reject(new Error(cancelled ? AI_CANCELLED : 'Verbindung zum Server unterbrochen.'))
        }
      } catch (e) {
        reject(e instanceof Error ? e : new Error('KI-Auftrag fehlgeschlagen.'))
      }
    })()
  })

  return {
    promise,
    cancel: () => {
      if (cancelled) return
      cancelled = true
      ;(source as EventSource | null)?.close()
      if (jobId) void cancelJob(jobId)
      rejectRun?.(new Error(AI_CANCELLED))
    },
  }
}

async function cancelJob(id: string): Promise<void> {
  await fetch(`${API_BASE}/api/ai/jobs/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(
    () => {},
  )
}
