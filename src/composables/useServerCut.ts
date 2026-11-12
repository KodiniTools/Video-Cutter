import { ref } from 'vue'
import type { TrimMode } from '@/lib/ffmpegCommand'
import type { CutOperation, CropRect } from '@/stores/videoEditor'
import { API_BASE } from '@/lib/apiBase'
import { fetchMediaFile, fetchMediaInfo, MEDIA_UNSUPPORTED, type MediaView } from '@/lib/mediaApi'
import type { TextOverlayData } from '@/lib/textOverlay'

/** Fehler-Kennung für einen vom Nutzer abgebrochenen Vorgang. */
export const CUT_CANCELLED = 'CUT_CANCELLED'
/**
 * Fehler-Kennung: Ein Bildausschnitt wurde angefordert, aber das Backend hat
 * ihn nicht bestätigt (veralteter Server ohne Crop-Unterstützung). Der Job
 * wird dann abgebrochen, statt stillschweigend ungeschnitten zu liefern.
 */
export const CROP_UNSUPPORTED = 'CROP_UNSUPPORTED'

/**
 * Fehler-Kennung: Videos sollten angehängt werden, aber das Backend hat das
 * Zusammenfügen nicht bestätigt (veralteter Server).
 */
export const APPEND_UNSUPPORTED = 'APPEND_UNSUPPORTED'

/**
 * Fehler-Kennung: Ein anderes Seitenverhältnis wurde angefordert, aber das
 * Backend hat es nicht bestätigt (veralteter Server).
 */
export const FORMAT_UNSUPPORTED = 'FORMAT_UNSUPPORTED'

/** Fehler-Kennung: Hintergrundmusik verlangt, aber vom Backend nicht bestätigt. */
export const MUSIC_UNSUPPORTED = 'MUSIC_UNSUPPORTED'

/** Fehler-Kennung: Text einbrennen verlangt, aber das Backend kennt es nicht (veraltet). */
export const TEXT_UNSUPPORTED = 'TEXT_UNSUPPORTED'

/** Antwort von POST /api/cut. `crop`/`append` fehlen bei alten Backends. */
export interface JobStartResponse {
  jobId: string
  crop?: boolean
  /** Anzahl der vom Server übernommenen angehängten Videos. */
  append?: number
  /** Hat der Server Kürzung/Position der angehängten Videos übernommen? */
  appendTrim?: boolean
  /** Kennt der Server Einfügestellen zwischen den Ausschnitten (`slot`)? */
  appendSlots?: boolean
  /** Hat der Server die Lautstärke-Angleichung übernommen? */
  normalizeAudio?: boolean
  /** Kennt der Server Seitenverhältnis/Füllmodus (`outputAspect`/`outputFill`)? */
  outputFormat?: boolean
  /** Hat der Server die Hintergrundmusik übernommen? */
  music?: boolean
  /** Hat der Server die Übergänge je Nahtstelle übernommen? */
  seamTransitions?: boolean
  /** Wird das Ergebnis in der Video-Bibliothek gespeichert? */
  storeResult?: boolean
}

/**
 * Liest die Antwort des Job-Starts. Wirft bei fehlender jobId.
 * Exportiert, damit die Auswertung ohne XHR testbar ist.
 */
export function parseJobStart(text: string): JobStartResponse {
  type Raw = {
    jobId?: unknown
    crop?: unknown
    append?: unknown
    appendTrim?: unknown
    appendSlots?: unknown
    normalizeAudio?: unknown
    outputFormat?: unknown
    music?: unknown
    seamTransitions?: unknown
    storeResult?: unknown
  }
  let data: Raw
  try {
    data = JSON.parse(text) as Raw
  } catch {
    throw new Error('Ungültige Serverantwort.')
  }
  if (typeof data.jobId !== 'string' || !data.jobId) {
    throw new Error('Ungültige Serverantwort (keine jobId).')
  }
  const append = typeof data.append === 'number' && data.append > 0 ? data.append : 0
  return {
    jobId: data.jobId,
    crop: data.crop === true,
    append,
    appendTrim: data.appendTrim === true,
    appendSlots: data.appendSlots === true,
    normalizeAudio: data.normalizeAudio === true,
    outputFormat: data.outputFormat === true,
    music: data.music === true,
    seamTransitions: data.seamTransitions === true,
    storeResult: data.storeResult === true,
  }
}

interface JobEvent {
  state: 'processing' | 'done' | 'error'
  progress: number
  error: string | null
  /** Bibliotheks-ID des Ergebnisses (nur mit `storeResult`). */
  mediaId?: string
}

/** Aktuelle Phase für die UI: Upload der Datei oder serverseitige Verarbeitung. */
export type CutPhase = 'idle' | 'upload' | 'process'

// Singleton-Zustand, damit die UI den Fortschritt beobachten kann.
const isProcessing = ref(false)
const progress = ref(0)
const phase = ref<CutPhase>('idle')
// Upload-Statistik (nur während phase === 'upload' aussagekräftig).
const uploadedBytes = ref(0)
const totalBytes = ref(0)
const bytesPerSec = ref(0)

// Handles auf den aktuell laufenden Vorgang (für "Abbrechen").
let currentXhr: XMLHttpRequest | null = null
let currentSource: EventSource | null = null
let currentJobId: string | null = null
let rejectActive: ((reason: Error) => void) | null = null

async function readError(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { error?: string }
    return data.error ?? `Serverfehler (${res.status}).`
  } catch {
    return `Serverfehler (${res.status}).`
  }
}

/**
 * Lädt die Datei per XHR hoch (im Gegensatz zu fetch liefert XHR echten
 * Upload-Fortschritt) und legt den Job an. Gibt die Job-Antwort zurück.
 */
function uploadForJob(
  form: FormData,
  onProgress: (loaded: number, total: number) => void,
): Promise<JobStartResponse> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    currentXhr = xhr
    rejectActive = reject
    const cleanup = () => {
      if (currentXhr === xhr) currentXhr = null
      if (rejectActive === reject) rejectActive = null
    }
    xhr.open('POST', `${API_BASE}/api/cut`)

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded, e.total)
    }

    xhr.onload = () => {
      cleanup()
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(parseJobStart(xhr.responseText))
        } catch (err) {
          reject(err instanceof Error ? err : new Error('Ungültige Serverantwort.'))
        }
      } else {
        let msg = `Serverfehler (${xhr.status}).`
        try {
          const data = JSON.parse(xhr.responseText) as { error?: string }
          if (data.error) msg = data.error
        } catch {
          /* Rohantwort ohne JSON – Standardmeldung behalten. */
        }
        reject(new Error(msg))
      }
    }

    xhr.onerror = () => {
      cleanup()
      reject(new Error('Upload fehlgeschlagen (Netzwerkfehler).'))
    }
    // Abbruch wird zentral über cancel() abgewickelt (rejectActive).
    xhr.onabort = () => cleanup()

    xhr.send(form)
  })
}

/**
 * Wartet via SSE bis der Job fertig ist; aktualisiert `progress`. Liefert die
 * Bibliotheks-ID des Ergebnisses, falls der Server es gespeichert hat.
 */
function waitForJob(jobId: string): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const source = new EventSource(`${API_BASE}/api/cut/${jobId}/events`)
    currentSource = source
    rejectActive = reject
    let settled = false
    const cleanup = () => {
      if (currentSource === source) currentSource = null
      if (rejectActive === reject) rejectActive = null
    }

    source.onmessage = (ev) => {
      let data: JobEvent
      try {
        data = JSON.parse(ev.data) as JobEvent
      } catch {
        return // Heartbeat/Kommentarzeilen ignorieren
      }
      progress.value = data.progress
      if (data.state === 'done') {
        settled = true
        cleanup()
        source.close()
        resolve(typeof data.mediaId === 'string' && data.mediaId ? data.mediaId : undefined)
      } else if (data.state === 'error') {
        settled = true
        cleanup()
        source.close()
        reject(new Error(data.error ?? 'Serverseitiger Schnitt fehlgeschlagen.'))
      }
    }

    source.onerror = () => {
      if (settled) return
      settled = true
      cleanup()
      source.close()
      reject(new Error('Verbindung zum Server unterbrochen.'))
    }
  })
}

/** Bricht den laufenden Upload/Job ab (Nutzer-Aktion). */
function cancel(): void {
  const rej = rejectActive
  rejectActive = null
  if (currentXhr) {
    currentXhr.abort()
    currentXhr = null
  }
  if (currentSource) {
    currentSource.close()
    currentSource = null
  }
  // Serverseitigen Job beenden (laufenden ffmpeg-Prozess stoppen).
  if (currentJobId) {
    fetch(`${API_BASE}/api/cut/${currentJobId}`, { method: 'DELETE' }).catch(() => {})
  }
  rej?.(new Error(CUT_CANCELLED))
}

/** Ein Ausschnitt für den Server: Start + Länge in Sekunden. */
export interface CutSegment {
  start: number
  duration: number
}

/** Übergang zwischen den zusammengefügten Ausschnitten. */
export interface CutTransition {
  preset: string
  duration: number
}

/**
 * Ein angehängtes Video mit optionaler Kürzung und Position – entweder als
 * Datei (`file`, wird hochgeladen) ODER als Bibliotheks-ID (`mediaId`).
 */
export interface AppendInput {
  file?: File
  mediaId?: string
  /** Startpunkt im angehängten Video (Sekunden), Standard 0. */
  start?: number
  /** Verwendete Länge (Sekunden); fehlt = bis zum Ende. */
  duration?: number
  /** 'before' = vor den Ausschnitten, 'after' (Standard) = dahinter. */
  position?: 'before' | 'after'
  /** Nur bei 'after': hinter dem n-ten Teil des Hauptvideos einfügen (1-basiert). */
  slot?: number
}

/** Gewünschtes Ausgabeformat. */
export interface CutOutputFormat {
  aspect: 'auto' | '16:9' | '9:16' | '1:1'
  fill: 'pad' | 'blur' | 'crop'
}

/** Hintergrundmusik für den Server. */
export interface MusicInput {
  file: File
  volume: number
  originalVolume: number
  fade: boolean
  loop: boolean
}

/** Weicht ein angehängtes Video von „vollständig, danach" ab? */
function needsAppendTrim(a: AppendInput): boolean {
  return (a.start ?? 0) > 0 || a.duration !== undefined || a.position === 'before'
}

/** Alle Parameter eines Server-Jobs (intern). */
interface JobRequest {
  /** Hauptvideo: Datei (Upload) oder Bibliotheks-ID. */
  source: File | { mediaId: string }
  segments: CutSegment[]
  mode: TrimMode
  operation: CutOperation
  total: number
  transition?: CutTransition
  crop?: CropRect
  appends: AppendInput[]
  normalizeAudio: boolean
  output?: CutOutputFormat
  music?: MusicInput
  seams?: (string | null)[]
  /** Ergebnis in der Bibliothek speichern (statt zum Download bereitzuhalten). */
  storeResult?: boolean
}

/** Bricht einen gestarteten Job ab (DELETE) und wirft die gegebene Fehler-Kennung. */
async function abortJob(jobId: string, code: string): Promise<never> {
  currentJobId = null
  await fetch(`${API_BASE}/api/cut/${jobId}`, { method: 'DELETE' }).catch(() => {})
  throw new Error(code)
}

/**
 * Lädt hoch bzw. referenziert die Bibliothek, legt den Job an, prüft die
 * Bestätigungen des Backends und wartet bis zum Ende (SSE).
 */
async function startAndWait(req: JobRequest): Promise<{ jobId: string; mediaId?: string }> {
  const { segments, mode, operation, total, transition, crop, appends, normalizeAudio } = req
  const { output, music, seams } = req
  const form = new FormData()
  // Textfelder vor den Dateien, damit der Server sie beim Upload schon kennt.
  if (!(req.source instanceof File)) form.append('mediaId', req.source.mediaId)
  if (req.storeResult) form.append('storeResult', '1')
  form.append('segments', JSON.stringify(segments))
  form.append('mode', mode)
  form.append('operation', operation)
  if (operation === 'remove') form.append('total', String(total))
  if (transition && transition.preset !== 'none') {
    form.append('transitionPreset', transition.preset)
    form.append('transitionDuration', String(transition.duration))
  }
  const wantsSeams = appends.length > 0 && seams !== undefined && seams.some((p) => p !== null)
  if (wantsSeams) {
    form.append('seamTransitions', JSON.stringify(seams))
    // Dauer auch dann mitschicken, wenn global „keine" Animation gewählt ist.
    if (!form.has('transitionDuration') && transition) {
      form.append('transitionDuration', String(transition.duration))
    }
  }
  if (crop) form.append('crop', JSON.stringify(crop))
  const wantsFormat = output !== undefined && output.aspect !== 'auto'
  if (wantsFormat) {
    form.append('outputAspect', output.aspect)
    form.append('outputFill', output.fill)
  }
  if (music) {
    form.append('musicVolume', String(music.volume))
    form.append('musicOriginalVolume', String(music.originalVolume))
    form.append('musicFade', music.fade ? '1' : '0')
    form.append('musicLoop', music.loop ? '1' : '0')
  }
  if (appends.length) {
    form.append(
      'appendMeta',
      JSON.stringify(
        appends.map((a) => ({
          start: a.start ?? 0,
          ...(a.duration !== undefined ? { duration: a.duration } : {}),
          position: a.position ?? 'after',
          ...(a.slot !== undefined && a.position !== 'before' ? { slot: a.slot } : {}),
        })),
      ),
    )
    if (normalizeAudio) form.append('normalizeAudio', '1')
    // Bibliotheks-IDs und Datei-Uploads lassen sich nicht mischen (Server).
    const ids = appends.map((a) => a.mediaId)
    if (ids.every((id): id is string => typeof id === 'string' && id.length > 0)) {
      form.append('appendMediaIds', JSON.stringify(ids))
    } else {
      for (const a of appends) {
        if (!a.file) throw new Error('Angehängtes Video ohne Datei.')
        form.append('append', a.file)
      }
    }
  }
  if (req.source instanceof File) form.append('video', req.source)
  if (music) form.append('music', music.file)

  // Geglättete Upload-Geschwindigkeit aus den Fortschritts-Deltas.
  let lastTime = 0
  let lastLoaded = 0
  const started = await uploadForJob(form, (loaded, tot) => {
    progress.value = tot > 0 ? Math.round((loaded / tot) * 100) : 0
    uploadedBytes.value = loaded
    totalBytes.value = tot
    const now = performance.now()
    if (lastTime && now - lastTime > 300) {
      const inst = ((loaded - lastLoaded) / (now - lastTime)) * 1000 // Bytes/s
      bytesPerSec.value = bytesPerSec.value ? bytesPerSec.value * 0.7 + inst * 0.3 : inst
      lastTime = now
      lastLoaded = loaded
    } else if (!lastTime) {
      lastTime = now
      lastLoaded = loaded
    }
  })
  const jobId = started.jobId
  currentJobId = jobId

  // Zuschnitt angefordert, aber vom Backend nicht bestätigt: Der Server ist
  // veraltet und würde das volle Bild liefern. Job abbrechen (kein unnötiger
  // Encode) und klar melden, statt ein falsches Ergebnis anzuzeigen.
  if (crop && !started.crop) await abortJob(jobId, CROP_UNSUPPORTED)

  // Angehängte Videos nicht (vollständig) übernommen -> veralteter Server.
  // … oder Kürzung/Position verlangt, aber nicht bestätigt (würde sonst
  // stillschweigend vollständig und hinten angehängt).
  if (
    appends.length &&
    (started.append !== appends.length ||
      (appends.some(needsAppendTrim) && !started.appendTrim) ||
      // Einfügestelle zwischen Ausschnitten bzw. Lautstärke-Angleichung nicht bestätigt.
      (appends.some((a) => a.slot !== undefined && a.position !== 'before') &&
        !started.appendSlots) ||
      (normalizeAudio && !started.normalizeAudio) ||
      (wantsSeams && !started.seamTransitions))
  ) {
    await abortJob(jobId, APPEND_UNSUPPORTED)
  }

  // Anderes Seitenverhältnis verlangt, aber nicht bestätigt -> veralteter Server.
  if (wantsFormat && !started.outputFormat) await abortJob(jobId, FORMAT_UNSUPPORTED)

  // Musik verlangt, aber nicht bestätigt -> veralteter Server.
  if (music && !started.music) await abortJob(jobId, MUSIC_UNSUPPORTED)

  // Speichern in der Bibliothek verlangt, aber nicht bestätigt -> veralteter Server.
  if (req.storeResult && !started.storeResult) await abortJob(jobId, MEDIA_UNSUPPORTED)

  // Upload fertig -> serverseitige Verarbeitung (Fortschritt via SSE).
  phase.value = 'process'
  progress.value = 0
  const mediaId = await waitForJob(jobId)
  return { jobId, mediaId }
}

/** Setzt den gemeinsamen Fortschritts-Zustand für die Dauer eines Vorgangs. */
async function withProcessing<T>(fn: () => Promise<T>): Promise<T> {
  isProcessing.value = true
  phase.value = 'upload'
  progress.value = 0
  uploadedBytes.value = 0
  totalBytes.value = 0
  bytesPerSec.value = 0
  currentJobId = null
  try {
    return await fn()
  } finally {
    isProcessing.value = false
    phase.value = 'idle'
    currentJobId = null
  }
}

/**
 * Schneidet ein Video serverseitig (Datei-Upload je Vorgang).
 * @param segments   Ein oder mehrere Ausschnitte ({ start, duration }).
 * @param operation  'keep' behält die Ausschnitte, 'remove' entfernt sie.
 * @param total      Gesamtdauer des Videos (nur für 'remove' nötig).
 * @param transition Optionaler Übergang beim Zusammenfügen mehrerer Ausschnitte.
 * @param crop       Optionaler Bildausschnitt (Anteile 0–1); erzwingt Re-Encode.
 * @param appends    Weitere Videos (optional gekürzt), die vor, zwischen oder hinter die
 *                   Ausschnitte gesetzt werden (Reihenfolge = Liste); erzwingt Re-Encode.
 * @param normalizeAudio Lautstärke aller Clips angleichen (nur mit angehängten Videos).
 * @param output     Seitenverhältnis + Füllmodus; 'auto' = wie das Hauptvideo.
 * @param music      Optionale Hintergrundmusik über das gesamte Ergebnis.
 * @param seams      Übergang je Nahtstelle in Gesamtreihenfolge (`null` = global);
 *                   nur mit angehängten Videos.
 */
async function cut(
  file: File,
  segments: CutSegment[],
  mode: TrimMode,
  operation: CutOperation = 'keep',
  total = 0,
  transition?: CutTransition,
  crop?: CropRect,
  appends: AppendInput[] = [],
  normalizeAudio = false,
  output?: CutOutputFormat,
  music?: MusicInput,
  seams?: (string | null)[],
): Promise<Blob> {
  return withProcessing(async () => {
    const { jobId } = await startAndWait({
      source: file,
      segments,
      mode,
      operation,
      total,
      transition,
      crop,
      appends,
      normalizeAudio,
      output,
      music,
      seams,
    })
    const download = await fetch(`${API_BASE}/api/cut/${jobId}/download`)
    if (!download.ok) throw new Error(await readError(download))
    currentJobId = null
    return await download.blob()
  })
}

/** Auftrag für ein Video aus der Bibliothek (Ergebnis wird dort gespeichert). */
export interface MediaCutRequest {
  /** Bibliotheks-ID des Hauptvideos. */
  mediaId: string
  segments: CutSegment[]
  mode: TrimMode
  operation?: CutOperation
  total?: number
  transition?: CutTransition
  crop?: CropRect
  /** Angehängte Videos – hier per `mediaId`. */
  appends?: AppendInput[]
  normalizeAudio?: boolean
  output?: CutOutputFormat
  music?: MusicInput
  seams?: (string | null)[]
}

/** Ergebnis: neues Bibliotheks-Video + Datei (für Vorschau und Download). */
export interface MediaCutResult {
  media: MediaView
  blob: Blob
}

/**
 * Schneidet/fügt Videos aus der Bibliothek zusammen, ohne sie erneut
 * hochzuladen. Das Ergebnis wird als neues Bibliotheks-Video gespeichert.
 */
async function cutMedia(req: MediaCutRequest): Promise<MediaCutResult> {
  return withProcessing(async () => {
    const { mediaId } = await startAndWait({
      source: { mediaId: req.mediaId },
      segments: req.segments,
      mode: req.mode,
      operation: req.operation ?? 'keep',
      total: req.total ?? 0,
      transition: req.transition,
      crop: req.crop,
      appends: req.appends ?? [],
      normalizeAudio: req.normalizeAudio ?? false,
      output: req.output,
      music: req.music,
      seams: req.seams,
      storeResult: true,
    })
    currentJobId = null
    if (!mediaId) throw new Error(MEDIA_UNSUPPORTED)
    const [media, blob] = await Promise.all([fetchMediaInfo(mediaId), fetchMediaFile(mediaId)])
    return { media, blob }
  })
}

/**
 * Startet POST /api/text und liefert die Job-ID. Ein altes Backend (Route
 * unbekannt -> 404, oder fehlende Bestätigung `text`) ergibt TEXT_UNSUPPORTED.
 * Exportiert für Tests.
 */
export async function startTextJob(
  mediaId: string,
  texts: TextOverlayData[],
  signal?: AbortSignal,
): Promise<string> {
  const res = await fetch(`${API_BASE}/api/text`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mediaId, texts }),
    signal,
  })
  const raw = await res.text()
  let data: { jobId?: unknown; text?: unknown; error?: unknown } = {}
  try {
    data = JSON.parse(raw) as typeof data
  } catch {
    /* keine JSON-Antwort (z. B. HTML-Fehlerseite) */
  }
  if (!res.ok) {
    const msg = typeof data.error === 'string' ? data.error : ''
    if (res.status === 404 && (!msg || msg === 'Nicht gefunden.')) throw new Error(TEXT_UNSUPPORTED)
    throw new Error(msg || `Serverfehler (${res.status}).`)
  }
  if (typeof data.jobId !== 'string' || !data.jobId) {
    throw new Error('Ungültige Serverantwort (keine jobId).')
  }
  if (data.text !== true) {
    await fetch(`${API_BASE}/api/cut/${data.jobId}`, { method: 'DELETE' }).catch(() => {})
    throw new Error(TEXT_UNSUPPORTED)
  }
  return data.jobId
}

/**
 * Brennt Texte in ein Bibliotheks-Video ein. Das Ergebnis wird auf dem Server
 * als neues Video gespeichert und (wie beim Schneiden) zurückgegeben.
 */
async function burnText(mediaId: string, texts: TextOverlayData[]): Promise<MediaCutResult> {
  return withProcessing(async () => {
    // Kein Upload: direkt in die Verarbeitungsphase.
    phase.value = 'process'
    const controller = new AbortController()
    let cancelled = false
    rejectActive = () => {
      cancelled = true
      controller.abort()
    }
    let jobId: string
    try {
      jobId = await startTextJob(mediaId, texts, controller.signal)
    } catch (e) {
      if (cancelled) throw new Error(CUT_CANCELLED)
      throw e
    } finally {
      rejectActive = null
    }
    currentJobId = jobId
    // Abbruch zwischen Start und SSE-Verbindung: Job sofort beenden.
    if (cancelled) await abortJob(jobId, CUT_CANCELLED)
    const resultId = await waitForJob(jobId)
    currentJobId = null
    if (!resultId) throw new Error(MEDIA_UNSUPPORTED)
    const [media, blob] = await Promise.all([fetchMediaInfo(resultId), fetchMediaFile(resultId)])
    return { media, blob }
  })
}

export function useServerCut() {
  return {
    isProcessing,
    progress,
    phase,
    uploadedBytes,
    totalBytes,
    bytesPerSec,
    cut,
    cutMedia,
    burnText,
    cancel,
  }
}

export { MEDIA_UNSUPPORTED }
