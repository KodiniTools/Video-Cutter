import { fetchPreviewSegment, type PreviewPlan } from '@/lib/previewApi'
import { farIndices, nextToLoad, segmentIndexAt, staleIndices } from './schedule'

/** Format der Abschnitte: H.264 + AAC in fragmentiertem MP4. */
export const PREVIEW_MIME = 'video/mp4; codecs="avc1.64001f, mp4a.40.2"'

/** So viele Abschnitte werden ab der aktuellen Stelle vorgeladen. */
const LOAD_AHEAD = 5
/** Abschnitte außerhalb dieses Fensters werden aus dem Puffer entfernt. */
const KEEP_BEHIND = 10
const KEEP_AHEAD = 15

const US = 1_000_000

export function previewSupported(): boolean {
  return typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(PREVIEW_MIME)
}

export interface PreviewEngineEvents {
  /** Der Puffer hat sich geändert (Abschnitt geladen oder entfernt). */
  onChange: () => void
  /** Der Server kennt einen Abschnitt nicht mehr: Plan neu holen. */
  onGone: () => void
  onError: (error: unknown) => void
}

interface Loaded {
  key: string
  /** Bereich im Puffer in Sekunden. */
  start: number
  end: number
}

const isAbort = (e: unknown) => e instanceof DOMException && e.name === 'AbortError'

/**
 * Spielt die Server-Vorschau über Media Source Extensions ab: Jeder Abschnitt
 * wird an seiner Stelle in einen gemeinsamen Puffer gehängt, sodass das
 * Video-Element die Timeline als einen durchgehenden Film sieht.
 *
 * Ändert sich der Plan, werden nur die Abschnitte ersetzt, deren Schlüssel
 * sich geändert hat. Alle Pufferzugriffe laufen nacheinander in `sync`.
 */
export class PreviewEngine {
  private readonly source = new MediaSource()
  private readonly url: string
  private buffer: SourceBuffer | null = null
  private plan: PreviewPlan | null = null
  private readonly loaded = new Map<number, Loaded>()
  private readonly failed = new Set<string>()
  /** Zuletzt gesetzte Gesamtlänge in Sekunden. */
  private total = 0
  private at = 0
  private current = 0
  private inflight: { index: number; key: string; ctrl: AbortController } | null = null
  private running = false
  private again = false
  private dead = false

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly events: PreviewEngineEvents,
  ) {
    this.url = URL.createObjectURL(this.source)
    this.source.addEventListener(
      'sourceopen',
      () => {
        if (this.dead) return
        try {
          this.buffer = this.source.addSourceBuffer(PREVIEW_MIME)
          this.buffer.mode = 'segments'
        } catch (e) {
          this.events.onError(e)
          return
        }
        this.sync()
      },
      { once: true },
    )
    video.src = this.url
  }

  /** Neuen Plan übernehmen (`null`: leere Timeline, Puffer leeren). */
  setPlan(plan: PreviewPlan | null): void {
    this.plan = plan && plan.segments.length ? plan : null
    this.failed.clear()
    this.locate()
    const flight = this.inflight
    if (flight && this.plan?.segments[flight.index]?.key !== flight.key) flight.ctrl.abort()
    this.sync()
  }

  /** Aktuelle Stelle (µs): bestimmt, was als Nächstes geladen wird. */
  setPosition(at: number): void {
    this.at = at
    const before = this.current
    this.locate()
    if (this.current === before) return
    const flight = this.inflight
    if (flight && (flight.index < this.current || flight.index >= this.current + LOAD_AHEAD))
      flight.ctrl.abort()
    this.sync()
  }

  /** Liegt der Abschnitt zur Zeit (µs) in aktueller Fassung im Puffer? */
  isBuffered(at: number): boolean {
    const segments = this.plan?.segments ?? []
    const index = segmentIndexAt(segments, at)
    return index >= 0 && this.loaded.get(index)?.key === segments[index].key
  }

  destroy(): void {
    this.dead = true
    this.inflight?.ctrl.abort()
    this.video.removeAttribute('src')
    this.video.load()
    URL.revokeObjectURL(this.url)
  }

  private locate(): void {
    this.current = Math.max(0, segmentIndexAt(this.plan?.segments ?? [], this.at))
  }

  private loadedKeys(): Map<number, string> {
    return new Map([...this.loaded].map(([index, l]) => [index, l.key]))
  }

  private sync(): void {
    if (this.running) {
      this.again = true
      return
    }
    this.running = true
    void (async () => {
      try {
        do {
          this.again = false
          await this.work()
        } while (this.again && !this.dead)
      } catch (e) {
        if (!this.dead && !isAbort(e)) this.events.onError(e)
      } finally {
        this.running = false
      }
    })()
  }

  private usable(): SourceBuffer | null {
    return !this.dead && this.buffer && this.source.readyState !== 'closed' ? this.buffer : null
  }

  /**
   * Liegt der letzte Abschnitt im Puffer, das Ende melden. Ohne das wartet der
   * Browser kurz vor dem Ende auf weitere Daten und zeigt die letzten Bilder
   * nicht. Jede spätere Pufferänderung öffnet die Quelle wieder.
   */
  private finish(): void {
    const segments = this.plan?.segments ?? []
    const last = segments.length - 1
    if (last < 0 || this.loaded.get(last)?.key !== segments[last].key) return
    if (this.source.readyState !== 'open' || this.buffer?.updating) return
    try {
      this.source.endOfStream()
    } catch {
      /* Quelle inzwischen geschlossen */
    }
  }

  /** Pufferänderung abwarten. */
  private settle(buffer: SourceBuffer, change: () => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const done = () => {
        buffer.removeEventListener('updateend', done)
        buffer.removeEventListener('error', fail)
        resolve()
      }
      const fail = () => {
        buffer.removeEventListener('updateend', done)
        buffer.removeEventListener('error', fail)
        reject(new Error('Vorschau-Abschnitt konnte nicht gelesen werden.'))
      }
      buffer.addEventListener('updateend', done)
      buffer.addEventListener('error', fail)
      try {
        change()
      } catch (e) {
        buffer.removeEventListener('updateend', done)
        buffer.removeEventListener('error', fail)
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    })
  }

  private async drop(indices: readonly number[]): Promise<void> {
    for (const index of indices) {
      const buffer = this.usable()
      const item = this.loaded.get(index)
      if (!buffer || !item) return
      if (item.end > item.start)
        await this.settle(buffer, () => buffer.remove(item.start, item.end))
      this.loaded.delete(index)
    }
    this.events.onChange()
  }

  private async work(): Promise<void> {
    for (;;) {
      const buffer = this.usable()
      if (!buffer) return
      const plan = this.plan
      const segments = plan?.segments ?? []

      const stale = staleIndices(segments, this.loadedKeys())
      if (stale.length) {
        await this.drop(stale)
        continue
      }
      if (!plan) return

      const total = plan.duration / US
      if (total > 0 && this.total !== total) {
        // Nach gemeldetem Ende lässt sich die Länge erst wieder im offenen Zustand ändern.
        if (this.source.readyState === 'ended') buffer.timestampOffset = 0
        // Kürzen ist nur erlaubt, wenn dahinter nichts mehr im Puffer liegt.
        if (Number.isFinite(this.source.duration) && total < this.source.duration)
          await this.settle(buffer, () => buffer.remove(total, Number.POSITIVE_INFINITY))
        this.source.duration = total
        this.total = total
      }

      const far = farIndices(this.loadedKeys(), this.current, KEEP_BEHIND, KEEP_AHEAD)
      if (far.length) {
        await this.drop(far)
        continue
      }

      const next = nextToLoad(segments, this.loadedKeys(), this.current, LOAD_AHEAD, this.failed)
      if (!next) {
        this.finish()
        return
      }

      const ctrl = new AbortController()
      this.inflight = { index: next.index, key: next.key, ctrl }
      let data: ArrayBuffer | null
      try {
        data = await fetchPreviewSegment(next.key, ctrl.signal)
      } catch (e) {
        if (isAbort(e)) continue
        // Diesen Abschnitt auslassen, die folgenden trotzdem laden.
        this.failed.add(next.key)
        if (!this.dead) this.events.onError(e)
        continue
      } finally {
        this.inflight = null
      }
      if (data === null) {
        if (!this.dead && this.plan?.segments[next.index]?.key === next.key) this.events.onGone()
        return
      }
      // Inzwischen neu geplant? Dann passt der Abschnitt evtl. nicht mehr.
      if (this.plan?.segments[next.index]?.key !== next.key) continue
      const target = this.usable()
      if (!target) return
      const start = next.start / US
      const bytes = data
      target.timestampOffset = start
      await this.settle(target, () => target.appendBuffer(bytes))
      this.loaded.set(next.index, {
        key: next.key,
        start,
        end: (next.start + next.duration) / US,
      })
      this.events.onChange()
    }
  }
}
