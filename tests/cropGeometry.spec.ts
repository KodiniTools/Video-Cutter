import { describe, it, expect } from 'vitest'
import { containedVideoBox } from '@/lib/cropGeometry'

describe('containedVideoBox', () => {
  it('Element-Box breiter als das Bild -> Pillarboxing, horizontal zentriert', () => {
    // Box 1000×400 (max-height greift), Video 16:9 -> Bild 711×400, Rand je 144.
    const b = containedVideoBox({ left: 0, top: 0, width: 1000, height: 400 }, 1280, 720)
    expect(b.height).toBeCloseTo(400, 5)
    expect(b.width).toBeCloseTo(711.11, 1)
    expect(b.left).toBeCloseTo(144.44, 1)
    expect(b.top).toBe(0)
  })

  it('Element-Box höher als das Bild -> Letterboxing, vertikal zentriert', () => {
    const b = containedVideoBox({ left: 10, top: 5, width: 800, height: 800 }, 1920, 1080)
    expect(b.width).toBe(800)
    expect(b.height).toBe(450)
    expect(b.left).toBe(10)
    expect(b.top).toBe(5 + (800 - 450) / 2)
  })

  it('passendes Seitenverhältnis -> Box unverändert', () => {
    const b = containedVideoBox({ left: 0, top: 0, width: 640, height: 360 }, 1280, 720)
    expect(b).toEqual({ left: 0, top: 0, width: 640, height: 360 })
  })

  it('ohne intrinsische Größe -> Element-Box unverändert', () => {
    const box = { left: 3, top: 4, width: 500, height: 300 }
    expect(containedVideoBox(box, 0, 0)).toEqual(box)
  })
})
