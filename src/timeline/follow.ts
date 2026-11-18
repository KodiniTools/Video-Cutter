/**
 * Die Timeline folgt dem Abspielkopf: Während der Wiedergabe bleibt er in der
 * Mitte des sichtbaren Bereichs, die Timeline läuft unter ihm durch. Pausiert
 * bleibt die Ansicht stehen (der Abspielkopf also in der Mitte); sie springt
 * nur nach, wenn der Abspielkopf den sichtbaren Bereich verlässt.
 */

export interface FollowInput {
  /** Lage des Abspielkopfs ab Beginn der Spuren (px). */
  playheadPx: number
  /** Sichtbare Breite der Spuren (px). */
  viewport: number
  /** Gesamtbreite der Spuren (px). */
  contentWidth: number
  /** Aktuelle waagrechte Scroll-Position (px). */
  scrollLeft: number
  playing: boolean
}

/**
 * Neue Scroll-Position, bei der der Abspielkopf in der Mitte steht – begrenzt
 * auf den scrollbaren Bereich (am Anfang wandert er deshalb erst zur Mitte).
 * `null`: nichts zu tun.
 */
export function followScroll(input: FollowInput): number | null {
  const { playheadPx, viewport, contentWidth, scrollLeft, playing } = input
  if (![playheadPx, viewport, contentWidth, scrollLeft].every(Number.isFinite) || viewport <= 0)
    return null
  const visible = playheadPx >= scrollLeft && playheadPx <= scrollLeft + viewport
  if (!playing && visible) return null
  const max = Math.max(0, contentWidth - viewport)
  const target = Math.round(Math.min(max, Math.max(0, playheadPx - viewport / 2)))
  return Math.abs(target - scrollLeft) < 1 ? null : target
}
