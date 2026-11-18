import { describe, expect, it } from 'vitest'
import { followScroll } from '@/timeline/follow'

const base = { viewport: 1000, contentWidth: 5000, scrollLeft: 0, playing: true }

describe('followScroll (Timeline folgt dem Abspielkopf)', () => {
  it('Wiedergabe: hält den Abspielkopf in der Mitte', () => {
    expect(followScroll({ ...base, playheadPx: 1800 })).toBe(1300)
    expect(followScroll({ ...base, playheadPx: 1800, scrollLeft: 1300 })).toBeNull()
  })

  it('am Anfang wandert der Abspielkopf erst bis zur Mitte', () => {
    expect(followScroll({ ...base, playheadPx: 300 })).toBeNull()
    expect(followScroll({ ...base, playheadPx: 300, scrollLeft: 200 })).toBe(0)
    expect(followScroll({ ...base, playheadPx: 501 })).toBe(1)
  })

  it('bleibt im scrollbaren Bereich', () => {
    expect(followScroll({ ...base, playheadPx: 4900 })).toBe(4000)
    expect(followScroll({ ...base, playheadPx: 400, contentWidth: 800 })).toBeNull()
  })

  it('pausiert: Ansicht bleibt stehen, solange der Abspielkopf sichtbar ist', () => {
    const paused = { ...base, playing: false, scrollLeft: 1300 }
    expect(followScroll({ ...paused, playheadPx: 1800 })).toBeNull()
    expect(followScroll({ ...paused, playheadPx: 1400 })).toBeNull()
    expect(followScroll({ ...paused, playheadPx: 2300 })).toBeNull()
  })

  it('pausiert: holt einen Abspielkopf außerhalb der Ansicht in die Mitte', () => {
    const paused = { ...base, playing: false, scrollLeft: 1300 }
    expect(followScroll({ ...paused, playheadPx: 2400 })).toBe(1900)
    expect(followScroll({ ...paused, playheadPx: 100 })).toBe(0)
  })

  it('ist robust gegen unbrauchbare Werte', () => {
    expect(followScroll({ ...base, playheadPx: NaN })).toBeNull()
    expect(followScroll({ ...base, playheadPx: 100, viewport: 0 })).toBeNull()
  })
})
