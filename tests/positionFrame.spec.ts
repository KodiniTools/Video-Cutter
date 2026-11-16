import { describe, expect, it } from 'vitest'
import {
  containRect,
  dragPosition,
  layoutBox,
  nudgePoint,
  resizeScale,
  tidyPoint,
} from '@/timeline/positionFrame'

describe('containRect', () => {
  it('passt das Bild zentriert ein (Ränder links/rechts oder oben/unten)', () => {
    expect(containRect(1000, 400, 16, 9)).toEqual({
      left: (1000 - (400 * 16) / 9) / 2,
      top: 0,
      width: (400 * 16) / 9,
      height: 400,
    })
    expect(containRect(400, 1000, 16, 9)).toEqual({ left: 0, top: 387.5, width: 400, height: 225 })
    expect(containRect(0, 400, 16, 9)).toEqual({ left: 0, top: 0, width: 0, height: 0 })
  })
})

describe('dragPosition', () => {
  const rect = { left: 0, top: 0, width: 800, height: 400 }
  const moved = (...args: Parameters<typeof dragPosition>) => tidyPoint(dragPosition(...args))

  it('rechnet Pixel in Anteile um, begrenzt auf das Bild', () => {
    expect(moved({ x: 0.5, y: 0.5 }, 80, -40, rect)).toEqual({ x: 0.6, y: 0.4 })
    expect(moved({ x: 0.9, y: 0.1 }, 400, -400, rect)).toEqual({ x: 1, y: 0 })
  })

  it('bewegt mit Umschalttaste nur ein Fünftel', () => {
    expect(moved({ x: 0.5, y: 0.5 }, 80, 40, rect, true)).toEqual({ x: 0.52, y: 0.52 })
  })

  it('summiert viele kleine Schritte genau auf (gerundet wird erst am Ende)', () => {
    let at = { x: 0.5, y: 0.5 }
    for (let i = 0; i < 100; i++) at = dragPosition(at, 1, 1, rect, true)
    expect(tidyPoint(at)).toEqual({ x: 0.525, y: 0.55 })
  })

  it('lässt die Position ohne Bildgröße unverändert', () => {
    const from = { x: 0.3, y: 0.7 }
    expect(dragPosition(from, 50, 50, { left: 0, top: 0, width: 0, height: 0 })).toBe(from)
  })
})

describe('nudgePoint', () => {
  it('verschiebt mit Pfeiltasten um 0,5 %, mit Umschalttaste um 5 %', () => {
    const from = { x: 0.5, y: 0.5 }
    expect(nudgePoint(from, 'ArrowLeft')).toEqual({ x: 0.495, y: 0.5 })
    expect(nudgePoint(from, 'ArrowDown')).toEqual({ x: 0.5, y: 0.505 })
    expect(nudgePoint(from, 'ArrowRight', true)).toEqual({ x: 0.55, y: 0.5 })
    expect(nudgePoint({ x: 0.5, y: 0.02 }, 'ArrowUp', true)).toEqual({ x: 0.5, y: 0 })
    expect(nudgePoint(from, 'Enter')).toBeNull()
  })
})

describe('layoutBox (Bild-in-Bild)', () => {
  it('gleiches Seitenverhältnis: Kasten = Größe, Mitte wie angegeben', () => {
    expect(layoutBox({ x: 0.5, y: 0.4, scale: 0.5 }, 1280, 720, 1920, 1080)).toEqual({
      x: 0.5,
      y: 0.4,
      width: 0.5,
      height: 0.5,
    })
  })

  it('hält das Bild ganz im Format', () => {
    const box = layoutBox({ x: 1, y: 0, scale: 0.4 }, 640, 360, 640, 360)
    expect(box.x).toBeCloseTo(0.8)
    expect(box.y).toBeCloseTo(0.2)
  })

  it('anderes Seitenverhältnis: eingepasst, also schmaler bzw. flacher', () => {
    // Hochkant-Quelle im Querformat: volle Höhe des Rahmens, schmal.
    const tall = layoutBox({ x: 0.5, y: 0.5, scale: 0.5 }, 1080, 1920, 1920, 1080)
    expect(tall.height).toBeCloseTo(0.5)
    expect(tall.width).toBeCloseTo((1080 * (540 / 1920)) / 1920)
    // Ohne bekannte Größe: der Rahmen selbst.
    expect(layoutBox({ x: 0.5, y: 0.5, scale: 0.3 }, 0, 0, 1920, 1080)).toMatchObject({
      width: 0.3,
      height: 0.3,
    })
  })
})

describe('resizeScale', () => {
  it('wächst mit dem Abstand von der Mitte, begrenzt und auf Prozent gerundet', () => {
    expect(resizeScale(0.4, 100, 150, 0.05)).toBe(0.6)
    expect(resizeScale(0.4, 100, 1000, 0.05)).toBe(1)
    expect(resizeScale(0.4, 100, 1, 0.05)).toBe(0.05)
    expect(resizeScale(0.4, 100, 133, 0.05)).toBe(0.53)
    expect(resizeScale(0.4, 0, 133, 0.05)).toBe(0.4)
  })
})
