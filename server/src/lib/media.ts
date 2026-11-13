import { rm, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { config } from '../config'
import type { MediaInfo } from './probe'

/** Ein auf dem Server gespeichertes Video der Bibliothek. */
export interface MediaItem {
  id: string
  path: string
  /** Anzeigename (bereinigter Originalname). */
  name: string
  size: number
  info: MediaInfo
  createdAt: number
  /** Letzter Zugriff (Upload, Job, Download) – Grundlage für das Auto-Aufräumen. */
  lastUsed: number
}

/** Öffentliche Sicht auf ein Video (ohne Pfad). */
export interface MediaView {
  id: string
  name: string
  size: number
  duration: number
  width: number
  height: number
  hasAudio: boolean
  /** Bildrate, 0 = unbekannt (Frontend schaltet dann auf ms-Schritte zurück). */
  fps: number
}

export function mediaView(m: MediaItem): MediaView {
  return {
    id: m.id,
    name: m.name,
    size: m.size,
    duration: m.info.duration,
    width: m.info.width,
    height: m.info.height,
    hasAudio: m.info.hasAudio,
    fps: m.info.fps ?? 0,
  }
}

/** Speicher voll – wird als 507 an den Client gemeldet. */
export class StorageFullError extends Error {
  statusCode = 507
  constructor() {
    super('Speicher auf dem Server ist voll. Bitte nicht mehr benötigte Videos löschen.')
    this.name = 'StorageFullError'
  }
}

/** Gültige Media-ID (UUID v4, wie von randomUUID erzeugt). */
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function isMediaId(v: unknown): v is string {
  return typeof v === 'string' && ID_RE.test(v)
}

/**
 * Bibliothek hochgeladener Videos und Ergebnisse. Dateien bleiben bis zum
 * Löschen durch den Nutzer – oder bis sie `mediaTtlMs` lang nicht benutzt
 * wurden. Während ein Job eine Datei liest, wird sie nicht gelöscht (Referenz-
 * zählung); ein Löschwunsch wird dann nach Jobende ausgeführt.
 */
export class MediaStore {
  private items = new Map<string, MediaItem>()
  private inUse = new Map<string, number>()
  private pendingDelete = new Set<string>()
  private sweeper: NodeJS.Timeout

  constructor(
    private ttlMs = config.mediaTtlMs,
    private maxTotalBytes = config.maxMediaTotalBytes,
  ) {
    this.sweeper = setInterval(() => void this.sweep(), 60_000)
    this.sweeper.unref?.()
  }

  get totalBytes(): number {
    let sum = 0
    for (const m of this.items.values()) sum += m.size
    return sum
  }

  get count(): number {
    return this.items.size
  }

  /** Passt eine weitere Datei dieser Größe noch in den Speicher? */
  hasRoomFor(bytes: number): boolean {
    return this.totalBytes + Math.max(0, bytes) <= this.maxTotalBytes
  }

  /**
   * Nimmt eine fertige Datei auf (Upload oder Job-Ergebnis). Wirft
   * StorageFullError, wenn das Limit überschritten würde – die Datei wird dann
   * NICHT gelöscht (Aufrufer entscheidet).
   */
  async add(filePath: string, name: string, info: MediaInfo, size?: number): Promise<MediaItem> {
    const bytes = size ?? (await stat(filePath)).size
    if (!this.hasRoomFor(bytes)) throw new StorageFullError()
    const now = Date.now()
    const item: MediaItem = {
      id: randomUUID(),
      path: filePath,
      name,
      size: bytes,
      info,
      createdAt: now,
      lastUsed: now,
    }
    this.items.set(item.id, item)
    return item
  }

  /** Liefert ein Video und markiert es als benutzt. */
  get(id: string): MediaItem | undefined {
    if (this.pendingDelete.has(id)) return undefined
    const m = this.items.get(id)
    if (m) m.lastUsed = Date.now()
    return m
  }

  /** Existiert das Video noch? (ohne es als benutzt zu markieren) */
  has(id: string): boolean {
    return this.items.has(id) && !this.pendingDelete.has(id)
  }

  /** Sperrt Videos für die Dauer eines Jobs gegen Löschen. */
  acquire(ids: string[]): void {
    for (const id of ids) this.inUse.set(id, (this.inUse.get(id) ?? 0) + 1)
  }

  /** Gibt Sperren frei und führt ausstehende Löschungen aus. */
  async release(ids: string[]): Promise<void> {
    for (const id of ids) {
      const n = (this.inUse.get(id) ?? 1) - 1
      if (n > 0) this.inUse.set(id, n)
      else this.inUse.delete(id)
      const m = this.items.get(id)
      if (m) m.lastUsed = Date.now()
      if (n <= 0 && this.pendingDelete.has(id)) await this.removeNow(id)
    }
  }

  /**
   * Löscht ein Video. In Benutzung -> wird sofort unsichtbar und nach dem Job
   * entfernt. Liefert false, wenn die ID unbekannt ist.
   */
  async remove(id: string): Promise<boolean> {
    if (!this.items.has(id) || this.pendingDelete.has(id)) return false
    if ((this.inUse.get(id) ?? 0) > 0) {
      this.pendingDelete.add(id)
      return true
    }
    await this.removeNow(id)
    return true
  }

  private async removeNow(id: string): Promise<void> {
    const m = this.items.get(id)
    this.items.delete(id)
    this.pendingDelete.delete(id)
    if (m) await rm(m.path, { force: true }).catch(() => {})
  }

  /** Entfernt Videos, die länger als die TTL nicht benutzt wurden. */
  async sweep(now = Date.now()): Promise<void> {
    for (const [id, m] of this.items) {
      if ((this.inUse.get(id) ?? 0) > 0) continue
      if (now - m.lastUsed > this.ttlMs) await this.removeNow(id)
    }
  }

  async shutdown(): Promise<void> {
    clearInterval(this.sweeper)
    for (const id of [...this.items.keys()]) await this.removeNow(id)
  }
}

export const mediaStore = new MediaStore()
