import { describe, expect, it } from 'vitest'
import { mergeTimeline, seamOverlap } from '@/lib/mergeTimeline'

const tl = (...args: Parameters<typeof mergeTimeline>) => mergeTimeline(...args)!

describe('mergeTimeline – Von/Bis im Gesamtvideo', () => {
  it('ohne Von: Clips lückenlos hintereinander (Bild-Clip 5 s + Video 14,729 s = 19,729 s)', () => {
    const r = tl(
      [
        { length: 5, at: null },
        { length: 14.729, at: null },
      ],
      [null],
      'none',
      4,
    )
    expect(r.entries.map((e) => [e.start, e.end, e.hold])).toEqual([
      [0, 5, 0],
      [5, 19.729, 0],
    ])
    expect(r.total).toBeCloseTo(19.729, 6)
  })

  it('Von hinter dem Ende des vorigen Clips: Lücke = Standbild des vorigen', () => {
    const r = tl(
      [
        { length: 5, at: null },
        { length: 14.729, at: 6 },
      ],
      [null],
      'none',
      4,
    )
    expect(r.entries[0]).toMatchObject({ start: 0, end: 5, used: 5, hold: 1 })
    expect(r.entries[1]).toMatchObject({ start: 6 })
    expect(r.total).toBeCloseTo(20.729, 6)
  })

  it('Von vor dem Ende des vorigen Clips: der vorige wird dort abgeschnitten', () => {
    const r = tl(
      [
        { length: 5, at: null },
        { length: 10, at: 3 },
      ],
      [null],
      'none',
      4,
    )
    expect(r.entries[0]).toMatchObject({ used: 3, hold: 0, end: 3 })
    expect(r.total).toBe(13)
  })

  it('Von nie vor dem Beginn des vorigen Clips', () => {
    const r = tl(
      [
        { length: 5, at: null },
        { length: 10, at: 2 },
        { length: 4, at: 1 },
      ],
      [null, null],
      'none',
      4,
    )
    expect(r.entries[2].start).toBeCloseTo(2.05, 6)
    expect(r.entries[2].minStart).toBeCloseTo(2.05, 6)
  })

  it('Umklappen: nächster Clip beginnt um die Überlappung früher; Von gilt als Beginn des Übergangs', () => {
    const auto = tl(
      [
        { length: 5, at: null },
        { length: 8.733, at: null },
      ],
      [null],
      'flip',
      4,
    )
    expect(auto.entries[1].start).toBeCloseTo(3, 6)
    expect(auto.total).toBeCloseTo(11.733, 6) // wie der Server (Browsertest)

    const set = tl(
      [
        { length: 5, at: null },
        { length: 8, at: 5 },
      ],
      [null],
      'flip',
      4,
    )
    // Bild-Clip läuft bis 5 + 2 s Überlappung = 7 s -> 2 s Standbild.
    expect(set.entries[0]).toMatchObject({ used: 5, hold: 2 })
    expect(set.total).toBe(13)
  })

  it('Dip to Black und Nahtstellen-Übergang', () => {
    expect(
      tl(
        [
          { length: 5, at: null },
          { length: 10, at: null },
        ],
        [null],
        'fade',
        4,
      ).total,
    ).toBe(15)
    expect(
      tl(
        [
          { length: 5, at: null },
          { length: 10, at: null },
        ],
        ['slide'],
        'none',
        4,
      ).total,
    ).toBe(13)
  })

  it('seamOverlap wie der Server; unbekannte Länge -> null', () => {
    expect(seamOverlap([1, 10], 10)).toBeCloseTo(0.95, 6)
    expect(seamOverlap([1, 1, 10], 10)).toBeCloseTo(0.45, 6)
    expect(seamOverlap([0.12, 10], 4)).toBe(0)
    expect(seamOverlap([5], 4)).toBe(0)
    expect(mergeTimeline([{ length: 0, at: null }], [], 'none', 4)).toBeNull()
    expect(mergeTimeline([], [], 'none', 4)).toBeNull()
  })
})
