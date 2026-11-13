import { describe, it, expect } from 'vitest'
import { formatNudge, formatTimeMs, parseTimeInput, toMs } from '@/lib/timeFormat'

describe('formatTimeMs', () => {
  it('formatiert mm:ss.mmm', () => {
    expect(formatTimeMs(0)).toBe('00:00.000')
    expect(formatTimeMs(65.432)).toBe('01:05.432')
    expect(formatTimeMs(9.9996)).toBe('00:10.000')
  })
  it('zeigt Stunden nur bei Bedarf', () => {
    expect(formatTimeMs(3600)).toBe('1:00:00.000')
    expect(formatTimeMs(3661.5)).toBe('1:01:01.500')
  })
  it('negativ/NaN -> 0', () => {
    expect(formatTimeMs(-3)).toBe('00:00.000')
    expect(formatTimeMs(Number.NaN)).toBe('00:00.000')
  })
})

describe('toMs', () => {
  it('rundet auf ganze Millisekunden', () => {
    expect(toMs(1.2345)).toBe(1235)
    expect(toMs(-1)).toBe(0)
  })
})

describe('parseTimeInput', () => {
  it('parst mm:ss.mmm und hh:mm:ss.mmm', () => {
    expect(parseTimeInput('01:05.432')).toBeCloseTo(65.432, 6)
    expect(parseTimeInput('1:00:00.000')).toBe(3600)
    expect(parseTimeInput('0:30')).toBe(30)
  })
  it('reine Zahl = Sekunden, Komma erlaubt', () => {
    expect(parseTimeInput('12')).toBe(12)
    expect(parseTimeInput('12,5')).toBe(12.5)
  })
  it('ungültig -> null', () => {
    expect(parseTimeInput('')).toBeNull()
    expect(parseTimeInput('abc')).toBeNull()
    expect(parseTimeInput('1:2:3:4')).toBeNull()
    expect(parseTimeInput('00:75')).toBeNull()
    expect(parseTimeInput('-1')).toBeNull()
  })
})

describe('formatNudge', () => {
  it('Millisekunden mit Vorzeichen', () => {
    expect(formatNudge(-100)).toBe('-100ms')
    expect(formatNudge(1)).toBe('+1ms')
  })
  it('volle Sekunden als s', () => {
    expect(formatNudge(-1000)).toBe('-1s')
    expect(formatNudge(1000)).toBe('+1s')
  })
})
