import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { config } from '../../config'
import { MAX_GRAPHIC_BYTES, MAX_GRAPHIC_DIM, pngSize } from '../graphicOverlay'
import { ValidationError } from '../validate'
import type { RenderGraphic } from './compile'
import type { RenderDoc } from './doc'

/**
 * Grafiken des Timeline-Editors (Formen, Symbole, Emojis).
 *
 * Der Browser zeichnet jede Grafik als PNG und lädt sie einmal hoch. Die ID
 * ist der Hash des Inhalts: Gleiches Bild = gleiche ID, und der Schlüssel
 * eines Vorschau-Abschnitts ändert sich genau dann, wenn sich das Bild ändert.
 * Der Ordner ist ein Zwischenspeicher – fehlt ein Bild, lädt der Editor es
 * erneut hoch.
 */

const ID_RE = /^[0-9a-f]{32}$/

export function isGraphicId(v: unknown): v is string {
  return typeof v === 'string' && ID_RE.test(v)
}

export interface StoredGraphic {
  id: string
  path: string
  width: number
  height: number
}

interface Entry {
  width: number
  height: number
  size: number
  lastUsed: number
}

export interface GraphicStoreOptions {
  dir?: string
  maxBytes?: number
}

export class GraphicStore {
  private dir: string
  private maxBytes: number
  private items = new Map<string, Entry>()

  constructor(opts: GraphicStoreOptions = {}) {
    this.dir = opts.dir ?? config.graphicsDir
    this.maxBytes = opts.maxBytes ?? config.graphicsCacheBytes
  }

  private path(id: string): string {
    return path.join(this.dir, `${id}.png`)
  }

  /** Beim Start: vorhandene Bilder übernehmen, alles andere im Ordner löschen. */
  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    for (const name of await readdir(this.dir).catch(() => [] as string[])) {
      const file = path.join(this.dir, name)
      const id = name.endsWith('.png') ? name.slice(0, -4) : ''
      const st = isGraphicId(id) ? await stat(file).catch(() => null) : null
      const size = st?.isFile() ? pngSize(await readHead(file)) : null
      if (!st || !size) {
        await rm(file, { recursive: true, force: true }).catch(() => {})
        continue
      }
      this.items.set(id, { ...size, size: st.size, lastUsed: st.mtimeMs })
    }
    await this.evict()
  }

  /** Bild prüfen und ablegen; dasselbe Bild erneut hochzuladen ändert nichts. */
  async put(png: Buffer): Promise<StoredGraphic> {
    if (png.length > MAX_GRAPHIC_BYTES) throw new ValidationError('Die Grafik ist zu groß.', 413)
    const size = pngSize(png)
    if (!size) throw new ValidationError('Die Grafik ist kein PNG-Bild.')
    if (size.width > MAX_GRAPHIC_DIM || size.height > MAX_GRAPHIC_DIM)
      throw new ValidationError('Die Grafik ist zu groß.', 413)
    const id = createHash('sha256').update(png).digest('hex').slice(0, 32)
    const known = this.items.get(id)
    if (known) {
      known.lastUsed = Date.now()
    } else {
      const tmp = path.join(this.dir, `${id}.${process.pid}.${Date.now()}.part`)
      await writeFile(tmp, png)
      await rename(tmp, this.path(id))
      this.items.set(id, { ...size, size: png.length, lastUsed: Date.now() })
      await this.evict(id)
    }
    return { id, path: this.path(id), ...size }
  }

  /** Abgelegtes Bild (zählt als Benutzung) oder `undefined`. */
  get(id: string): StoredGraphic | undefined {
    const item = isGraphicId(id) ? this.items.get(id) : undefined
    if (!item) return undefined
    item.lastUsed = Date.now()
    return { id, path: this.path(id), width: item.width, height: item.height }
  }

  /** Auf die Obergrenze kürzen: am längsten Ungenutztes zuerst (nie `keep`). */
  private async evict(keep?: string): Promise<void> {
    let total = 0
    for (const item of this.items.values()) total += item.size
    if (total <= this.maxBytes) return
    const oldest = [...this.items.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)
    for (const [id, item] of oldest) {
      if (total <= this.maxBytes) break
      if (id === keep) continue
      this.items.delete(id)
      total -= item.size
      await rm(this.path(id), { force: true }).catch(() => {})
    }
  }

  /** Zugriffszeiten sichern, damit nach dem Neustart das Richtige zuerst weicht. */
  async shutdown(): Promise<void> {
    await Promise.all(
      [...this.items.entries()].map(([id, item]) => {
        const t = new Date(item.lastUsed)
        return utimes(this.path(id), t, t).catch(() => {})
      }),
    )
  }
}

/**
 * Bilder zu den Grafik-Clips eines Dokuments. `missing`: IDs, deren Bild nicht
 * (mehr) auf dem Server liegt – der Editor lädt sie erneut hoch.
 */
export function resolveDocGraphics(
  doc: RenderDoc,
  lookup: (id: string) => RenderGraphic | undefined,
): { graphics: Record<string, RenderGraphic>; missing: string[] } {
  const graphics: Record<string, RenderGraphic> = {}
  const missing = new Set<string>()
  for (const track of doc.tracks) {
    if (track.kind !== 'overlay') continue
    for (const clip of track.clips) {
      const id = clip.graphic?.png
      if (!id || graphics[id] || missing.has(id)) continue
      const found = lookup(id)
      if (found) graphics[id] = { path: found.path, width: found.width, height: found.height }
      else missing.add(id)
    }
  }
  return { graphics, missing: [...missing] }
}

/** Anfang der Datei (PNG-Kopf mit den Maßen). */
async function readHead(file: string): Promise<Buffer> {
  try {
    return (await readFile(file)).subarray(0, 64)
  } catch {
    return Buffer.alloc(0)
  }
}

export const graphicStore = new GraphicStore()
