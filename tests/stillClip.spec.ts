import { describe, it, expect } from 'vitest'
import {
  clampStillDuration,
  evenSize,
  fitRect,
  stillFps,
  STILL_MAX_DURATION,
  STILL_MIN_DURATION,
} from '@/lib/stillClip'

describe('stillClip', () => {
  it('evenSize: gerade, 16–4096', () => {
    expect(evenSize(1081)).toBe(1080)
    expect(evenSize(5)).toBe(16)
    expect(evenSize(9999)).toBe(4096)
    expect(evenSize(NaN)).toBe(2)
  })

  it('clampStillDuration', () => {
    expect(clampStillDuration(3.14)).toBe(3.1)
    expect(clampStillDuration(0)).toBe(STILL_MIN_DURATION)
    expect(clampStillDuration(1e6)).toBe(STILL_MAX_DURATION)
    expect(clampStillDuration(NaN)).toBe(5)
  })

  it('stillFps: ganzzahlig, unbekannt -> 30', () => {
    expect(stillFps(29.97)).toBe(30)
    expect(stillFps(24)).toBe(24)
    expect(stillFps(0)).toBe(30)
    expect(stillFps(120)).toBe(60)
  })

  it('fitRect: einpassen und füllen', () => {
    // 4:3-Bild in 16:9-Fläche
    expect(fitRect(400, 300, 1600, 900, 'contain')).toEqual({ x: 200, y: 0, w: 1200, h: 900 })
    expect(fitRect(400, 300, 1600, 900, 'cover')).toEqual({ x: 0, y: -150, w: 1600, h: 1200 })
    expect(fitRect(0, 0, 10, 10, 'cover')).toEqual({ x: 0, y: 0, w: 10, h: 10 })
  })
})
