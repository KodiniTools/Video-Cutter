import { describe, expect, it } from 'vitest'
import {
  farIndices,
  nextToLoad,
  segmentIndexAt,
  staleIndices,
  type SegmentRef,
} from '@/preview/schedule'

const SEC = 1_000_000
const segs = (keys: string[], last = 4 * SEC): SegmentRef[] =>
  keys.map((key, index) => ({
    index,
    start: index * 4 * SEC,
    duration: index === keys.length - 1 ? last : 4 * SEC,
    key,
  }))

describe('segmentIndexAt', () => {
  it('findet den Abschnitt zur Zeit; Grenzen gehören zum folgenden', () => {
    const s = segs(['a', 'b', 'c'], 2 * SEC)
    expect(segmentIndexAt(s, 0)).toBe(0)
    expect(segmentIndexAt(s, 4 * SEC - 1)).toBe(0)
    expect(segmentIndexAt(s, 4 * SEC)).toBe(1)
    expect(segmentIndexAt(s, 9 * SEC)).toBe(2)
  })

  it('nimmt am Ende den letzten Abschnitt und meldet -1 ohne Abschnitte', () => {
    expect(segmentIndexAt(segs(['a', 'b'], 2 * SEC), 6 * SEC)).toBe(1)
    expect(segmentIndexAt(segs(['a', 'b']), 99 * SEC)).toBe(1)
    expect(segmentIndexAt([], 0)).toBe(-1)
  })
})

describe('staleIndices', () => {
  it('meldet nur Abschnitte mit geändertem Schlüssel', () => {
    const loaded = new Map([
      [0, 'a'],
      [1, 'b'],
      [2, 'c'],
    ])
    expect(staleIndices(segs(['a', 'x', 'c']), loaded)).toEqual([1])
    expect(staleIndices(segs(['a', 'b', 'c']), loaded)).toEqual([])
  })

  it('meldet Abschnitte hinter dem neuen Ende und alles bei leerem Plan', () => {
    const loaded = new Map([
      [2, 'c'],
      [0, 'a'],
    ])
    expect(staleIndices(segs(['a']), loaded)).toEqual([2])
    expect(staleIndices([], loaded)).toEqual([0, 2])
  })
})

describe('farIndices', () => {
  it('meldet Abschnitte außerhalb des Fensters', () => {
    const loaded = new Map([0, 5, 10, 20, 30].map((i) => [i, 'k']))
    expect(farIndices(loaded, 12, 5, 10)).toEqual([0, 5, 30])
    expect(farIndices(loaded, 12, 20, 20)).toEqual([])
  })
})

describe('nextToLoad', () => {
  const s = segs(['a', 'b', 'c', 'd', 'e', 'f'])

  it('beginnt an der aktuellen Stelle und überspringt Geladenes', () => {
    expect(nextToLoad(s, new Map(), 2, 3)?.key).toBe('c')
    expect(nextToLoad(s, new Map([[2, 'c']]), 2, 3)?.key).toBe('d')
  })

  it('lädt Abschnitte mit veraltetem Schlüssel erneut', () => {
    expect(nextToLoad(s, new Map([[2, 'alt']]), 2, 3)?.key).toBe('c')
  })

  it('schaut höchstens `ahead` Abschnitte voraus und nie zurück', () => {
    const loaded = new Map([
      [2, 'c'],
      [3, 'd'],
    ])
    expect(nextToLoad(s, loaded, 2, 2)).toBeNull()
    expect(nextToLoad(s, loaded, 2, 3)?.key).toBe('e')
    expect(nextToLoad(s, new Map(), 5, 4)?.key).toBe('f')
    expect(nextToLoad(s, new Map([[5, 'f']]), 5, 4)).toBeNull()
  })

  it('lässt fehlgeschlagene Schlüssel aus', () => {
    expect(nextToLoad(s, new Map(), 0, 3, new Set(['a']))?.key).toBe('b')
    expect(nextToLoad([], new Map(), 0, 3)).toBeNull()
    expect(nextToLoad(s, new Map(), -1, 1)?.key).toBe('a')
  })
})
