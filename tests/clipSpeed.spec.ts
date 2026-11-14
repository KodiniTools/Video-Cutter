import { describe, it, expect } from 'vitest'
import {
  SPEED_STEPS,
  formatSpeedFactor,
  formatSpeedStep,
  normalizeSpeedStep,
  speedFactor,
} from '@/lib/clipSpeed'

describe('clipSpeed', () => {
  it('Stufen −2,5 … +2,5 in 0,5er-Schritten', () => {
    expect(SPEED_STEPS).toEqual([-2.5, -2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2, 2.5])
  })

  it('Faktor: Plus = 1 + s, Minus = 1 / (1 + |s|), 0 = normal', () => {
    expect(speedFactor(0)).toBe(1)
    expect(speedFactor(1)).toBe(2)
    expect(speedFactor(2.5)).toBe(3.5)
    expect(speedFactor(-1)).toBe(0.5)
    expect(speedFactor(-2.5)).toBeCloseTo(1 / 3.5)
    // Symmetrisch: +s und −s heben sich auf
    for (const s of SPEED_STEPS) expect(speedFactor(s) * speedFactor(-s)).toBeCloseTo(1)
  })

  it('normalizeSpeedStep rundet, begrenzt und fängt Unsinn ab', () => {
    expect(normalizeSpeedStep(0.7)).toBe(0.5)
    expect(normalizeSpeedStep(-9)).toBe(-2.5)
    expect(normalizeSpeedStep('1.5')).toBe(1.5)
    expect(normalizeSpeedStep(undefined)).toBe(0)
    expect(normalizeSpeedStep(Number.NaN)).toBe(0)
    expect(Object.is(normalizeSpeedStep(-0.1), 0)).toBe(true)
  })

  it('Anzeige', () => {
    expect(formatSpeedFactor(0)).toBe('1×')
    expect(formatSpeedFactor(1)).toBe('2×')
    expect(formatSpeedFactor(0.5)).toBe('1,5×')
    expect(formatSpeedFactor(-1)).toBe('0,5×')
    expect(formatSpeedFactor(-2.5)).toBe('0,29×')
    expect(formatSpeedFactor(-0.5, 'en')).toBe('0.67×')
    expect(formatSpeedStep(1.5)).toBe('+1,5')
    expect(formatSpeedStep(-2)).toBe('−2')
    expect(formatSpeedStep(0)).toBe('0')
  })
})
