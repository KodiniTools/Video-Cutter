import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
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

/** Dauerhaftes Verzeichnis der Bibliothek (übersteht einen Neustart des Servers). */
export interface MediaPersistence {
  /** JSON-Datei mit dem Verzeichnis aller Videos. */
  indexFile: string
  /** Nur Dateien in diesem Ordner werden beim Start wieder aufgenommen. */
  baseDir: string
}

const INDEX_VERSION = 1

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0

/** Liest einen Eintrag des Verzeichnisses; `null`, wenn er unbrauchbar ist. */
function parseIndexEntry(raw: unknown, baseDir: string): MediaItem | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const info = r.info as Record<string, unknown> | null | undefined
  if (!isMediaId(r.id) || typeof r.path !== 'string' || typeof r.name !== 'string') return null
  if (!isCount(r.size) || !isCount(r.createdAt) || !isCount(r.lastUsed)) return null
  if (!info || typeof info !== 'object') return null
  if (!isCount(info.width) || !isCount(info.height) || !isCount(info.duration)) return null
  if (typeof info.hasAudio !== 'boolean') return null
  // Nur Dateien im eigenen Arbeitsordner: Ein manipuliertes Verzeichnis darf
  // den Server nicht dazu bringen, fremde Dateien auszuliefern oder zu löschen.
  const file = path.resolve(r.path)
  if (!file.startsWith(path.resolve(baseDir) + path.sep)) return null
  return {
    id: r.id,
    path: file,
    name: r.name,
    size: r.size,
    info: {
      width: info.width,
      height: info.height,
      hasAudio: info.hasAudio,
      duration: info.duration,
      ...(isCount(info.fps) ? { fps: info.fps } : {}),
    },
    createdAt: r.createdAt,
    lastUsed: r.lastUsed,
  }
}

/**
 * Bibliothek hochgeladener Videos und Ergebnisse. Dateien bleiben bis zum
 * Löschen durch den Nutzer – oder bis sie `mediaTtlMs` lang nicht benutzt
 * wurden. Während ein Job eine Datei liest, wird sie nicht gelöscht (Referenz-
 * zählung); ein Löschwunsch wird dann nach Jobende ausgeführt.
 *
 * Mit `persist` führt der Speicher ein Verzeichnis auf der Platte: Nach einem
 * Neustart (z. B. Deploy) sind die Videos unter derselben ID wieder da. Ohne
 * `persist` lebt die Bibliothek nur im Arbeitsspeicher und `shutdown` löscht
 * alle Dateien.
 */
export class MediaStore {
  private items = new Map<string, MediaItem>()
  private inUse = new Map<string, number>()
  private pendingDelete = new Set<string>()
  private sweeper: NodeJS.Timeout
  /** Verzeichnis muss geschrieben werden / Schreiben ist bereits eingeplant. */
  private dirty = false
  /** Seit dem letzten Schreiben wurde ein Video benutzt (`lastUsed` geändert). */
  private usedSinceSave = false
  private saving: Promise<void> = Promise.resolve()
  private removeListeners: Array<(id: string) => void> = []

  constructor(
    private ttlMs = config.mediaTtlMs,
    private maxTotalBytes = config.maxMediaTotalBytes,
    private persist?: MediaPersistence,
  ) {
    this.sweeper = setInterval(() => void this.sweep(), 60_000)
    this.sweeper.unref?.()
  }

  /**
   * Liest das Verzeichnis ein (einmal beim Start). Einträge, deren Datei fehlt
   * oder die unbrauchbar sind, werden übergangen. Liefert die Zahl der
   * wiederhergestellten Videos.
   */
  async init(): Promise<number> {
    if (!this.persist) return 0
    let entries: unknown[] = []
    try {
      const parsed: unknown = JSON.parse(await readFile(this.persist.indexFile, 'utf8'))
      const items = (parsed as { items?: unknown } | null)?.items
      if (Array.isArray(items)) entries = items
    } catch (err) {
      // Kein Verzeichnis (erster Start) ist normal; alles andere melden.
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT')
        console.error('Video-Verzeichnis nicht lesbar, beginne leer:', err)
      return 0
    }
    let restored = 0
    for (const raw of entries) {
      const item = parseIndexEntry(raw, this.persist.baseDir)
      if (!item || this.items.has(item.id)) continue
      const st = await stat(item.path).catch(() => null)
      if (!st?.isFile()) continue
      this.items.set(item.id, { ...item, size: st.size })
      restored++
    }
    if (restored !== entries.length) this.touch()
    return restored
  }

  /** Meldet, wenn ein Video endgültig entfernt wurde (z. B. um Abgeleitetes zu löschen). */
  onRemove(listener: (id: string) => void): void {
    this.removeListeners.push(listener)
  }

  /** Plant das Schreiben des Verzeichnisses ein (mehrere Änderungen = ein Schreiben). */
  private touch(): void {
    if (!this.persist || this.dirty) return
    this.dirty = true
    this.saving = this.saving.then(() => this.writeIndex())
  }

  private async writeIndex(): Promise<void> {
    if (!this.persist) return
    this.dirty = false
    this.usedSinceSave = false
    const items = [...this.items.values()].filter((m) => !this.pendingDelete.has(m.id))
    const tmp = `${this.persist.indexFile}.tmp`
    try {
      // Erst daneben schreiben, dann umbenennen: nie ein halbes Verzeichnis.
      await writeFile(tmp, JSON.stringify({ version: INDEX_VERSION, items }))
      await rename(tmp, this.persist.indexFile)
    } catch (err) {
      console.error('Video-Verzeichnis konnte nicht geschrieben werden:', err)
    }
  }

  /** Wartet, bis das Verzeichnis geschrieben ist. */
  async flush(): Promise<void> {
    await this.saving
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
    this.touch()
    return item
  }

  /** Liefert ein Video und markiert es als benutzt. */
  get(id: string): MediaItem | undefined {
    if (this.pendingDelete.has(id)) return undefined
    const m = this.items.get(id)
    if (m) {
      m.lastUsed = Date.now()
      this.usedSinceSave = true
    }
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
      if (m) {
        m.lastUsed = Date.now()
        this.usedSinceSave = true
      }
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
    this.touch()
    if (m) await rm(m.path, { force: true }).catch(() => {})
    if (m) {
      for (const listener of this.removeListeners) {
        try {
          listener(id)
        } catch (err) {
          console.error('Aufräumen nach dem Löschen eines Videos fehlgeschlagen:', err)
        }
      }
    }
  }

  /** Entfernt Videos, die länger als die TTL nicht benutzt wurden. */
  async sweep(now = Date.now()): Promise<void> {
    for (const [id, m] of this.items) {
      if ((this.inUse.get(id) ?? 0) > 0) continue
      if (now - m.lastUsed > this.ttlMs) await this.removeNow(id)
    }
    // Letzte Benutzung gelegentlich festhalten, damit die Frist einen Neustart übersteht.
    if (this.usedSinceSave) this.touch()
  }

  async shutdown(): Promise<void> {
    clearInterval(this.sweeper)
    if (this.persist) {
      // Dateien bleiben liegen; nach dem Neustart liest `init` sie wieder ein.
      this.touch()
      await this.flush()
      return
    }
    for (const id of [...this.items.keys()]) await this.removeNow(id)
  }
}

export const mediaStore = new MediaStore(
  config.mediaTtlMs,
  config.maxMediaTotalBytes,
  config.mediaIndexFile ? { indexFile: config.mediaIndexFile, baseDir: config.tmpDir } : undefined,
)
