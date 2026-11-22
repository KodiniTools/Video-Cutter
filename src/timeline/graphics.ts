import { animParts, animSpeedOf, OUT_ANIMATIONS } from '@/lib/textOverlay'
import {
  clampGraphic,
  defaultGraphic,
  lookKey,
  MAX_CROP,
  MAX_GRAPHIC_W,
  MIN_GRAPHIC_SIZE,
  renderGraphic,
  type GraphicData,
  type GraphicKind,
} from '@/lib/graphicOverlay'
import { graphicKeys, graphicSmooth } from './graphicKeys'
import { uploadGraphic } from '@/lib/graphicsApi'
import { hasImageAsset } from '@/lib/imageAssets'
import type { OverlayClip, TimelineDoc } from '@/timeline/model'

/**
 * Formen, Symbole, Emojis und eigene Bilder auf Ebenen-Spuren.
 *
 * Im Dokument stehen nur die Einstellungen (Art, Größe, Farben, Lage,
 * Animation). Gezeichnet wird im Browser: Vor dem Senden an den Server
 * (Vorschau, Export) wird je Aussehen ein PNG erzeugt, einmal hochgeladen und
 * seine ID in die gesendete Kopie des Dokuments geschrieben. Das Dokument im
 * Editor bleibt davon unberührt – Rückgängig und Speichern kennen keine IDs.
 *
 * Eigene Bilder bleiben im Browser (`imageAssets`): Der Clip nennt die ID des
 * geladenen Bildes, der Server sieht nur das fertig bearbeitete PNG.
 */

/** Arten zum Anlegen aus der Liste (Bilder kommen über „+ Bild“ dazu). */
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
export function newGraphicData(kind: TimelineGraphicKind | 'image'): Record<string, unknown> {
  return { ...defaultGraphic(kind), animSpeed: 1, x: 0.5, y: 0.5 }
}

/** Daten eines neuen Bild-Clips zu einem geladenen Bild (siehe `imageAssets`). */
export function newImageData(imageId: string): Record<string, unknown> {
  return { ...newGraphicData('image'), image: imageId }
}

/**
 * Einstellungen eines Grafik-Clips, vollständig und in gültigen Grenzen.
 * Fehlendes oder Falsches (z. B. aus älteren Ständen) fällt auf den Standard
 * der Art zurück. Zeiten spielen hier keine Rolle – die trägt der Clip.
 */
export function clipGraphic(data: Record<string, unknown>): GraphicData {
  const kind: GraphicKind =
    isTimelineGraphicKind(data.kind) || data.kind === 'image' ? data.kind : 'rect'
  const merged: Record<string, unknown> = { ...defaultGraphic(kind), animSpeed: 1, x: 0.5, y: 0.5 }
  for (const key of Object.keys(merged)) {
    const value = data[key]
    if (key !== 'kind' && typeof value === typeof merged[key]) merged[key] = value
  }
  return clampGraphic({ ...(merged as unknown as GraphicData), start: 0, end: 1 })
}

/** Wie ein Bild die Bildfläche (das Projektformat) einnimmt. */
export const IMAGE_FITS = ['contain', 'cover', 'stretch'] as const
export type ImageFit = (typeof IMAGE_FITS)[number]

const round4 = (v: number) => Math.round(v * 10000) / 10000

/**
 * Bild an die Bildfläche anpassen. Ergebnis: Änderungen für `clip.data`.
 *  - `contain` (Anpassen): ganzes Bild sichtbar, Seitenverhältnis bleibt.
 *  - `cover` (Ausfüllen): Fläche ganz bedeckt, Seitenverhältnis bleibt; der
 *    Überstand wird mittig zugeschnitten (höchstens `MAX_CROP` je Seite).
 *  - `stretch` (Strecken): genau die Fläche, Seitenverhältnis wird verzerrt.
 * Immer: mittig, ohne Drehung, bisheriger Zuschnitt und Keyframes verworfen
 * (sie würden das Ergebnis wieder verschieben).
 * `frame` = Projektformat in Pixel, `image` = Originalgröße des Bildes.
 */
export function fitImageData(
  mode: ImageFit,
  frame: { width: number; height: number },
  image: { width: number; height: number },
): Record<string, unknown> {
  const frameAr = frame.width > 0 && frame.height > 0 ? frame.width / frame.height : 16 / 9
  const imageAr = image.width > 0 && image.height > 0 ? image.width / image.height : frameAr
  const base = {
    x: 0.5,
    y: 0.5,
    rotation: 0,
    cropL: 0,
    cropR: 0,
    cropT: 0,
    cropB: 0,
    stretch: false,
    keys: [],
  }
  const w = (v: number) => round4(Math.min(MAX_GRAPHIC_W, Math.max(MIN_GRAPHIC_SIZE, v)))
  switch (mode) {
    case 'contain':
      return { ...base, w: w(Math.min(frameAr, imageAr)) }
    case 'stretch':
      return { ...base, stretch: true, w: w(frameAr), h: 1 }
    case 'cover': {
      if (Math.abs(imageAr - frameAr) < 1e-6) return { ...base, w: w(frameAr) }
      if (imageAr > frameAr) {
        // Zu breit: links und rechts abschneiden.
        const c = round4(Math.min(MAX_CROP, (1 - frameAr / imageAr) / 2))
        const ar = imageAr * (1 - 2 * c)
        return { ...base, cropL: c, cropR: c, w: w(Math.max(frameAr, ar)) }
      }
      // Zu hoch: oben und unten abschneiden.
      const c = round4(Math.min(MAX_CROP, (1 - imageAr / frameAr) / 2))
      return { ...base, cropT: c, cropB: c, w: w(frameAr) }
    }
    default: {
      const never: never = mode
      throw new Error(`Unbekannte Einpassung: ${String(never)}`)
    }
  }
}

/** Steht in den Daten ein eigenes Tempo für die Dauer-Animation? */
export function hasLoopSpeed(data: Record<string, unknown>): boolean {
  return typeof data.loopSpeed === 'number' && Number.isFinite(data.loopSpeed)
}

/**
 * Tempo der Dauer-Animation: das eigene (`loopSpeed`), sonst – wie bisher –
 * das Tempo des Einblendens (`animSpeed`).
 */
export function loopSpeedOf(data: Record<string, unknown>): number {
  return animSpeedOf(hasLoopSpeed(data) ? { animSpeed: data.loopSpeed } : data)
}

/** Hat die Grafik etwas zu zeigen? (Emoji ohne Zeichen, Bild nicht geladen: nein.) */
export function isDrawable(g: GraphicData): boolean {
  if (g.kind === 'image') return hasImageAsset(g.image)
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
            const keys = graphicKeys(clip.data)
            return {
              ...clip,
              data: {
                kind: g.kind,
                x: g.x,
                y: g.y,
                animation: g.animation,
                loop: g.loop,
                animSpeed: g.animSpeed ?? 1,
                // Eigenes Ausblenden steht nur in den Clip-Daten (clipGraphic kennt es nicht).
                ...((OUT_ANIMATIONS as readonly unknown[]).includes(clip.data.animOut)
                  ? {
                      animOut: clip.data.animOut,
                      animOutSpeed: animParts(clip.data).outSpeed,
                    }
                  : {}),
                // Eigenes Tempo der Dauer-Animation (fehlt = Tempo des Einblendens).
                ...(g.loop !== 'none' && hasLoopSpeed(clip.data)
                  ? { loopSpeed: loopSpeedOf(clip.data) }
                  : {}),
                png,
                renderHeight: height,
                ...(keys.length > 0 ? { keys } : {}),
                ...(keys.length > 0 && graphicSmooth(clip.data) ? { ease: 'smooth' } : {}),
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
