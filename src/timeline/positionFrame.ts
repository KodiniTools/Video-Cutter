/**
 * Rechnen für den Positionsrahmen über der Vorschau: Wo liegt das Bild im
 * Rahmen des Players, und wohin führt eine Bewegung mit Maus oder Tastatur?
 * Positionen sind Anteile der Bildbreite/-höhe (0–1, Mittelpunkt des Elements).
 */

export interface Rect {
  left: number
  top: number
  width: number
  height: number
}

export interface Point {
  x: number
  y: number
}

/** Bild mit dem Seitenverhältnis `w:h`, eingepasst und zentriert in einen Kasten. */
export function containRect(boxW: number, boxH: number, w: number, h: number): Rect {
  if (!(boxW > 0 && boxH > 0 && w > 0 && h > 0)) return { left: 0, top: 0, width: 0, height: 0 }
  const scale = Math.min(boxW / w, boxH / h)
  const width = w * scale
  const height = h * scale
  return { left: (boxW - width) / 2, top: (boxH - height) / 2, width, height }
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
/** Auf Zehntelprozent runden: ruhige Werte im Dokument und in den Reglern. */
const tidy = (v: number) => Math.round(clamp01(v) * 1000) / 1000

/** Faktor der Mausbewegung mit gedrückter Umschalttaste (fein). */
export const FINE_DRAG = 0.2

/**
 * Neue Position nach einer Mausbewegung um `dx`/`dy` Pixel im Bild `rect`.
 * Ungerundet, damit sich viele kleine Schritte genau aufsummieren; gerundet
 * wird erst beim Übernehmen (`tidyPoint`).
 */
export function dragPosition(from: Point, dx: number, dy: number, rect: Rect, fine = false): Point {
  if (!(rect.width > 0 && rect.height > 0)) return from
  const f = fine ? FINE_DRAG : 1
  return {
    x: clamp01(from.x + (dx * f) / rect.width),
    y: clamp01(from.y + (dy * f) / rect.height),
  }
}

/** Position fürs Dokument: im Bild und auf Zehntelprozent gerundet. */
export function tidyPoint(p: Point): Point {
  return { x: tidy(p.x), y: tidy(p.y) }
}

/** Schritt der Pfeiltasten: 0,5 %, mit Umschalttaste 5 %. */
export const NUDGE_STEP = 0.005
export const NUDGE_STEP_BIG = 0.05

/** Neue Position nach einer Pfeiltaste; `null` bei jeder anderen Taste. */
export function nudgePoint(from: Point, key: string, big = false): Point | null {
  const step = big ? NUDGE_STEP_BIG : NUDGE_STEP
  switch (key) {
    case 'ArrowLeft':
      return { x: tidy(from.x - step), y: tidy(from.y) }
    case 'ArrowRight':
      return { x: tidy(from.x + step), y: tidy(from.y) }
    case 'ArrowUp':
      return { x: tidy(from.x), y: tidy(from.y - step) }
    case 'ArrowDown':
      return { x: tidy(from.x), y: tidy(from.y + step) }
    default:
      return null
  }
}

/** Lage eines Video-Clips im Bild (Bild-in-Bild), wie im Dokument. */
export interface LayoutLike {
  x: number
  y: number
  scale: number
}

/** Mitte und Größe eines Kastens als Anteile des Projektformats. */
export interface FrameBox extends Point {
  width: number
  height: number
}

/**
 * Wo das Bild eines verkleinerten Clips wirklich liegt (wie der Server es
 * rendert): Die Quelle `srcW:srcH` wird in den Rahmen `scale` × Projektformat
 * eingepasst und um die Mitte gelegt, bleibt aber ganz im Bild.
 */
export function layoutBox(
  layout: LayoutLike,
  srcW: number,
  srcH: number,
  projW: number,
  projH: number,
): FrameBox {
  const ok = srcW > 0 && srcH > 0 && projW > 0 && projH > 0
  const k = ok ? Math.min((projW * layout.scale) / srcW, (projH * layout.scale) / srcH) : 0
  const width = ok ? Math.min(1, (srcW * k) / projW) : layout.scale
  const height = ok ? Math.min(1, (srcH * k) / projH) : layout.scale
  return {
    x: Math.min(1 - width / 2, Math.max(width / 2, layout.x)),
    y: Math.min(1 - height / 2, Math.max(height / 2, layout.y)),
    width,
    height,
  }
}

/**
 * Neue Größe beim Ziehen am Griff: Sie wächst im Verhältnis des Abstands des
 * Zeigers von der Mitte (`from` → `to`, in Pixeln), in den Grenzen `min`–1 und
 * auf ganze Prozent gerundet.
 */
export function resizeScale(scale: number, from: number, to: number, min: number): number {
  if (!(from > 0) || !Number.isFinite(to)) return scale
  const next = Math.min(1, Math.max(min, (scale * to) / from))
  return Math.round(next * 100) / 100
}
