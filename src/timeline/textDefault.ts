import {
  ANIM_SPEEDS,
  OUT_ANIMATIONS,
  MAX_TEXT_SIZE,
  MIN_TEXT_SIZE,
  TEXT_ANIMATIONS,
  TEXT_STYLES,
  isBuiltinFont,
} from '@/lib/textOverlay'
import type { TimelineDoc } from './model'

/**
 * Text-Standard des neuen Editors: die Einstellungen eines Textes (Schrift,
 * Größe, Farben, Stil, Animation, Position), die der Nutzer als Vorlage für
 * alle Texte gespeichert hat. Inhalt, Zeiten und Keyframes gehören nicht dazu.
 */
export interface TextDefault {
  x: number
  y: number
  font: string
  size: number
  color: string
  style: string
  accent: string
  animation: string
  animSpeed: number
  /** Eigenes Ausblenden (fehlt bei älteren Standards: wie bisher über `animation`). */
  animOut?: string
  animOutSpeed?: number
}

export const TEXT_DEFAULT_KEYS = [
  'x',
  'y',
  'font',
  'size',
  'color',
  'style',
  'accent',
  'animation',
  'animSpeed',
  'animOut',
  'animOutSpeed',
] as const satisfies readonly (keyof TextDefault)[]

const HEX = /^#[0-9a-f]{6}$/i
const unit = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1

/**
 * Liest die Einstellungen aus den Daten eines Text-Clips bzw. aus dem
 * Speicher. Fehlt ein Feld oder ist es unbrauchbar, gibt es keinen Standard
 * (`null`) – lieber keiner als ein halber.
 */
export function parseTextDefault(raw: unknown): TextDefault | null {
  if (!raw || typeof raw !== 'object') return null
  const d = raw as Record<string, unknown>
  const { x, y, font, size, color, style, accent, animation } = d
  const animSpeed = d.animSpeed === undefined ? 1 : d.animSpeed
  if (!unit(x) || !unit(y)) return null
  if (typeof font !== 'string' || !(isBuiltinFont(font) || /^f:[\w .-]+$/.test(font))) return null
  if (typeof size !== 'number' || !(size >= MIN_TEXT_SIZE && size <= MAX_TEXT_SIZE)) return null
  if (typeof color !== 'string' || !HEX.test(color)) return null
  if (typeof accent !== 'string' || !HEX.test(accent)) return null
  if (typeof style !== 'string' || !(TEXT_STYLES as readonly string[]).includes(style)) return null
  if (typeof animation !== 'string' || !(TEXT_ANIMATIONS as readonly string[]).includes(animation))
    return null
  if (typeof animSpeed !== 'number' || !(ANIM_SPEEDS as readonly number[]).includes(animSpeed))
    return null
  const base = { x, y, font, size, color, style, accent, animation, animSpeed }
  const animOut = d.animOut
  if (animOut === undefined || animOut === null) return base
  if (typeof animOut !== 'string' || !(OUT_ANIMATIONS as readonly string[]).includes(animOut))
    return null
  const animOutSpeed = d.animOutSpeed === undefined ? 1 : d.animOutSpeed
  if (
    typeof animOutSpeed !== 'number' ||
    !(ANIM_SPEEDS as readonly number[]).includes(animOutSpeed)
  )
    return null
  return { ...base, animOut, animOutSpeed }
}

/** Entsprechen die Daten eines Text-Clips dem Standard? (Keyframes: Position zählt nicht.) */
export function matchesTextDefault(data: Record<string, unknown>, def: TextDefault): boolean {
  const patch = textDefaultPatch(data, def)
  return Object.keys(patch).length === 0
}

const hasKeys = (data: Record<string, unknown>) => Array.isArray(data.keys) && data.keys.length > 0

/**
 * Änderungen, die einen Text auf den Standard bringen. Hat der Text
 * Keyframes, bestimmen diese seine Position: x/y bleiben dann unberührt.
 */
export function textDefaultPatch(
  data: Record<string, unknown>,
  def: TextDefault,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  const keyed = hasKeys(data)
  for (const key of TEXT_DEFAULT_KEYS) {
    if (keyed && (key === 'x' || key === 'y')) continue
    // Tempo: fehlt = 1. Ohne eigenes Ausblenden spielt dessen Tempo keine Rolle.
    const speed = key === 'animSpeed' || (key === 'animOutSpeed' && def.animOut !== undefined)
    const cur = speed && data[key] === undefined ? 1 : (data[key] ?? undefined)
    const want = key === 'animOutSpeed' && def.animOut === undefined ? cur : def[key]
    if (cur !== want) patch[key] = want
  }
  return patch
}

/** Änderungen für alle Texte des Dokuments (nur Clips, die abweichen; gesperrte Spuren bleiben). */
export function textDefaultPatches(
  doc: TimelineDoc,
  def: TextDefault,
): { id: string; patch: Record<string, unknown> }[] {
  const out: { id: string; patch: Record<string, unknown> }[] = []
  for (const track of doc.tracks) {
    if (track.kind !== 'overlay' || track.locked) continue
    for (const clip of track.clips) {
      if (clip.kind !== 'text') continue
      const patch = textDefaultPatch(clip.data, def)
      if (Object.keys(patch).length > 0) out.push({ id: clip.id, patch })
    }
  }
  return out
}
