import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import {
  copyFile,
  link,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { Transform, type Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { config } from '../config'
import { isMediaId, mediaStore, mediaView, type MediaStore, type MediaView } from './media'
import type { MediaInfo } from './probe'
import { ValidationError } from './validate'

/**
 * Gespeicherte Projekte: Bearbeitungsstand (JSON, vom Browser geliefert) plus
 * eigene Kopien der Videos und der Zusatzdateien (Bilder, Musik).
 *
 * Videos der Bibliothek sind nur temporär (Auto-Aufräumen, Neustart). Ein
 * Projekt verlinkt (Hardlink, sonst Kopie) die Videodatei deshalb in seinen
 * eigenen Ordner. Beim Öffnen wird jede Projektdatei wieder als Bibliotheks-
 * Video angemeldet.
 *
 * Ordner je Projekt:
 *   <projectsDir>/<id>/project.json
 *   <projectsDir>/<id>/media/<token><ext>
 *   <projectsDir>/<id>/assets/<sha256>
 */

/** Ein Video des Projekts. Schlüssel = Token, auf den der Bearbeitungsstand verweist. */
interface ProjectMedia {
  file: string
  name: string
  size: number
  info: MediaInfo
  /** Zuletzt dazu angemeldetes Bibliotheks-Video (Wiedererkennen beim Speichern). */
  liveId: string | null
}

/** Zusatzdatei (Bild, Musik), Schlüssel = SHA-256. */
interface ProjectAsset {
  size: number
  type: string
  name: string
}

interface ProjectFile {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  state: unknown
  media: Record<string, ProjectMedia>
  assets: Record<string, ProjectAsset>
}

/** Listeneintrag. */
export interface ProjectSummary {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  videoCount: number
  /** Belegter Speicher (Videos + Zusatzdateien) in Bytes. */
  size: number
}

export interface AssetRef {
  hash: string
  size: number
  type: string
  name: string
}

export interface SaveInput {
  /** Bestehendes Projekt überschreiben; fehlt = neues Projekt. */
  id?: string
  name: string
  state: unknown
  /** Bibliotheks-Videos (bzw. Tokens), auf die der Stand verweist. */
  media: string[]
  assets: AssetRef[]
}

export interface SaveResult {
  project: ProjectSummary
  /** Zusatzdateien, die der Browser noch hochladen muss. */
  missingAssets: string[]
}

/** Videos, die weder im Projekt noch in der Bibliothek liegen -> Browser lädt neu hoch. */
export class MissingMediaError extends Error {
  statusCode = 409
  constructor(public readonly missing: string[]) {
    super('Einige Videos sind nicht mehr auf dem Server.')
    this.name = 'MissingMediaError'
  }
}

export class ProjectNotFoundError extends Error {
  statusCode = 404
  constructor() {
    super('Projekt nicht gefunden.')
    this.name = 'ProjectNotFoundError'
  }
}

export class ProjectStorageFullError extends Error {
  statusCode = 507
  constructor() {
    super('Projektspeicher auf dem Server ist voll. Bitte alte Projekte löschen.')
    this.name = 'ProjectStorageFullError'
  }
}

const HASH_RE = /^[0-9a-f]{64}$/
export const isAssetHash = (v: unknown): v is string => typeof v === 'string' && HASH_RE.test(v)
export const isProjectId = isMediaId

/** Höchstzahl Videos / Zusatzdateien je Projekt. */
export const MAX_PROJECT_MEDIA = 50
export const MAX_PROJECT_ASSETS = 200
/** Größte Zusatzdatei (Bilder bis 30 MB, Musik). */
export const MAX_ASSET_BYTES = 200 * 1024 * 1024
const MAX_NAME = 120

/** Projektname: Steuerzeichen entfernen, Länge begrenzen. */
export function projectName(v: unknown): string {
  // eslint-disable-next-line no-control-regex
  const s = typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim() : ''
  if (!s) throw new ValidationError('Bitte einen Projektnamen angeben.')
  return s.slice(0, MAX_NAME)
}

/** Prüft die Eingabe beim Speichern (Struktur, Grenzen). */
export function parseSaveInput(body: unknown): SaveInput {
  const b = (body ?? {}) as Record<string, unknown>
  const id = b.id === undefined || b.id === null ? undefined : b.id
  if (id !== undefined && !isProjectId(id)) throw new ValidationError('Ungültige Projekt-ID.')
  if (b.state === null || typeof b.state !== 'object') {
    throw new ValidationError('Bearbeitungsstand fehlt.')
  }
  if (!Array.isArray(b.media) || b.media.length > MAX_PROJECT_MEDIA) {
    throw new ValidationError('Ungültige Videoliste.')
  }
  if (!b.media.every(isMediaId)) throw new ValidationError('Ungültige Video-ID.')
  if (!Array.isArray(b.assets) || b.assets.length > MAX_PROJECT_ASSETS) {
    throw new ValidationError('Ungültige Dateiliste.')
  }
  const assets: AssetRef[] = b.assets.map((a: unknown) => {
    const r = (a ?? {}) as Record<string, unknown>
    const size = Number(r.size)
    if (!isAssetHash(r.hash) || !Number.isInteger(size) || size < 0 || size > MAX_ASSET_BYTES) {
      throw new ValidationError('Ungültige Datei im Projekt.')
    }
    const type = typeof r.type === 'string' ? r.type.slice(0, 100) : ''
    // eslint-disable-next-line no-control-regex
    const name = typeof r.name === 'string' ? r.name.replace(/[\u0000-\u001f\u007f"]/g, '') : ''
    return { hash: r.hash, size, type, name: name.slice(0, 200) || 'datei' }
  })
  return {
    id,
    name: projectName(b.name),
    state: b.state,
    media: [...new Set(b.media as string[])],
    assets,
  }
}

function summary(p: ProjectFile): ProjectSummary {
  let size = 0
  for (const m of Object.values(p.media)) size += m.size
  for (const a of Object.values(p.assets)) size += a.size
  return {
    id: p.id,
    name: p.name,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    videoCount: Object.keys(p.media).length,
    size,
  }
}

/** Hardlink (gleiche Partition, kein Platzbedarf), sonst Kopie. */
async function linkOrCopy(src: string, dest: string): Promise<void> {
  try {
    await link(src, dest)
  } catch {
    await copyFile(src, dest)
  }
}

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  )

export class ProjectStore {
  /** Speichervorgänge je Projekt nacheinander (keine halb überschriebenen Stände). */
  private locks = new Map<string, Promise<unknown>>()

  constructor(
    private dir = config.projectsDir,
    private media: MediaStore = mediaStore,
    private maxTotalBytes = config.maxProjectsTotalBytes,
    private tmpDir = config.tmpDir,
  ) {}

  private projectDir(id: string): string {
    return path.join(this.dir, id)
  }

  private async withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(id) ?? Promise.resolve()
    const run = prev.catch(() => {}).then(fn)
    this.locks.set(id, run)
    try {
      return await run
    } finally {
      if (this.locks.get(id) === run) this.locks.delete(id)
    }
  }

  private async read(id: string): Promise<ProjectFile> {
    if (!isProjectId(id)) throw new ProjectNotFoundError()
    try {
      const raw = await readFile(path.join(this.projectDir(id), 'project.json'), 'utf8')
      return JSON.parse(raw) as ProjectFile
    } catch {
      throw new ProjectNotFoundError()
    }
  }

  /** Atomar schreiben (Absturz mitten im Schreiben lässt den alten Stand stehen). */
  private async write(p: ProjectFile): Promise<void> {
    const file = path.join(this.projectDir(p.id), 'project.json')
    const tmp = `${file}.${randomUUID()}.tmp`
    await writeFile(tmp, JSON.stringify(p))
    await rename(tmp, file)
  }

  async list(): Promise<ProjectSummary[]> {
    let ids: string[] = []
    try {
      ids = (await readdir(this.dir)).filter(isProjectId)
    } catch {
      return []
    }
    const out: ProjectSummary[] = []
    for (const id of ids) {
      try {
        out.push(summary(await this.read(id)))
      } catch {
        // Unvollständiger Ordner (z. B. Absturz beim Anlegen) -> überspringen.
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async totalBytes(): Promise<number> {
    let sum = 0
    for (const p of await this.list()) sum += p.size
    return sum
  }

  async get(id: string): Promise<{ project: ProjectSummary; state: unknown }> {
    const p = await this.read(id)
    return { project: summary(p), state: p.state }
  }

  /**
   * Speichert den Stand. Videos werden aus der Bibliothek übernommen, sofern
   * das Projekt sie noch nicht hat. Wirft MissingMediaError, wenn ein Video
   * weder im Projekt noch in der Bibliothek liegt.
   */
  async save(input: SaveInput): Promise<SaveResult> {
    const id = input.id ?? randomUUID()
    return this.withLock(id, async () => {
      const now = Date.now()
      let old: ProjectFile | null = null
      if (input.id) old = await this.read(input.id) // 404, falls gelöscht
      const dir = this.projectDir(id)
      await mkdir(path.join(dir, 'media'), { recursive: true })
      await mkdir(path.join(dir, 'assets'), { recursive: true })

      const oldMedia = old?.media ?? {}
      const byLive = new Map<string, string>()
      for (const [token, m] of Object.entries(oldMedia)) if (m.liveId) byLive.set(m.liveId, token)

      // Was fehlt? (vor jeder Änderung prüfen)
      const missing = input.media.filter(
        (mid) => !oldMedia[mid] && !byLive.has(mid) && !this.media.has(mid),
      )
      if (missing.length) throw new MissingMediaError(missing)

      // Neue Videos: Platz prüfen (Hardlinks zählen voll – vorsichtige Schätzung).
      let added = 0
      for (const mid of input.media) {
        if (oldMedia[mid] || byLive.has(mid)) continue
        added += this.media.get(mid)?.size ?? 0
      }
      for (const a of input.assets) if (!old?.assets[a.hash]) added += a.size
      if (added > 0 && (await this.totalBytes()) + added > this.maxTotalBytes) {
        throw new ProjectStorageFullError()
      }

      const media: Record<string, ProjectMedia> = {}
      const created: string[] = []
      try {
        for (const mid of input.media) {
          const reuse = oldMedia[mid] ? mid : byLive.get(mid)
          if (reuse) {
            media[mid] = { ...oldMedia[reuse], liveId: oldMedia[reuse].liveId }
            continue
          }
          const item = this.media.get(mid)
          if (!item) throw new MissingMediaError([mid])
          this.media.acquire([mid])
          try {
            const file = `${randomUUID()}${path.extname(item.path).slice(0, 10)}`
            await linkOrCopy(item.path, path.join(dir, 'media', file))
            created.push(file)
            media[mid] = { file, name: item.name, size: item.size, info: item.info, liveId: mid }
          } finally {
            await this.media.release([mid])
          }
        }
      } catch (err) {
        for (const f of created) await rm(path.join(dir, 'media', f), { force: true })
        if (!old) await rm(dir, { recursive: true, force: true })
        throw err
      }

      const assets: Record<string, ProjectAsset> = {}
      for (const a of input.assets) assets[a.hash] = { size: a.size, type: a.type, name: a.name }

      const next: ProjectFile = {
        id,
        name: input.name,
        createdAt: old?.createdAt ?? now,
        updatedAt: now,
        state: input.state,
        media,
        assets,
      }
      await this.write(next)

      // Nicht mehr benutzte Dateien entfernen.
      const keepFiles = new Set(Object.values(media).map((m) => m.file))
      for (const m of Object.values(oldMedia)) {
        if (!keepFiles.has(m.file)) await rm(path.join(dir, 'media', m.file), { force: true })
      }
      const missingAssets: string[] = []
      for (const h of Object.keys(old?.assets ?? {})) {
        if (!assets[h]) await rm(path.join(dir, 'assets', h), { force: true })
      }
      for (const h of Object.keys(assets)) {
        if (!(await exists(path.join(dir, 'assets', h)))) missingAssets.push(h)
      }
      return { project: summary(next), missingAssets }
    })
  }

  /**
   * Nimmt eine Zusatzdatei entgegen (Stream). Die Prüfsumme muss stimmen und
   * die Datei im Projekt angemeldet sein.
   */
  async putAsset(id: string, hash: string, body: Readable): Promise<void> {
    const p = await this.read(id)
    const meta = p.assets[hash]
    if (!meta) throw new ValidationError('Datei gehört nicht zum Projekt.')
    const dest = path.join(this.projectDir(id), 'assets', hash)
    const tmp = `${dest}.${randomUUID()}.tmp`
    const sha = createHash('sha256')
    let bytes = 0
    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        bytes += chunk.length
        if (bytes > meta.size || bytes > MAX_ASSET_BYTES) {
          cb(new ValidationError('Datei größer als angemeldet.'))
          return
        }
        sha.update(chunk)
        cb(null, chunk)
      },
    })
    try {
      await pipeline(body, meter, createWriteStream(tmp))
      if (bytes !== meta.size || sha.digest('hex') !== hash) {
        throw new ValidationError('Datei beschädigt (Prüfsumme stimmt nicht).')
      }
      await rename(tmp, dest)
    } catch (err) {
      await rm(tmp, { force: true })
      throw err
    }
  }

  /** Pfad und Typ einer Zusatzdatei. */
  async asset(id: string, hash: string): Promise<{ path: string; type: string; name: string }> {
    const p = await this.read(id)
    const meta = p.assets[hash]
    const file = path.join(this.projectDir(id), 'assets', hash)
    if (!meta || !(await exists(file))) throw new ProjectNotFoundError()
    return { path: file, type: meta.type || 'application/octet-stream', name: meta.name }
  }

  /**
   * Meldet die Videos des Projekts wieder in der Bibliothek an (Hardlink in
   * das Arbeitsverzeichnis). Liefert je Token das Bibliotheks-Video.
   */
  async open(id: string): Promise<Record<string, MediaView>> {
    return this.withLock(id, async () => {
      const p = await this.read(id)
      const out: Record<string, MediaView> = {}
      const added: string[] = []
      try {
        for (const [token, m] of Object.entries(p.media)) {
          // Noch angemeldet (z. B. gerade gespeichert) -> wiederverwenden.
          const live = m.liveId ? this.media.get(m.liveId) : undefined
          if (live) {
            out[token] = mediaView(live)
            continue
          }
          const src = path.join(this.projectDir(id), 'media', m.file)
          const dest = path.join(this.tmpDir, `${randomUUID()}-media${path.extname(m.file)}`)
          await linkOrCopy(src, dest)
          try {
            const item = await this.media.add(dest, m.name, m.info, m.size)
            added.push(item.id)
            m.liveId = item.id
            out[token] = mediaView(item)
          } catch (err) {
            await rm(dest, { force: true })
            throw err
          }
        }
      } catch (err) {
        for (const mid of added) await this.media.remove(mid)
        throw err
      }
      await this.write(p)
      return out
    })
  }

  async remove(id: string): Promise<boolean> {
    if (!isProjectId(id)) return false
    return this.withLock(id, async () => {
      if (!(await exists(path.join(this.projectDir(id), 'project.json')))) return false
      await rm(this.projectDir(id), { recursive: true, force: true })
      return true
    })
  }
}

export const projectStore = new ProjectStore()
