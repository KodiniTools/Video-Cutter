import { rm } from 'node:fs/promises'
import { config } from '../config'
import { runFfmpeg, type RunHandle } from './ffmpeg'
import { mediaStore } from './media'
import { probeMedia } from './probe'

export type JobState = 'processing' | 'done' | 'error'

export interface JobSnapshot {
  id: string
  state: JobState
  progress: number
  error: string | null
  /** ID des als Video gespeicherten Ergebnisses (nur mit storeResult). */
  mediaId?: string
}

interface Job {
  id: string
  state: JobState
  progress: number
  error: string | null
  inputPath: string
  /** Gehört die Haupt-Eingabedatei dem Job (Upload) oder der Bibliothek? */
  ownsInput: boolean
  /** Weitere Eingabedateien (angehängte Videos) – werden mit aufgeräumt. */
  extraInputPaths: string[]
  /** Benutzte Bibliotheks-Videos (für die Dauer des Jobs gegen Löschen gesperrt). */
  mediaRefs: string[]
  /** Ergebnis als neues Bibliotheks-Video speichern statt zum Download bereitzuhalten. */
  storeResult: boolean
  resultMediaId: string | null
  outputPath: string
  outputName: string
  handle: RunHandle | null
  createdAt: number
  listeners: Set<(snap: JobSnapshot) => void>
}

function snapshot(job: Job): JobSnapshot {
  return {
    id: job.id,
    state: job.state,
    progress: job.progress,
    error: job.error,
    ...(job.resultMediaId ? { mediaId: job.resultMediaId } : {}),
  }
}

/** Löscht die dem Job gehörenden Eingaben und gibt Bibliotheks-Sperren frei (einmalig). */
async function removeInputs(job: Job): Promise<void> {
  const owned = job.ownsInput ? [job.inputPath, ...job.extraInputPaths] : job.extraInputPaths
  for (const p of owned) {
    await rm(p, { force: true }).catch(() => {})
  }
  job.extraInputPaths = []
  job.ownsInput = false
  const refs = job.mediaRefs
  job.mediaRefs = []
  if (refs.length) await mediaStore.release(refs)
}

class JobManager {
  private jobs = new Map<string, Job>()
  private active = 0
  private sweeper: NodeJS.Timeout

  constructor() {
    this.sweeper = setInterval(() => this.sweep(), 60_000)
    // Kein Blockieren des Prozess-Exits durch den Timer.
    this.sweeper.unref?.()
  }

  /** Freie Slots vorhanden? */
  hasCapacity(): boolean {
    return this.active < config.maxConcurrent
  }

  get activeCount(): number {
    return this.active
  }

  create(params: {
    id: string
    inputPath: string
    ownsInput?: boolean
    extraInputPaths?: string[]
    mediaRefs?: string[]
    storeResult?: boolean
    outputPath: string
    outputName: string
  }): Job {
    const job: Job = {
      id: params.id,
      state: 'processing',
      progress: 0,
      error: null,
      inputPath: params.inputPath,
      ownsInput: params.ownsInput ?? true,
      extraInputPaths: params.extraInputPaths ?? [],
      mediaRefs: params.mediaRefs ?? [],
      storeResult: params.storeResult ?? false,
      resultMediaId: null,
      outputPath: params.outputPath,
      outputName: params.outputName,
      handle: null,
      createdAt: Date.now(),
      listeners: new Set(),
    }
    this.jobs.set(job.id, job)
    return job
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id)
  }

  getSnapshot(id: string): JobSnapshot | undefined {
    const job = this.jobs.get(id)
    return job ? snapshot(job) : undefined
  }

  subscribe(id: string, cb: (snap: JobSnapshot) => void): () => void {
    const job = this.jobs.get(id)
    if (!job) return () => {}
    job.listeners.add(cb)
    return () => job.listeners.delete(cb)
  }

  private emit(job: Job): void {
    const snap = snapshot(job)
    for (const cb of job.listeners) {
      try {
        cb(snap)
      } catch {
        /* Listener-Fehler ignorieren */
      }
    }
  }

  /** Startet den FFmpeg-Lauf. Verwaltet Concurrency-Zähler und Cleanup. */
  async run(job: Job, args: string[], durationSec: number): Promise<void> {
    this.active++
    try {
      const handle = runFfmpeg(args, durationSec, (p) => {
        job.progress = p
        this.emit(job)
      })
      job.handle = handle
      await handle.promise
      if (job.storeResult) {
        // Ergebnis in die Bibliothek übernehmen; die Datei gehört dann dort hin.
        const info = await probeMedia(job.outputPath)
        const item = await mediaStore.add(job.outputPath, job.outputName, info)
        job.resultMediaId = item.id
        job.outputPath = ''
      }
      job.state = 'done'
      job.progress = 100
    } catch (e) {
      job.state = 'error'
      job.error = e instanceof Error ? e.message : String(e)
      if (job.outputPath) await rm(job.outputPath, { force: true }).catch(() => {})
    } finally {
      this.active--
      job.handle = null
      // Eingabedateien werden nach dem Lauf nicht mehr gebraucht.
      await removeInputs(job)
      this.emit(job)
    }
  }

  /** Bricht einen laufenden Job ab und räumt auf. */
  async cancel(id: string): Promise<boolean> {
    const job = this.jobs.get(id)
    if (!job) return false
    job.handle?.kill()
    await this.remove(id)
    return true
  }

  /** Entfernt Job + zugehörige Dateien. */
  async remove(id: string): Promise<void> {
    const job = this.jobs.get(id)
    if (!job) return
    this.jobs.delete(id)
    await removeInputs(job)
    if (job.outputPath) await rm(job.outputPath, { force: true }).catch(() => {})
  }

  getOutput(id: string): { path: string; name: string } | undefined {
    const job = this.jobs.get(id)
    if (!job || job.state !== 'done' || !job.outputPath) return undefined
    return { path: job.outputPath, name: job.outputName }
  }

  private async sweep(): Promise<void> {
    const now = Date.now()
    for (const [id, job] of this.jobs) {
      if (now - job.createdAt > config.jobTtlMs) {
        job.handle?.kill()
        await this.remove(id)
      }
    }
  }

  /** Für Graceful Shutdown: alles beenden und löschen. */
  async shutdown(): Promise<void> {
    clearInterval(this.sweeper)
    for (const [id, job] of this.jobs) {
      job.handle?.kill()
      await this.remove(id)
    }
  }
}

export const jobManager = new JobManager()
