import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { config } from '../config'
import { runFfmpeg } from './ffmpeg'

/**
 * Galerie der KI-Bilder: Jedes erzeugte Bild wird dauerhaft in einem Ordner
 * auf dem Server abgelegt (übersteht Neustarts und Deploys) und kann dort
 * angesehen, wiederverwendet, heruntergeladen und gelöscht werden.
 *
 * Dateien je Bild:
 *   <galleryDir>/<id>.<png|jpg|webp>   Original von Gemini
 *   <galleryDir>/<id>.thumb.jpg        Vorschau (max. 480 px, optional)
 *   <galleryDir>/<id>.json             Metadaten (Prompt, Zeit, Größe)
 */

export interface GalleryImage {
  id: string
  mime: string
  /** Prompt, mit dem das Bild erzeugt wurde. */
  prompt: string
  createdAt: number
  /** Dateigröße des Originals in Bytes. */
  size: number
}

export class GalleryFullError extends Error {}

const EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
}

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function isGalleryId(v: unknown): v is string {
  return typeof v === 'string' && ID_RE.test(v)
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Prüft eine Metadaten-Datei; `null` = unbrauchbar. */
export function parseGalleryMeta(raw: unknown): GalleryImage | null {
  if (!isRecord(raw) || !isGalleryId(raw.id)) return null
  const mime = String(raw.mime ?? '')
  if (!EXT[mime]) return null
  return {
    id: raw.id,
    mime,
    prompt: typeof raw.prompt === 'string' ? raw.prompt : '',
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : 0,
    size: typeof raw.size === 'number' && raw.size >= 0 ? raw.size : 0,
  }
}

export class Gallery {
  private items = new Map<string, GalleryImage>()
  private ready: Promise<void> | null = null

  constructor(
    private dir: string,
    private maxTotalBytes: number,
    /** Vorschau erzeugen (austauschbar für Tests). */
    private makeThumb: (src: string, out: string) => Promise<void> = ffmpegThumb,
  ) {}

  /** Liest den Ordner einmal ein (legt ihn bei Bedarf an). */
  init(): Promise<void> {
    this.ready ??= (async () => {
      await mkdir(this.dir, { recursive: true })
      for (const name of await readdir(this.dir)) {
        if (!name.endsWith('.json')) continue
        try {
          const meta = parseGalleryMeta(
            JSON.parse(await readFile(path.join(this.dir, name), 'utf8')),
          )
          if (!meta) continue
          // Metadaten ohne Bilddatei (z. B. von Hand gelöscht) überspringen.
          await stat(this.filePath(meta))
          this.items.set(meta.id, meta)
        } catch {
          /* kaputter Eintrag – ignorieren */
        }
      }
    })()
    return this.ready
  }

  private filePath(img: GalleryImage): string {
    return path.join(this.dir, `${img.id}.${EXT[img.mime]}`)
  }

  private thumbPath(id: string): string {
    return path.join(this.dir, `${id}.thumb.jpg`)
  }

  get totalBytes(): number {
    let n = 0
    for (const i of this.items.values()) n += i.size
    return n
  }

  /** Neueste zuerst. */
  list(): GalleryImage[] {
    return [...this.items.values()].sort((a, b) => b.createdAt - a.createdAt)
  }

  get(id: string): GalleryImage | undefined {
    return this.items.get(id)
  }

  /** Speichert ein Bild. Wirft GalleryFullError, wenn das Limit erreicht ist. */
  async add(data: Buffer, mime: string, prompt: string): Promise<GalleryImage> {
    await this.init()
    if (!EXT[mime]) throw new Error('Bildformat nicht unterstützt.')
    if (this.totalBytes + data.length > this.maxTotalBytes) {
      throw new GalleryFullError('Die Galerie ist voll. Bitte alte Bilder löschen.')
    }
    const img: GalleryImage = {
      id: randomUUID(),
      mime,
      prompt: prompt.slice(0, 2000),
      createdAt: Date.now(),
      size: data.length,
    }
    const file = this.filePath(img)
    await writeFile(file, data)
    await this.makeThumb(file, this.thumbPath(img.id)).catch(() => {
      /* ohne Vorschau wird das Original gezeigt */
    })
    // Metadaten zuletzt: Ein Eintrag gilt erst mit JSON als vorhanden.
    await writeFile(path.join(this.dir, `${img.id}.json`), JSON.stringify(img))
    this.items.set(img.id, img)
    return img
  }

  /** Pfad des Originals bzw. der Vorschau (Original, falls keine Vorschau da ist). */
  async pathOf(id: string, thumb: boolean): Promise<{ path: string; mime: string } | null> {
    await this.init()
    const img = this.items.get(id)
    if (!img) return null
    if (thumb) {
      const t = this.thumbPath(id)
      try {
        await stat(t)
        return { path: t, mime: 'image/jpeg' }
      } catch {
        /* Original nehmen */
      }
    }
    return { path: this.filePath(img), mime: img.mime }
  }

  async remove(id: string): Promise<boolean> {
    await this.init()
    const img = this.items.get(id)
    if (!img) return false
    this.items.delete(id)
    await Promise.all(
      [this.filePath(img), this.thumbPath(id), path.join(this.dir, `${id}.json`)].map((f) =>
        rm(f, { force: true }),
      ),
    )
    return true
  }
}

async function ffmpegThumb(src: string, out: string): Promise<void> {
  await runFfmpeg(
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      src,
      '-frames:v',
      '1',
      '-vf',
      'scale=480:480:force_original_aspect_ratio=decrease',
      '-q:v',
      '4',
      '-y',
      out,
    ],
    0,
    () => {},
  ).promise
}

export const gallery = new Gallery(config.galleryDir, config.maxGalleryTotalBytes)
