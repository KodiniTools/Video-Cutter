import { API_BASE } from './apiBase'

/**
 * Client für die KI-Funktionen des Servers (`/api/ai/*`): Transkription
 * (whisper.cpp), Untertitel und Schnittvorschläge (Claude). Jeder Aufruf
 * startet einen Job; Fortschritt und Ergebnis kommen per SSE.
 */

/** Fehler-Kennung: Das Backend kennt die KI-Funktionen noch nicht (veraltet). */
export const AI_UNSUPPORTED = 'AI_UNSUPPORTED'
/** Fehler-Kennung: Job vom Nutzer abgebrochen. */
export const AI_CANCELLED = 'AI_CANCELLED'

export type TranscribeLanguage = 'auto' | 'de' | 'en'
export type SubtitleTarget = 'original' | 'de' | 'en'
export type CutKind = 'filler' | 'slip' | 'repeat' | 'pause'

export interface AiStatus {
  transcribe: boolean
  claude: boolean
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
  return { transcribe: data.ai.transcribe === true, claude: data.ai.claude === true }
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

async function readError(res: Response): Promise<Error> {
  let msg = ''
  try {
    msg = ((await res.json()) as { error?: string }).error ?? ''
  } catch {
    /* keine JSON-Antwort */
  }
  // Altes Backend: Route unbekannt.
  if (res.status === 404 && (!msg || msg === 'Nicht gefunden.')) return new Error(AI_UNSUPPORTED)
  return new Error(msg || `Serverfehler (${res.status}).`)
}

/** Einrichtungsstand der KI auf dem Server. */
export async function fetchAiStatus(): Promise<AiStatus | null> {
  const res = await fetch(`${API_BASE}/api/health`)
  if (!res.ok) throw new Error(`Serverfehler (${res.status}).`)
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
  action: 'transcribe' | 'subtitles' | 'cuts',
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
