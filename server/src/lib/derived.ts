import { spawn } from 'node:child_process'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { config } from '../config'
import { PROGRESS } from './args'
import { runFfmpeg } from './ffmpeg'
import { isMediaId, mediaStore, type MediaItem, type MediaStore } from './media'
import { probeMedia, type MediaInfo } from './probe'

/**
 * Abgeleitete Dateien je Video für den Timeline-Editor:
 *  - Wellenform (`peaks.bin`): ein Byte (0–255) je Abschnitt, lauteste Stelle,
 *  - Filmstreifen (`strip.jpg`): kleine Bilder in gleichen Abständen als Kachelbild,
 *  - Vorschau-Kopie (`proxy.mp4`): kleines, schnell durchsuchbares Video, aus
 *    dem der Server später die Timeline-Vorschau rechnet.
 *
 * Sie entstehen nur auf Abruf (der bisherige Editor braucht sie nicht), immer
 * nur eine Berechnung zur Zeit, und werden mit dem Video gelöscht.
 */

/** Wellenform: Abschnitte je Sekunde. */
export const PEAKS_PER_SECOND = 50
/** Abtastrate, mit der die Tonspur für die Wellenform gelesen wird. */
const PEAK_SAMPLE_RATE = 8000
const SAMPLES_PER_PEAK = PEAK_SAMPLE_RATE / PEAKS_PER_SECOND

/** Filmstreifen: höchstens so viele Bilder, so breit, so viele je Zeile. */
export const STRIP_MAX_TILES = 200
export const STRIP_TILE_WIDTH = 160
export const STRIP_COLUMNS = 10
/** Ab dieser Länge liest der Filmstreifen nur Schlüsselbilder (viel schneller). */
const STRIP_KEYFRAMES_ONLY_FROM_SEC = 600

/** Vorschau-Kopie: höchstens so hoch. */
export const PROXY_MAX_HEIGHT = 540

export type PartState = 'missing' | 'queued' | 'running' | 'ready' | 'error' | 'unavailable'

export interface PeaksMeta {
  /** Abschnitte je Sekunde. */
  rate: number
  count: number
}

export interface StripMeta {
  /** Abstand der Bilder in Sekunden; Bild `i` zeigt die Zeit `i * interval`. */
  interval: number
  count: number
  columns: number
  tileWidth: number
  tileHeight: number
}

export interface ProxyMeta {
  width: number
  height: number
}

interface DerivedMeta {
  version: 1
  peaks?: PeaksMeta
  strip?: StripMeta
  proxy?: ProxyMeta
}

export type DerivedPart = 'peaks' | 'strip' | 'proxy'
const PARTS: readonly DerivedPart[] = ['peaks', 'strip', 'proxy']

export const DERIVED_FILES: Record<DerivedPart, string> = {
  peaks: 'peaks.bin',
  strip: 'strip.jpg',
  proxy: 'proxy.mp4',
}

export interface DerivedStatus {
  peaks: { state: PartState } & Partial<PeaksMeta>
  strip: { state: PartState } & Partial<StripMeta>
  /** `progress` (0–100) nur während der Berechnung. */
  proxy: { state: PartState; progress?: number } & Partial<ProxyMeta>
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2)

/** Kann aus diesem Video der Teil überhaupt entstehen? */
export function partAvailable(part: DerivedPart, info: MediaInfo): boolean {
  if (!(info.duration > 0)) return false
  return part === 'peaks' ? info.hasAudio : info.width > 0 && info.height > 0
}

/** Aufteilung des Filmstreifens für ein Video. */
export function stripLayout(info: MediaInfo): StripMeta {
  const duration = Math.max(0, info.duration)
  const interval = Math.max(1, Math.ceil(duration / STRIP_MAX_TILES))
  const count = Math.min(STRIP_MAX_TILES, Math.max(1, Math.ceil(duration / interval)))
  const ratio = info.width > 0 && info.height > 0 ? info.height / info.width : 9 / 16
  // Extreme Formate begrenzen, damit das Kachelbild handlich bleibt.
  const tileHeight = Math.min(284, Math.max(40, even(STRIP_TILE_WIDTH * ratio)))
  return {
    interval,
    count,
    columns: Math.min(count, STRIP_COLUMNS),
    tileWidth: STRIP_TILE_WIDTH,
    tileHeight,
  }
}

export function buildStripArgs(input: string, output: string, info: MediaInfo): string[] {
  const s = stripLayout(info)
  const rows = Math.ceil(s.count / s.columns)
  return [
    ...PROGRESS,
    ...(info.duration > STRIP_KEYFRAMES_ONLY_FROM_SEC ? ['-skip_frame', 'nokey'] : []),
    '-i',
    input,
    '-an',
    '-vf',
    `fps=1/${s.interval},scale=${s.tileWidth}:${s.tileHeight},tile=${s.columns}x${rows}`,
    '-frames:v',
    '1',
    '-q:v',
    '5',
    output,
  ]
}

/** Größe der Vorschau-Kopie: höchstens 540 Zeilen hoch, gerade Maße. */
export function proxySize(info: MediaInfo): ProxyMeta {
  // Abrunden: Die Kopie wird nie größer als das Original.
  const height = Math.max(2, Math.floor(Math.min(PROXY_MAX_HEIGHT, info.height) / 2) * 2)
  return { width: even((info.width / info.height) * height), height }
}

export function buildProxyArgs(
  input: string,
  output: string,
  info: MediaInfo,
  threads = config.derivedThreads,
): string[] {
  const size = proxySize(info)
  return [
    ...PROGRESS,
    '-i',
    input,
    '-map',
    '0:v:0',
    '-map',
    '0:a:0?',
    '-vf',
    `scale=${size.width}:${size.height},format=yuv420p`,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '26',
    // Dichte Schlüsselbilder: Die Vorschau springt oft an beliebige Stellen.
    '-g',
    '12',
    '-keyint_min',
    '12',
    '-sc_threshold',
    '0',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-ar',
    '48000',
    '-ac',
    '2',
    '-threads',
    String(Math.max(1, Math.trunc(threads))),
    '-movflags',
    '+faststart',
    output,
  ]
}

export function buildPeaksArgs(input: string): string[] {
  return [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'error',
    '-i',
    input,
    '-vn',
    '-map',
    '0:a:0',
    '-ac',
    '1',
    '-ar',
    String(PEAK_SAMPLE_RATE),
    '-f',
    's16le',
    'pipe:1',
  ]
}

/**
 * Verdichtet rohe Tondaten (16 Bit, mono, little endian) zu einem Byte je
 * Abschnitt. Nimmt die Daten stückweise an, auch wenn ein Stück mitten in
 * einem Abtastwert endet.
 */
export class PeakReducer {
  private peaks: number[] = []
  private max = 0
  private filled = 0
  private carry: number | null = null

  push(chunk: Uint8Array): void {
    let i = 0
    if (this.carry !== null && chunk.length > 0) {
      this.sample(this.carry | (chunk[0] << 8))
      this.carry = null
      i = 1
    }
    for (; i + 1 < chunk.length; i += 2) this.sample(chunk[i] | (chunk[i + 1] << 8))
    if (i < chunk.length) this.carry = chunk[i]
  }

  private sample(unsigned: number): void {
    const v = unsigned >= 0x8000 ? unsigned - 0x10000 : unsigned
    const abs = v < 0 ? -v : v
    if (abs > this.max) this.max = abs
    if (++this.filled === SAMPLES_PER_PEAK) this.close()
  }

  private close(): void {
    this.peaks.push(Math.min(255, Math.round((this.max / 32768) * 255)))
    this.max = 0
    this.filled = 0
  }

  /** Ergebnis; ein angefangener letzter Abschnitt zählt mit. */
  finish(): Uint8Array {
    if (this.filled > 0) this.close()
    return Uint8Array.from(this.peaks)
  }
}

interface Handle<T> {
  promise: Promise<T>
  kill: () => void
}

/** Liest die Tonspur mit FFmpeg und liefert die Wellenform. */
function runPeaks(input: string, timeoutMs: number): Handle<Uint8Array> {
  const proc = spawn(config.ffmpegPath, buildPeaksArgs(input), {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const reducer = new PeakReducer()
  let stderrTail = ''
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    proc.kill('SIGKILL')
  }, timeoutMs)
  proc.stdout.on('data', (chunk: Buffer) => reducer.push(chunk))
  proc.stderr.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-2048)
  })
  const promise = new Promise<Uint8Array>((resolve, reject) => {
    proc.on('error', (err) => {
      clearTimeout(timer)
      reject(new Error(`FFmpeg konnte nicht gestartet werden: ${err.message}`))
    })
    proc.on('close', (code) => {
      clearTimeout(timer)
      if (timedOut) reject(new Error('Zeitlimit überschritten.'))
      else if (code === 0) resolve(reducer.finish())
      else reject(new Error(`FFmpeg-Fehler (Code ${code}). ${stderrTail.trim().slice(-300)}`))
    })
  })
  return {
    promise,
    kill: () => {
      clearTimeout(timer)
      proc.kill('SIGKILL')
    },
  }
}

interface Entry {
  meta: DerivedMeta
  /** Zustand der Teile, die (noch) nicht fertig auf der Platte liegen. */
  state: Partial<Record<DerivedPart, PartState>>
  proxyProgress?: number
  /** Steht in der Warteschlange oder läuft. */
  busy: boolean
}

function parseMeta(raw: string): DerivedMeta {
  const meta: DerivedMeta = { version: 1 }
  let data: Record<string, unknown>
  try {
    data = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return meta
  }
  const num = (o: unknown, k: string) => {
    const v = (o as Record<string, unknown> | null | undefined)?.[k]
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null
  }
  const pick = <K extends string>(o: unknown, keys: readonly K[]): Record<K, number> | null => {
    const out = {} as Record<K, number>
    for (const k of keys) {
      const v = num(o, k)
      if (v === null) return null
      out[k] = v
    }
    return out
  }
  const peaks = pick(data?.peaks, ['rate', 'count'] as const)
  if (peaks) meta.peaks = peaks
  const strip = pick(data?.strip, [
    'interval',
    'count',
    'columns',
    'tileWidth',
    'tileHeight',
  ] as const)
  if (strip) meta.strip = strip
  const proxy = pick(data?.proxy, ['width', 'height'] as const)
  if (proxy) meta.proxy = proxy
  return meta
}

export class DerivedStore {
  private entries = new Map<string, Entry>()
  private queue: string[] = []
  private running: { id: string; kill: (() => void) | null } | null = null
  private stopped = false

  constructor(
    private baseDir = config.derivedDir,
    private media: Pick<
      MediaStore,
      'get' | 'has' | 'acquire' | 'release' | 'onRemove'
    > = mediaStore,
    private timeoutMs = config.derivedTimeoutMs,
  ) {
    this.media.onRemove((id) => this.forget(id))
  }

  dir(id: string): string {
    return path.join(this.baseDir, id)
  }

  /** Pfad einer fertigen Datei; `null`, wenn sie (noch) nicht existiert. */
  async file(id: string, part: DerivedPart): Promise<string | null> {
    if (!isMediaId(id) || !this.media.has(id)) return null
    const entry = await this.load(id)
    return entry.meta[part] ? path.join(this.dir(id), DERIVED_FILES[part]) : null
  }

  /** Beim Start: Ordner von Videos entfernen, die es nicht mehr gibt. */
  async init(): Promise<void> {
    await mkdir(this.baseDir, { recursive: true })
    for (const name of await readdir(this.baseDir).catch(() => [] as string[])) {
      if (!isMediaId(name) || !this.media.has(name))
        await rm(path.join(this.baseDir, name), { recursive: true, force: true }).catch(() => {})
    }
  }

  private async load(id: string): Promise<Entry> {
    let entry = this.entries.get(id)
    if (entry) return entry
    const raw = await readFile(path.join(this.dir(id), 'meta.json'), 'utf8').catch(() => '')
    // Während des Lesens kann ein paralleler Aufruf den Eintrag angelegt haben.
    entry = this.entries.get(id)
    if (entry) return entry
    entry = { meta: raw ? parseMeta(raw) : { version: 1 }, state: {}, busy: false }
    this.entries.set(id, entry)
    return entry
  }

  private async saveMeta(id: string, meta: DerivedMeta): Promise<void> {
    const file = path.join(this.dir(id), 'meta.json')
    await writeFile(`${file}.tmp`, JSON.stringify(meta))
    await rename(`${file}.tmp`, file)
  }

  private view(entry: Entry, info: MediaInfo): DerivedStatus {
    const state = (part: DerivedPart): PartState =>
      entry.meta[part]
        ? 'ready'
        : !partAvailable(part, info)
          ? 'unavailable'
          : (entry.state[part] ?? 'missing')
    const proxy = state('proxy')
    return {
      peaks: { state: state('peaks'), ...entry.meta.peaks },
      strip: { state: state('strip'), ...entry.meta.strip },
      proxy: {
        state: proxy,
        ...(proxy === 'running' ? { progress: entry.proxyProgress ?? 0 } : {}),
        ...entry.meta.proxy,
      },
    }
  }

  /** Stand der abgeleiteten Dateien; `null`, wenn es das Video nicht gibt. */
  async status(id: string): Promise<DerivedStatus | null> {
    const item = isMediaId(id) ? this.media.get(id) : undefined
    if (!item) return null
    return this.view(await this.load(id), item.info)
  }

  /**
   * Fehlende Teile berechnen lassen (auch fehlgeschlagene erneut). Kehrt sofort
   * mit dem Stand zurück; gerechnet wird im Hintergrund.
   */
  async ensure(id: string): Promise<DerivedStatus | null> {
    const item = isMediaId(id) ? this.media.get(id) : undefined
    if (!item || this.stopped) return null
    const entry = await this.load(id)
    if (!entry.busy) {
      const todo = PARTS.filter((p) => !entry.meta[p] && partAvailable(p, item.info))
      if (todo.length > 0) {
        for (const p of todo) entry.state[p] = 'queued'
        entry.busy = true
        this.queue.push(id)
        void this.pump()
      }
    }
    return this.view(entry, item.info)
  }

  private async pump(): Promise<void> {
    if (this.running || this.stopped) return
    const id = this.queue.shift()
    if (id === undefined) return
    this.running = { id, kill: null }
    try {
      await this.work(id)
    } catch (err) {
      console.error(`Abgeleitete Dateien für ${id} fehlgeschlagen:`, err)
    } finally {
      const entry = this.entries.get(id)
      if (entry) entry.busy = false
      this.running = null
      void this.pump()
    }
  }

  private async work(id: string): Promise<void> {
    const entry = this.entries.get(id)
    const item = this.media.get(id)
    if (!entry || !item) return
    // Während der Berechnung darf das Video nicht gelöscht werden.
    this.media.acquire([id])
    try {
      await mkdir(this.dir(id), { recursive: true })
      for (const part of PARTS) {
        if (entry.state[part] !== 'queued') continue
        // Gelöscht (Löschwunsch wartet auf uns) oder Server fährt herunter: aufhören.
        if (this.stopped || !this.media.has(id)) return
        entry.state[part] = 'running'
        try {
          const meta = await this.make(part, item, entry)
          if (this.stopped || !this.media.has(id)) return
          entry.meta = { ...entry.meta, [part]: meta }
          await this.saveMeta(id, entry.meta)
          delete entry.state[part]
        } catch (err) {
          entry.state[part] = 'error'
          await rm(path.join(this.dir(id), DERIVED_FILES[part]), { force: true }).catch(() => {})
          if (!this.stopped && this.media.has(id))
            console.error(`Abgeleitete Datei (${part}) für ${id} fehlgeschlagen:`, err)
        }
      }
    } finally {
      await this.media.release([id])
    }
  }

  private async make(
    part: DerivedPart,
    item: MediaItem,
    entry: Entry,
  ): Promise<PeaksMeta | StripMeta | ProxyMeta> {
    const out = path.join(this.dir(item.id), DERIVED_FILES[part])
    const track = <T>(handle: Handle<T>): Promise<T> => {
      if (this.running) this.running.kill = handle.kill
      // Wird das Video währenddessen gelöscht, nicht zu Ende rechnen: Der
      // Löschwunsch wartet sonst, bis die (evtl. lange) Berechnung fertig ist.
      const watch = setInterval(() => {
        if (!this.media.has(item.id)) handle.kill()
      }, 1000)
      watch.unref?.()
      return handle.promise.finally(() => {
        clearInterval(watch)
        if (this.running) this.running.kill = null
      })
    }
    switch (part) {
      case 'peaks': {
        const peaks = await track(runPeaks(item.path, this.timeoutMs))
        await writeFile(out, peaks)
        return { rate: PEAKS_PER_SECOND, count: peaks.length }
      }
      case 'strip': {
        const args = buildStripArgs(item.path, out, item.info)
        await track(runFfmpeg(args, item.info.duration, () => {}, undefined, this.timeoutMs))
        return stripLayout(item.info)
      }
      case 'proxy': {
        entry.proxyProgress = 0
        const args = buildProxyArgs(item.path, out, item.info)
        const onProgress = (p: number) => (entry.proxyProgress = p)
        await track(runFfmpeg(args, item.info.duration, onProgress, undefined, this.timeoutMs))
        const info = await probeMedia(out)
        return { width: info.width, height: info.height }
      }
    }
  }

  /** Video wurde entfernt: Berechnung abbrechen, Dateien löschen. */
  private forget(id: string): void {
    this.entries.delete(id)
    this.queue = this.queue.filter((q) => q !== id)
    if (this.running?.id === id) this.running.kill?.()
    void rm(this.dir(id), { recursive: true, force: true }).catch(() => {})
  }

  /** Für den Graceful Shutdown: laufende Berechnung abbrechen. Fertiges bleibt liegen. */
  shutdown(): void {
    this.stopped = true
    this.queue = []
    this.running?.kill?.()
  }
}

export const derivedStore = new DerivedStore()
