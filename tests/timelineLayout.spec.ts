import { describe, expect, it } from 'vitest'
import {
  clipPeaks,
  clipThumbs,
  fitZoom,
  formatRulerLabel,
  pxToTime,
  rulerTicks,
  tickStep,
  timeToPx,
} from '@/timeline/layout'
import { secondsToTime as s } from '@/timeline/model'

describe('Zeit und Pixel', () => {
  it('rechnet hin und zurück', () => {
    expect(timeToPx(s(2.5), 100)).toBe(250)
    expect(pxToTime(250, 100)).toBe(s(2.5))
    expect(pxToTime(-10, 100)).toBe(0)
    expect(pxToTime(10, 0)).toBe(0)
    expect(pxToTime(Number.NaN, 100)).toBe(0)
  })
})

describe('Lineal', () => {
  it('wählt den Strichabstand so, dass Beschriftungen mindestens 80 px auseinander liegen', () => {
    expect(tickStep(100)).toBe(1)
    expect(tickStep(1000)).toBe(0.1)
    expect(tickStep(20)).toBe(5)
    expect(tickStep(2)).toBe(60)
    expect(tickStep(0.001)).toBe(14400)
  })

  it('beschriftet in m:ss, h:mm:ss und bei feinem Raster mit Zehnteln', () => {
    expect(formatRulerLabel(0, 1)).toBe('0:00')
    expect(formatRulerLabel(75, 5)).toBe('1:15')
    expect(formatRulerLabel(3725, 60)).toBe('1:02:05')
    expect(formatRulerLabel(1.5, 0.5)).toBe('0:01.5')
    expect(formatRulerLabel(0.3, 0.1)).toBe('0:00.3')
  })

  it('liefert Haupt- und Zwischenstriche nur für den angefragten Bereich', () => {
    const ticks = rulerTicks(100, s(1.9), s(3.1))
    expect(ticks.map((t) => t.time)).toEqual([1.8, 2, 2.2, 2.4, 2.6, 2.8, 3, 3.2].map(s))
    expect(ticks.filter((t) => t.major).map((t) => t.label)).toEqual(['0:02', '0:03'])
    expect(ticks.filter((t) => !t.major).every((t) => t.label === '')).toBe(true)
  })

  it('summiert keine Rundungsfehler auf (0,1-s-Raster über lange Zeit)', () => {
    const ticks = rulerTicks(1000, s(3599.9), s(3600.1))
    const hour = ticks.find((t) => t.time === s(3600))
    expect(hour).toMatchObject({ major: true, label: '1:00:00.0' })
    expect(rulerTicks(100, 0, 0)[0]).toEqual({ time: 0, label: '0:00', major: true })
  })
})

describe('fitZoom', () => {
  it('passt die Dauer mit etwas Rand in die Breite und bleibt in den Grenzen', () => {
    expect(fitZoom(s(10), 1000, 2, 2000)).toBe(95)
    expect(fitZoom(s(0.1), 1000, 2, 2000)).toBe(2000)
    expect(fitZoom(s(36000), 1000, 2, 2000)).toBe(2)
    expect(fitZoom(0, 1000, 2, 2000)).toBe(100)
  })
})

describe('clipThumbs', () => {
  const base = { thumbWidth: 100, zoom: 100, sourceIn: 0, speed: 1, interval: 1, count: 45 }

  it('legt Bilder lückenlos nebeneinander; jedes zeigt die Stelle an seiner linken Kante', () => {
    expect(clipThumbs({ ...base, clipWidth: 350 })).toEqual([
      { left: 0, index: 0 },
      { left: 100, index: 1 },
      { left: 200, index: 2 },
      { left: 300, index: 3 },
    ])
  })

  it('berücksichtigt Quell-Beginn, Tempo und den Abstand im Filmstreifen', () => {
    expect(
      clipThumbs({ ...base, clipWidth: 250, sourceIn: s(10), speed: 2, interval: 2 }).map(
        (t) => t.index,
      ),
    ).toEqual([5, 6, 7])
    // Hinter dem letzten Bild bleibt es beim letzten.
    expect(clipThumbs({ ...base, clipWidth: 150, sourceIn: s(44.5) }).map((t) => t.index)).toEqual([
      44, 44,
    ])
  })

  it('begrenzt sehr breite Clips auf eine Höchstzahl in größeren Abständen', () => {
    const slots = clipThumbs({ ...base, clipWidth: 50_000, maxThumbs: 20 })
    expect(slots).toHaveLength(20)
    expect(slots[1].left).toBe(2500)
    expect(slots[1].index).toBe(25)
  })

  it('liefert nichts ohne brauchbare Maße', () => {
    expect(clipThumbs({ ...base, clipWidth: 0 })).toEqual([])
    expect(clipThumbs({ ...base, clipWidth: 100, interval: 0 })).toEqual([])
    expect(clipThumbs({ ...base, clipWidth: 100, count: 0 })).toEqual([])
  })
})

describe('clipPeaks', () => {
  const peaks = Uint8Array.from({ length: 500 }, (_, i) => i % 256)

  it('schneidet den Bereich des Clips aus der Wellenform (mit Tempo)', () => {
    expect([...clipPeaks(peaks, 50, s(1), s(0.1), 1)!]).toEqual([50, 51, 52, 53, 54])
    expect(clipPeaks(peaks, 50, s(2), s(1), 2)!.length).toBe(100)
  })

  it('bleibt innerhalb der Daten und liefert null ohne Wellenform', () => {
    expect(clipPeaks(peaks, 50, s(9), s(5), 1)!.length).toBe(50)
    expect(clipPeaks(peaks, 50, s(20), s(5), 1)!.length).toBe(0)
    expect(clipPeaks(null, 50, 0, s(1), 1)).toBeNull()
    expect(clipPeaks(peaks, 0, 0, s(1), 1)).toBeNull()
  })
})
