import { createHash } from 'node:crypto'
import { mkdir, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { config } from '../../config'
import { customFontsEnv } from '../customFonts'
import { runFfmpeg, type RunHandle } from '../ffmpeg'
import {
  buildRenderArgs,
  compileTimeline,
  fpsRational,
  type CompiledTimeline,
  type RenderGraphic,
  type RenderSource,
} from './compile'
import { MICROS_PER_SECOND, docDuration, type DocSettings, type RenderDoc, type Time } from './doc'

/**
 * Server-Vorschau des Timeline-Editors.
 *
 * Die Timeline wird in kurzen Abschnitten in kleiner Auflösung gerendert – mit
 * demselben Compiler wie der Export. Jeder Abschnitt bekommt einen Schlüssel
 * aus genau dem, was ihn bestimmt (FFmpeg-Eingaben, Filter, Encoder). Nach
 * einer Änderung ändern sich nur die Schlüssel der betroffenen Abschnitte;
 * alle anderen kommen aus dem Zwischenspeicher.
 */

/** Länge eines Abschnitts in Sekunden (auf ganze Bilder gerundet). */
export const PREVIEW_SEGMENT_SEC = 4
/** Größte Höhe der Vorschau. */
export const PREVIEW_MAX_HEIGHT = 540
/** So viele Abschnitte ab dem Abspielkopf werden vorab gerendert; der Rest bei Abruf. */
export const PREVIEW_AHEAD = 30
/** Ändert sich das Encoding, werden alte Abschnitte nicht wiederverwendet. */
const CACHE_VERSION = 7
const ENCODE = {
  preset: 'veryfast',
  crf: 27,
  audioBitrate: '128k',
  // Fragmentiert: sofort abspielbar und nahtlos aneinanderreihbar (MSE).
  movflags: 'frag_keyframe+empty_moov+default_base_moof',
  seamless: true,
} as const
/**
 * Vorschau in voller Auflösung: Projektgröße, Originaldateien und die Bildgüte
 * des Exports („Hoch“). Dauert deutlich länger und ist deshalb nur auf Wunsch aktiv.
 */
const ENCODE_FULL = { ...ENCODE, crf: 18 } as const
type PreviewEncode = typeof ENCODE | typeof ENCODE_FULL

const KEY_RE = /^[0-9a-f]{32}$/

export function isPreviewKey(v: unknown): v is string {
  return typeof v === 'string' && KEY_RE.test(v)
}

/**
 * Vorschaugröße: höchstens 540 px hoch, Seitenverhältnis des Projekts, gerade Maße, nie größer.
 * `full`: Projektgröße (wie die Ausgabedatei).
 */
export function previewSize(
  settings: Pick<DocSettings, 'width' | 'height'>,
  full = false,
): {
  width: number
  height: number
} {
  const scale = full ? 1 : Math.min(1, PREVIEW_MAX_HEIGHT / settings.height)
  const even = (v: number) => Math.max(2, Math.floor((v * scale) / 2) * 2)
  return { width: even(settings.width), height: even(settings.height) }
}

export interface SegmentRange {
  index: number
  start: Time
  end: Time
}

/** Teilt die Timeline in Abschnitte auf dem Bildraster. */
export function planSegments(doc: RenderDoc): SegmentRange[] {
  const rate = fpsRational(doc.settings.fps)
  const frameOf = (t: Time) => Math.round((t * rate.num) / (rate.den * MICROS_PER_SECOND))
  const timeOf = (f: number) => Math.round((f * rate.den * MICROS_PER_SECOND) / rate.num)
  const total = frameOf(docDuration(doc))
  const step = Math.max(1, Math.round((PREVIEW_SEGMENT_SEC * rate.num) / rate.den))
  const out: SegmentRange[] = []
  for (let f = 0, index = 0; f < total; f += step, index++)
    out.push({ index, start: timeOf(f), end: timeOf(Math.min(total, f + step)) })
  return out
}

export type SegmentState = 'ready' | 'queued' | 'rendering' | 'error'

export interface SegmentView {
  index: number
  start: Time
  duration: Time
  key: string
  state: SegmentState
  /** Renderzeit in ms (nur wenn in diesem Lauf gerendert). */
  renderMs?: number
  error?: string
}

export interface PreviewPlan {
  width: number
  height: number
  /** Volle Auflösung (Projektgröße) statt der kleinen Vorschau. */
  full: boolean
  fps: number
  duration: Time
  segments: SegmentView[]
}

export interface PreviewStats {
  /** In diesem Lauf gerenderte Abschnitte. */
  rendered: number
  avgMs: number
  maxMs: number
  lastMs: number
  /** Sekunden Timeline je Sekunde Renderzeit (über die letzten Abschnitte). */
  speed: number
  cacheFiles: number
  cacheBytes: number
}

interface Job {
  key: string
  compiled: CompiledTimeline
  encode: PreviewEncode
  state: 'queued' | 'rendering' | 'error'
  error?: string
  handle?: RunHandle
  waiters: Array<(state: 'ready' | 'error' | 'gone') => void>
}

interface Cached {
  size: number
  lastUsed: number
  renderMs?: number
}

export interface PreviewStoreOptions {
  dir?: string
  maxBytes?: number
  concurrent?: number
  threads?: number
  timeoutMs?: number
  /** Für Tests austauschbar. */
  run?: typeof runFfmpeg
}

export class PreviewStore {
  private dir: string
  private maxBytes: number
  private concurrent: number
  private threads: number
  private timeoutMs: number
  private run: typeof runFfmpeg

  private cache = new Map<string, Cached>()
  /** Abschnitte des aktuellen Plans, die noch nicht fertig sind. */
  private jobs = new Map<string, Job>()
  private queue: string[] = []
  private active = 0
  private stopped = false
  private times: Array<{ ms: number; seconds: number }> = []
  private rendered = 0

  constructor(opts: PreviewStoreOptions = {}) {
    this.dir = opts.dir ?? config.previewDir
    this.maxBytes = opts.maxBytes ?? config.previewCacheBytes
    this.concurrent = Math.max(1, Math.trunc(opts.concurrent ?? config.previewConcurrent))
    this.threads = Math.max(1, Math.trunc(opts.threads ?? config.previewThreads))
    this.timeoutMs = opts.timeoutMs ?? config.previewTimeoutMs
    this.run = opts.run ?? runFfmpeg
  }

  private path(key: string): string {
    return path.join(this.dir, `${key}.mp4`)
  }

  /** Beim Start: vorhandene Abschnitte übernehmen, Reste abgebrochener Läufe löschen. */
  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    for (const name of await readdir(this.dir).catch(() => [] as string[])) {
      const file = path.join(this.dir, name)
      const key = name.endsWith('.mp4') ? name.slice(0, -4) : ''
      if (!isPreviewKey(key)) {
        await rm(file, { recursive: true, force: true }).catch(() => {})
        continue
      }
      const st = await stat(file).catch(() => null)
      if (st?.isFile()) this.cache.set(key, { size: st.size, lastUsed: st.mtimeMs })
    }
    await this.evict()
  }

  /**
   * Plan für ein Dokument: Schlüssel und Stand aller Abschnitte. Fehlende
   * Abschnitte ab `at` werden zum Rendern eingereiht; was zu einem früheren
   * Plan gehörte und nicht mehr gebraucht wird, wird verworfen bzw. abgebrochen.
   */
  plan(
    doc: RenderDoc,
    sources: Record<string, RenderSource>,
    at: Time = 0,
    graphics: Record<string, RenderGraphic> = {},
    opts: { full?: boolean } = {},
  ): PreviewPlan {
    const full = opts.full === true
    const encode: PreviewEncode = full ? ENCODE_FULL : ENCODE
    const size = previewSize(doc.settings, full)
    const ranges = planSegments(doc)
    const gop = Math.max(1, Math.round(doc.settings.fps))
    const wanted = new Map<string, CompiledTimeline>()
    const keys: string[] = []
    for (const range of ranges) {
      const compiled = compileTimeline(doc, { sources, graphics, range, size })
      const key = createHash('sha256')
        .update(
          JSON.stringify([
            CACHE_VERSION,
            compiled.inputs,
            compiled.filter,
            compiled.ass ?? '',
            encode,
            gop,
          ]),
        )
        .digest('hex')
        .slice(0, 32)
      keys.push(key)
      wanted.set(key, compiled)
    }

    // Überholte Aufträge verwerfen bzw. abbrechen.
    for (const [key, job] of this.jobs) {
      if (wanted.has(key)) continue
      this.jobs.delete(key)
      job.handle?.kill()
      for (const done of job.waiters.splice(0)) done('gone')
    }

    const now = Date.now()
    for (const [key, compiled] of wanted) {
      const cached = this.cache.get(key)
      if (cached) cached.lastUsed = now
      else if (!this.jobs.has(key))
        this.jobs.set(key, { key, compiled, encode, state: 'queued', waiters: [] })
    }

    // Reihenfolge: ab dem Abspielkopf vorwärts, begrenzt auf ein Fenster.
    const first = Math.max(
      0,
      ranges.findIndex((r) => at < r.end),
    )
    const ahead = keys.slice(first, first + PREVIEW_AHEAD)
    this.queue = [...new Set(ahead)].filter((k) => this.jobs.get(k)?.state === 'queued')
    this.pump()

    return {
      width: size.width,
      height: size.height,
      full,
      fps: doc.settings.fps,
      duration: docDuration(doc),
      segments: ranges.map((r, i) => this.view(r, keys[i])),
    }
  }

  private view(range: SegmentRange, key: string): SegmentView {
    const base = { index: range.index, start: range.start, duration: range.end - range.start, key }
    const cached = this.cache.get(key)
    if (cached)
      return {
        ...base,
        state: 'ready',
        ...(cached.renderMs !== undefined ? { renderMs: cached.renderMs } : {}),
      }
    const job = this.jobs.get(key)
    if (job?.state === 'error') return { ...base, state: 'error', error: job.error }
    return { ...base, state: job?.state ?? 'queued' }
  }

  /** Stand eines Abschnitts; `null`, wenn er zu keinem aktuellen Plan gehört. */
  state(key: string): SegmentState | null {
    if (this.cache.has(key)) return 'ready'
    return this.jobs.get(key)?.state ?? null
  }

  /** Pfad eines fertigen Abschnitts (zählt als Benutzung). */
  file(key: string): string | null {
    const cached = isPreviewKey(key) ? this.cache.get(key) : undefined
    if (!cached) return null
    cached.lastUsed = Date.now()
    return this.path(key)
  }

  /**
   * Wartet, bis der Abschnitt fertig ist, und zieht ihn in der Warteschlange
   * nach vorn (er wird gerade gebraucht). `gone`: nicht (mehr) Teil des Plans.
   */
  wait(key: string, timeoutMs: number): Promise<'ready' | 'error' | 'gone' | 'timeout'> {
    if (this.cache.has(key)) return Promise.resolve('ready')
    const job = this.jobs.get(key)
    if (!job) return Promise.resolve('gone')
    if (job.state === 'error') return Promise.resolve('error')
    if (job.state === 'queued') {
      this.queue = [key, ...this.queue.filter((k) => k !== key)]
      this.pump()
    }
    return new Promise((resolve) => {
      const done = (state: 'ready' | 'error' | 'gone') => {
        clearTimeout(timer)
        resolve(state)
      }
      const timer = setTimeout(() => {
        job.waiters = job.waiters.filter((w) => w !== done)
        resolve('timeout')
      }, timeoutMs)
      timer.unref?.()
      job.waiters.push(done)
    })
  }

  private pump(): void {
    while (!this.stopped && this.active < this.concurrent) {
      const key = this.queue.shift()
      if (key === undefined) return
      const job = this.jobs.get(key)
      if (!job || job.state !== 'queued') continue
      void this.render(job)
    }
  }

  private async render(job: Job): Promise<void> {
    job.state = 'rendering'
    this.active++
    const tmp = path.join(this.dir, `${job.key}.part`)
    // Texte: Untertitel-Datei neben dem Abschnitt, nach dem Rendern wieder weg.
    const assPath = job.compiled.ass === undefined ? null : path.join(this.dir, `${job.key}.ass`)
    const started = Date.now()
    try {
      if (assPath) await writeFile(assPath, job.compiled.ass ?? '', 'utf8')
      const args = buildRenderArgs(job.compiled, {
        ...job.encode,
        ...(assPath ? { assPath, fontsDir: config.fontsDir } : {}),
        output: tmp,
        threads: this.threads,
        gop: Math.max(1, Math.round(job.compiled.frames / job.compiled.duration)),
      })
      job.handle = this.run(
        args,
        job.compiled.duration,
        () => {},
        assPath ? customFontsEnv() : undefined,
        this.timeoutMs,
      )
      await job.handle.promise
      // Inzwischen überholt (neuer Plan) oder Server fährt herunter: Ergebnis verwerfen.
      if (this.stopped || this.jobs.get(job.key) !== job) {
        await rm(tmp, { force: true }).catch(() => {})
        return
      }
      await rename(tmp, this.path(job.key))
      const size = (await stat(this.path(job.key))).size
      const ms = Date.now() - started
      this.cache.set(job.key, { size, lastUsed: Date.now(), renderMs: ms })
      this.jobs.delete(job.key)
      this.rendered++
      this.times.push({ ms, seconds: job.compiled.duration })
      if (this.times.length > 50) this.times.shift()
      for (const done of job.waiters.splice(0)) done('ready')
      await this.evict()
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {})
      if (!this.stopped && this.jobs.get(job.key) === job) {
        job.state = 'error'
        job.error = 'Vorschau konnte nicht gerendert werden.'
        console.error(`Vorschau-Abschnitt ${job.key} fehlgeschlagen:`, err)
        for (const done of job.waiters.splice(0)) done('error')
      }
    } finally {
      if (assPath) await rm(assPath, { force: true }).catch(() => {})
      job.handle = undefined
      this.active--
      this.pump()
    }
  }

  /** Zwischenspeicher auf die Obergrenze kürzen: am längsten Ungenutztes zuerst. */
  private async evict(): Promise<void> {
    let total = 0
    for (const c of this.cache.values()) total += c.size
    if (total <= this.maxBytes) return
    const oldest = [...this.cache.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)
    for (const [key, c] of oldest) {
      if (total <= this.maxBytes) break
      this.cache.delete(key)
      total -= c.size
      await rm(this.path(key), { force: true }).catch(() => {})
    }
  }

  stats(): PreviewStats {
    const ms = this.times.map((t) => t.ms)
    const sumMs = ms.reduce((a, b) => a + b, 0)
    const sumSec = this.times.reduce((a, t) => a + t.seconds, 0)
    let cacheBytes = 0
    for (const c of this.cache.values()) cacheBytes += c.size
    return {
      rendered: this.rendered,
      avgMs: ms.length ? Math.round(sumMs / ms.length) : 0,
      maxMs: ms.length ? Math.max(...ms) : 0,
      lastMs: ms.length ? ms[ms.length - 1] : 0,
      speed: sumMs > 0 ? Math.round((sumSec / (sumMs / 1000)) * 100) / 100 : 0,
      cacheFiles: this.cache.size,
      cacheBytes,
    }
  }

  /** Für den Graceful Shutdown: laufende Abschnitte abbrechen. Fertiges bleibt liegen. */
  async shutdown(): Promise<void> {
    this.stopped = true
    this.queue = []
    for (const job of this.jobs.values()) {
      job.handle?.kill()
      for (const done of job.waiters.splice(0)) done('gone')
    }
    this.jobs.clear()
    // Zugriffszeiten sichern, damit nach dem Neustart das Richtige zuerst weicht.
    await Promise.all(
      [...this.cache.entries()].map(([key, c]) => {
        const t = new Date(c.lastUsed)
        return utimes(this.path(key), t, t).catch(() => {})
      }),
    )
  }
}

export const previewStore = new PreviewStore()
