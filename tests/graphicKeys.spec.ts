import { describe, expect, it } from 'vitest'
import {
  canAddGraphicKey,
  graphicKeyIndexAt,
  graphicKeys,
  graphicMotionAt,
  MAX_GRAPHIC_KEYS,
  visibleGraphicKeys,
  withGraphicChange,
  withGraphicKeyAt,
  withoutGraphicKey,
} from '@/timeline/graphicKeys'
import { DEFAULT_TEXT_STYLE } from '@/lib/textOverlay'
import {
  addTrack,
  createDoc,
  findClip,
  insertClip,
  splitClip,
  trimClip,
  updateClipData,
  type OpResult,
  type OverlayClip,
  type TimelineDoc,
} from '@/timeline/model'

const S = 1_000_000
const must = (r: OpResult): TimelineDoc => {
  if (!r.ok) throw new Error(r.error)
  return r.doc
}
const clipOf = (data: Record<string, unknown>, duration = 4 * S): OverlayClip => ({
  id: 'g',
  kind: 'graphic',
  start: 2 * S,
  duration,
  data,
})
const keyed = () =>
  clipOf({
    kind: 'rect',
    x: 0.2,
    y: 0.5,
    keys: [
      { at: 0, x: 0.2, y: 0.5, scale: 1 },
      { at: 2 * S, x: 0.8, y: 0.5, scale: 0.5 },
    ],
  })
/** Dokument mit dem Clip auf einer Ebenen-Spur. */
function docWith(clip: OverlayClip): TimelineDoc {
  const doc = must(addTrack(createDoc(), { id: 'O1', kind: 'overlay', name: 'Ebene' }))
  return must(insertClip(doc, 'O1', clip))
}
const graphic = (doc: TimelineDoc, id = 'g') => findClip(doc, id)!.clip as OverlayClip

describe('Keyframes für Grafiken', () => {
  it('liest Keyframes gültig, sortiert und in Grenzen', () => {
    expect(graphicKeys({})).toEqual([])
    expect(graphicKeys({ keys: 'x' })).toEqual([])
    expect(
      graphicKeys({
        keys: [
          { at: S, x: 2, y: -1, scale: 9 },
          null,
          { at: 0.5, x: 0.5, y: 0.5 },
          { at: 0, x: 0.5, y: 0.5 },
          { at: S, x: 0.1, y: 0.1, scale: 1 },
        ],
      }),
    ).toEqual([
      { at: 0, x: 0.5, y: 0.5, scale: 1 },
      { at: S, x: 1, y: 0, scale: 3 },
    ])
  })

  it('ohne Keyframes gilt die feste Mitte, mit ihnen der Wert an der Stelle', () => {
    expect(graphicMotionAt(clipOf({ x: 0.3, y: 0.7 }), S)).toEqual({ x: 0.3, y: 0.7, scale: 1 })
    const clip = keyed()
    expect(graphicMotionAt(clip, 0)).toEqual({ x: 0.2, y: 0.5, scale: 1 })
    expect(graphicMotionAt(clip, S)).toEqual({ x: 0.5, y: 0.5, scale: 0.75 })
    expect(graphicMotionAt(clip, 3 * S)).toEqual({ x: 0.8, y: 0.5, scale: 0.5 })
    // Weich: zur Hälfte gleich, davor langsamer.
    const smooth = { ...clip, data: { ...clip.data, ease: 'smooth' } }
    expect(graphicMotionAt(smooth, S).x).toBe(0.5)
    expect(graphicMotionAt(smooth, S / 2).x).toBeLessThan(graphicMotionAt(clip, S / 2).x)
  })

  it('gilt auch für Texte: ohne Angabe zählt deren Standardlage', () => {
    const text: OverlayClip = {
      id: 't',
      kind: 'text',
      start: 0,
      duration: 4 * S,
      data: { text: 'Hallo' },
    }
    const base = graphicMotionAt(text, S)
    expect(base).toEqual({ x: DEFAULT_TEXT_STYLE.x, y: DEFAULT_TEXT_STYLE.y, scale: 1 })
    const first = { ...text, data: { ...text.data, ...withGraphicKeyAt(text, 0) } }
    const moved = {
      ...first,
      data: { ...first.data, ...withGraphicChange(first, 2 * S, { x: 0.9, scale: 2 }) },
    }
    expect(graphicKeys(moved.data)).toEqual([
      { at: 0, x: base.x, y: base.y, scale: 1 },
      { at: 2 * S, x: 0.9, y: base.y, scale: 2 },
    ])
    expect(graphicMotionAt(moved, S).scale).toBe(1.5)
  })

  it('setzt einen Keyframe mit dem Stand an der Stelle und ändert einen vorhandenen', () => {
    const plain = clipOf({ x: 0.3, y: 0.7 })
    expect(withGraphicKeyAt(plain, S)).toEqual({
      keys: [{ at: S, x: 0.3, y: 0.7, scale: 1 }],
      x: 0.3,
      y: 0.7,
    })
    const clip = keyed()
    const patch = withGraphicKeyAt(clip, S)
    expect((patch.keys as unknown[])[1]).toEqual({ at: S, x: 0.5, y: 0.5, scale: 0.75 })
    // Auf dem Keyframe (knapp daneben zählt mit): dessen Werte bleiben, nur die Änderung kommt dazu.
    expect(graphicKeyIndexAt(clip, 2 * S - 10_000)).toBe(1)
    const moved = withGraphicKeyAt(clip, 2 * S - 10_000, { y: 0.9 })
    expect(moved.keys).toEqual([
      { at: 0, x: 0.2, y: 0.5, scale: 1 },
      { at: 2 * S, x: 0.8, y: 0.9, scale: 0.5 },
    ])
    // Der erste Keyframe bestimmt x/y des Clips.
    expect(withGraphicKeyAt(clip, 0, { x: 0.4 })).toMatchObject({ x: 0.4, y: 0.5 })
  })

  it('Änderung ohne Keyframes gilt für den ganzen Clip, mit Keyframes an der Stelle', () => {
    expect(withGraphicChange(clipOf({ x: 0.3, y: 0.7 }), S, { x: 0.6, scale: 2 })).toEqual({
      x: 0.6,
    })
    const patch = withGraphicChange(keyed(), 3 * S, { scale: 2 })
    expect((patch.keys as unknown[])[2]).toEqual({ at: 3 * S, x: 0.8, y: 0.5, scale: 2 })
  })

  it('entfernt Keyframes; der letzte hinterlässt seine Mitte', () => {
    const clip = keyed()
    expect(withoutGraphicKey(clip, 0)).toEqual({
      keys: [{ at: 2 * S, x: 0.8, y: 0.5, scale: 0.5 }],
      x: 0.8,
      y: 0.5,
    })
    const one = { ...clip, data: { ...clip.data, ...withoutGraphicKey(clip, 0) } }
    expect(withoutGraphicKey(one, 0)).toEqual({ keys: [], x: 0.8, y: 0.5 })
    expect(withoutGraphicKey(clip, 5)).toEqual({})
  })

  it('begrenzt die Anzahl und zeigt nur Keyframes im Clip', () => {
    const many = clipOf({
      keys: Array.from({ length: MAX_GRAPHIC_KEYS }, (_, i) => ({
        at: i * 100_000,
        x: 0.5,
        y: 0.5,
        scale: 1,
      })),
    })
    expect(canAddGraphicKey(many, 3_950_000)).toBe(false)
    expect(canAddGraphicKey(keyed(), S)).toBe(true)
    expect(canAddGraphicKey(keyed(), 0)).toBe(false)
    const outside = clipOf({
      keys: [
        { at: -S, x: 0.5, y: 0.5, scale: 1 },
        { at: S, x: 0.5, y: 0.5, scale: 1 },
        { at: 9 * S, x: 0.5, y: 0.5, scale: 1 },
      ],
    })
    expect(visibleGraphicKeys(outside)).toEqual([{ index: 1, offset: S }])
  })

  it('Kürzen vorn und Teilen lassen die Keyframes an ihrer Stelle auf der Timeline', () => {
    const doc = docWith(keyed())
    // Vorn 1 s kürzen: Der Clip beginnt 1 s später, die Keyframes zählen 1 s weniger.
    const trimmed = graphic(must(trimClip(doc, 'g', 'start', 3 * S)))
    expect(graphicKeys(trimmed.data).map((k) => k.at)).toEqual([-S, S])
    expect(graphicMotionAt(trimmed, 0)).toEqual({ x: 0.5, y: 0.5, scale: 0.75 })
    // Hinten kürzen ändert nichts.
    const end = graphic(must(trimClip(doc, 'g', 'end', 5 * S)))
    expect(end.data.keys).toBe(graphic(doc).data.keys)

    // Teilen bei 3 s (1 s im Clip): beide Teile zeigen dort denselben Stand.
    let n = 0
    const split = must(splitClip(doc, 'g', 3 * S, { ids: () => `n${++n}` }))
    const left = graphic(split)
    const right = graphic(split, 'n1')
    expect(graphicKeys(left.data).map((k) => k.at)).toEqual([0, 2 * S])
    expect(graphicKeys(right.data).map((k) => k.at)).toEqual([-S, S])
    expect(graphicMotionAt(right, 0)).toEqual(graphicMotionAt(left, S))
    // Eingabe unverändert.
    expect(graphicKeys(graphic(doc).data).map((k) => k.at)).toEqual([0, 2 * S])
  })

  it('speichert Keyframes über updateClipData', () => {
    const doc = docWith(clipOf({ kind: 'rect', x: 0.3, y: 0.7 }))
    const next = must(updateClipData(doc, 'g', withGraphicKeyAt(graphic(doc), S, { x: 0.6 })))
    expect(graphic(next).data).toMatchObject({
      x: 0.6,
      keys: [{ at: S, x: 0.6, y: 0.7, scale: 1 }],
    })
  })
})
