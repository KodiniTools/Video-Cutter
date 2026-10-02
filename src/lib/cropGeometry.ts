/** Ein Rechteck in CSS-Pixeln relativ zum Offset-Parent. */
export interface Box {
  left: number
  top: number
  width: number
  height: number
}

/**
 * Berechnet die tatsächlich sichtbare Bildfläche eines `<video>` innerhalb
 * seiner Element-Box (Standard `object-fit: contain`): Das Bild wird
 * proportional eingepasst und zentriert, der Rest ist schwarzer Rand
 * (Letter-/Pillarboxing). Der Crop-Overlay muss exakt auf dieser Fläche
 * liegen, sonst stimmen die Anteilswerte nicht mit dem Bildinhalt überein.
 *
 * Ohne bekannte intrinsische Größe (Metadaten noch nicht geladen) wird die
 * Element-Box unverändert zurückgegeben.
 */
export function containedVideoBox(
  elementBox: Box,
  intrinsicWidth: number,
  intrinsicHeight: number,
): Box {
  const { left, top, width, height } = elementBox
  if (!(intrinsicWidth > 0 && intrinsicHeight > 0 && width > 0 && height > 0)) {
    return { left, top, width, height }
  }
  const scale = Math.min(width / intrinsicWidth, height / intrinsicHeight)
  const w = intrinsicWidth * scale
  const h = intrinsicHeight * scale
  return {
    left: left + (width - w) / 2,
    top: top + (height - h) / 2,
    width: w,
    height: h,
  }
}
