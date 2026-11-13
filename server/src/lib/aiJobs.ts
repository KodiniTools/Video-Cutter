import { randomUUID } from 'node:crypto'

/**
 * Kleine Job-Verwaltung für KI-Aufgaben (Transkription, Claude). Unabhängig
 * vom FFmpeg-JobManager, damit KI-Läufe keine Schnitt-Slots belegen.
 * Fortschritt per SSE (/api/ai/jobs/:id/events), Abbruch per AbortSignal.
 */

export type AiJobKind = 'transcribe' | 'claude'
export type AiJobState = 'processing' | 'done' | 'error'

export interface AiJobSnapshot {
  id: string
  kind: AiJobKind
  state: AiJobState
  progress: number
  error: string | null
  result?: unknown
}

interface AiJob extends AiJobSnapshot {
  controller: AbortController
  createdAt: number
  listeners: Set<(s: AiJobSnapshot) => void>
}

/** Gleichzeitige Läufe je Art: Whisper belegt viele Kerne, Claude kaum etwas. */
const LIMITS: Record<AiJobKind, number> = { transcribe: 1, claude: 3 }
/** Fertige Jobs werden nach dieser Zeit vergessen. */
const TTL_MS = 30 * 60 * 1000

function snap(j: AiJob): AiJobSnapshot {
  return {
    id: j.id,
    kind: j.kind,
    state: j.state,
    progress: j.progress,
    error: j.error,
    ...(j.state === 'done' ? { result: j.result } : {}),
  }
}

export class AiJobManager {
  private jobs = new Map<string, AiJob>()
  private sweeper: NodeJS.Timeout

  constructor() {
    this.sweeper = setInterval(() => this.sweep(), 60_000)
    this.sweeper.unref?.()
  }

  activeCount(kind: AiJobKind): number {
    let n = 0
    for (const j of this.jobs.values()) if (j.kind === kind && j.state === 'processing') n++
    return n
  }

  hasCapacity(kind: AiJobKind): boolean {
    return this.activeCount(kind) < LIMITS[kind]
  }

  /**
   * Startet eine Aufgabe. `work` erhält Abbruchsignal und Fortschritts-Callback;
   * ihr Rückgabewert wird zum Ergebnis, ein Fehler zur Fehlermeldung.
   */
  start(
    kind: AiJobKind,
    work: (signal: AbortSignal, progress: (p: number) => void) => Promise<unknown>,
  ): AiJobSnapshot {
    const job: AiJob = {
      id: randomUUID(),
      kind,
      state: 'processing',
      progress: 0,
      error: null,
      controller: new AbortController(),
      createdAt: Date.now(),
      listeners: new Set(),
    }
    this.jobs.set(job.id, job)
    const emit = () => {
      const s = snap(job)
      for (const l of job.listeners) l(s)
    }
    const progress = (p: number) => {
      const v = Math.min(99, Math.max(job.progress, Math.round(p)))
      if (v === job.progress || job.state !== 'processing') return
      job.progress = v
      emit()
    }
    void (async () => {
      try {
        const result = await work(job.controller.signal, progress)
        if (job.state !== 'processing') return
        job.result = result
        job.progress = 100
        job.state = 'done'
      } catch (err) {
        if (job.state !== 'processing') return
        job.state = 'error'
        job.error = err instanceof Error ? err.message : 'Unbekannter Fehler.'
      }
      emit()
    })()
    return snap(job)
  }

  get(id: string): AiJobSnapshot | undefined {
    const j = this.jobs.get(id)
    return j ? snap(j) : undefined
  }

  subscribe(id: string, fn: (s: AiJobSnapshot) => void): () => void {
    const j = this.jobs.get(id)
    if (!j) return () => {}
    j.listeners.add(fn)
    return () => j.listeners.delete(fn)
  }

  /** Bricht einen laufenden Job ab. */
  cancel(id: string): boolean {
    const j = this.jobs.get(id)
    if (!j || j.state !== 'processing') return false
    j.controller.abort()
    j.state = 'error'
    j.error = 'Abgebrochen.'
    const s = snap(j)
    for (const l of j.listeners) l(s)
    return true
  }

  private sweep(now = Date.now()): void {
    for (const [id, j] of this.jobs) {
      if (j.state !== 'processing' && now - j.createdAt > TTL_MS) this.jobs.delete(id)
    }
  }

  shutdown(): void {
    clearInterval(this.sweeper)
    for (const j of this.jobs.values()) if (j.state === 'processing') j.controller.abort()
  }
}

export const aiJobs = new AiJobManager()
