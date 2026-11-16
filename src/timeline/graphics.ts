import {
  clampGraphic,
  defaultGraphic,
  lookKey,
  renderGraphic,
  type GraphicData,
  type GraphicKind,
} from '@/lib/graphicOverlay'
import { uploadGraphic } from '@/lib/graphicsApi'
import type { OverlayClip, TimelineDoc } from '@/timeline/model'

/**
 * Formen, Symbole und Emojis auf Ebenen-Spuren.
 *
 * Im Dokument stehen nur die Einstellungen (Art, Größe, Farben, Lage,
 * Animation). Gezeichnet wird im Browser: Vor dem Senden an den Server
 * (Vorschau, Export) wird je Aussehen ein PNG erzeugt, einmal hochgeladen und
 * seine ID in die gesendete Kopie des Dokuments geschrieben. Das Dokument im
 * Editor bleibt davon unberührt – Rückgängig und Speichern kennen keine IDs.
 */

/** Arten, die der neue Editor anlegen kann (Bilder folgen später). */
export const TIMELINE_GRAPHIC_KINDS = [
  'rect',
  'ellipse',
  'bubble',
  'line',
  'arrow',
  'symbol',
  'emoji',
] as const satisfies readonly GraphicKind[]
export type TimelineGraphicKind = (typeof TIMELINE_GRAPHIC_KINDS)[number]

/** Länge einer neu angelegten Grafik in Sekunden. */
export const DEFAULT_GRAPHIC_DURATION = 3

export function isTimelineGraphicKind(v: unknown): v is TimelineGraphicKind {
  return (TIMELINE_GRAPHIC_KINDS as readonly unknown[]).includes(v)
}

/** Daten eines neuen Grafik-Clips: Standardwerte der Art, in der Bildmitte. */
export function newGraphicData(kind: TimelineGraphicKind): Record<string, unknown> {
  return { ...defaultGraphic(kind), animSpeed: 1, x: 0.5, y: 0.5 }
}

/**
 * Einstellungen eines Grafik-Clips, vollständig und in gültigen Grenzen.
 * Fehlendes oder Falsches (z. B. aus älteren Ständen) fällt auf den Standard
 * der Art zurück. Zeiten spielen hier keine Rolle – die trägt der Clip.
 */
export function clipGraphic(data: Record<string, unknown>): GraphicData {
  const kind: TimelineGraphicKind = isTimelineGraphicKind(data.kind) ? data.kind : 'rect'
  const merged: Record<string, unknown> = { ...defaultGraphic(kind), animSpeed: 1, x: 0.5, y: 0.5 }
  for (const key of Object.keys(merged)) {
    const value = data[key]
    if (key !== 'kind' && typeof value === typeof merged[key]) merged[key] = value
  }
  return clampGraphic({ ...(merged as unknown as GraphicData), start: 0, end: 1 })
}

/** Hat die Grafik etwas zu zeigen? (Emoji ohne Zeichen: nein.) */
export function isDrawable(g: GraphicData): boolean {
  return g.kind !== 'emoji' || g.emoji.trim() !== ''
}

export type GraphicDrawer = (g: GraphicData, height: number) => Promise<Blob>
export type GraphicUploader = (png: Blob, signal?: AbortSignal) => Promise<{ id: string }>

/** Zeichnet die Grafik für die Projekthöhe und liefert sie als PNG. */
export const drawGraphicPng: GraphicDrawer = (g, height) =>
  new Promise((resolve, reject) => {
    renderGraphic(g, height).toBlob(
      (blob) =>
        blob ? resolve(blob) : reject(new Error('Grafik konnte nicht gezeichnet werden.')),
      'image/png',
    )
  })

/** So viele Aussehen merkt sich der Editor höchstens (älteste fliegen zuerst). */
const MAX_REMEMBERED = 300

/**
 * Merkt sich je Aussehen die ID des hochgeladenen Bildes. Gleiches Aussehen
 * (auch bei mehreren Clips oder nach „Rückgängig“) wird nur einmal gezeichnet
 * und hochgeladen.
 */
export class GraphicImages {
  private ready = new Map<string, string>()
  private pending = new Map<string, Promise<string>>()

  constructor(
    private upload: GraphicUploader = uploadGraphic,
    private draw: GraphicDrawer = drawGraphicPng,
  ) {}

  private ensure(look: string, g: GraphicData, height: number): Promise<string> {
    const known = this.ready.get(look)
    if (known !== undefined) return Promise.resolve(known)
    let job = this.pending.get(look)
    if (!job) {
      job = this.draw(g, height)
        .then((png) => this.upload(png))
        .then(({ id }) => {
          this.ready.set(look, id)
          for (const old of this.ready.keys()) {
            if (this.ready.size <= MAX_REMEMBERED) break
            this.ready.delete(old)
          }
          return id
        })
        .finally(() => this.pending.delete(look))
      this.pending.set(look, job)
    }
    return job
  }

  /**
   * Kopie des Dokuments für den Server: Jeder Grafik-Clip nennt die ID seines
   * Bildes und die Höhe, für die es gezeichnet wurde. Fehlende Bilder werden
   * vorher gezeichnet und hochgeladen. Ohne Grafiken kommt das Dokument
   * unverändert zurück.
   */
  async prepare(doc: TimelineDoc): Promise<TimelineDoc> {
    const height = doc.settings.height
    const jobs = new Map<string, Promise<string>>()
    for (const track of doc.tracks) {
      if (track.kind !== 'overlay') continue
      for (const clip of track.clips) {
        if (clip.kind !== 'graphic') continue
        const g = clipGraphic(clip.data)
        if (!isDrawable(g)) continue
        jobs.set(clip.id, this.ensure(lookKey(g, height), g, height))
      }
    }
    if (jobs.size === 0) return doc
    const ids = new Map<string, string>()
    await Promise.all([...jobs].map(async ([clipId, job]) => ids.set(clipId, await job)))
    return {
      ...doc,
      tracks: doc.tracks.map((track) => {
        if (track.kind !== 'overlay' || !track.clips.some((c) => ids.has(c.id))) return track
        return {
          ...track,
          clips: track.clips.map((clip): OverlayClip => {
            const png = ids.get(clip.id)
            if (png === undefined) return clip
            const g = clipGraphic(clip.data)
            return {
              ...clip,
              data: {
                kind: g.kind,
                x: g.x,
                y: g.y,
                animation: g.animation,
                loop: g.loop,
                animSpeed: g.animSpeed ?? 1,
                png,
                renderHeight: height,
              },
            }
          }),
        }
      }),
    }
  }

  /** Der Server hat diese Bilder nicht mehr: beim nächsten Mal neu hochladen. */
  forget(ids: readonly string[]): void {
    const gone = new Set(ids)
    for (const [look, id] of this.ready) if (gone.has(id)) this.ready.delete(look)
  }
}

export const graphicImages = new GraphicImages()
