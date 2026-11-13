/**
 * Bild-Clip (Standbild als Video): Der Browser zeichnet das Hintergrundbild
 * in der Zielgröße auf ein Canvas (Einpassen/Füllen/unscharfer Rand oder nur
 * Farbe); der Server macht daraus einen Clip mit stiller Tonspur.
 */

/** Wie das Bild die Fläche füllt. */
export type StillFit = 'contain' | 'cover' | 'blur'

export const STILL_FITS: readonly StillFit[] = ['contain', 'cover', 'blur']

/** Grenzen (wie im Backend, server/src/lib/stillClip.ts). */
export const STILL_MIN_DURATION = 0.5
export const STILL_MAX_DURATION = 600
export const STILL_MAX_SIZE = 4096
export const STILL_DEFAULT_DURATION = 5

export interface Size {
  width: number
  height: number
}

/** Größen-Vorlagen, wenn kein Video als Vorbild dient. */
export const STILL_PRESETS: readonly (Size & { id: string })[] = [
  { id: '1920x1080', width: 1920, height: 1080 },
  { id: '1280x720', width: 1280, height: 720 },
  { id: '1080x1920', width: 1080, height: 1920 },
  { id: '1080x1080', width: 1080, height: 1080 },
  { id: '3840x2160', width: 3840, height: 2160 },
]

/** Gerade Pixelzahl im erlaubten Bereich (yuv420p braucht gerade Maße). */
export function evenSize(n: number): number {
  if (!Number.isFinite(n)) return 2
  const c = Math.min(STILL_MAX_SIZE, Math.max(16, Math.round(n)))
  return Math.floor(c / 2) * 2
}

/** Dauer auf den erlaubten Bereich begrenzen (0,1-s-Raster). */
export function clampStillDuration(d: number): number {
  if (!Number.isFinite(d)) return STILL_DEFAULT_DURATION
  const c = Math.min(STILL_MAX_DURATION, Math.max(STILL_MIN_DURATION, d))
  return Math.round(c * 10) / 10
}

/** Bildrate fürs Backend: ganzzahlig 1–60, unbekannt -> 30. */
export function stillFps(fps: number): number {
  return Number.isFinite(fps) && fps >= 1 ? Math.min(60, Math.round(fps)) : 30
}

/** Rechteck, in das ein Bild (sw×sh) für den Modus gezeichnet wird. */
export function fitRect(
  sw: number,
  sh: number,
  W: number,
  H: number,
  mode: 'contain' | 'cover',
): { x: number; y: number; w: number; h: number } {
  if (!(sw > 0 && sh > 0)) return { x: 0, y: 0, w: W, h: H }
  const s = mode === 'cover' ? Math.max(W / sw, H / sh) : Math.min(W / sw, H / sh)
  const w = sw * s
  const h = sh * s
  return { x: (W - w) / 2, y: (H - h) / 2, w, h }
}

export interface StillImage {
  source: CanvasImageSource
  width: number
  height: number
}

/**
 * Zeichnet den Bild-Clip-Hintergrund. `image` null = nur Farbe.
 * - contain: ganzes Bild, Rand in Hintergrundfarbe
 * - cover: Fläche füllen, Überstand abschneiden
 * - blur: ganzes Bild vor unscharfer, gefüllter Kopie
 */
export function drawStill(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  image: StillImage | null,
  fit: StillFit,
  background: string,
): void {
  ctx.save()
  ctx.fillStyle = background
  ctx.fillRect(0, 0, W, H)
  if (image) {
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    if (fit === 'blur') {
      const c = fitRect(image.width, image.height, W, H, 'cover')
      ctx.save()
      ctx.filter = `blur(${Math.max(4, Math.round(Math.min(W, H) / 40))}px) brightness(0.7)`
      // Etwas größer, damit der Weichzeichner keinen hellen Rand zeigt.
      const pad = Math.min(W, H) / 10
      ctx.drawImage(image.source, c.x - pad, c.y - pad, c.w + 2 * pad, c.h + 2 * pad)
      ctx.restore()
    }
    const r = fitRect(image.width, image.height, W, H, fit === 'cover' ? 'cover' : 'contain')
    ctx.drawImage(image.source, r.x, r.y, r.w, r.h)
  }
  ctx.restore()
}

/** Zeichnet den Hintergrund in voller Zielgröße als PNG. */
export async function renderStillPng(
  size: Size,
  image: StillImage | null,
  fit: StillFit,
  background: string,
): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = size.width
  canvas.height = size.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas nicht verfügbar.')
  drawStill(ctx, size.width, size.height, image, fit, background)
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('Bild konnte nicht erzeugt werden.')
  return blob
}
