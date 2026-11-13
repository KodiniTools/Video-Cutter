import { describe, it, expect } from 'vitest'
import { frameCount, frameIndex, frameSeekTime, snapToFrame, stepFrames } from '@/lib/frameTime'

const NTSC = 30000 / 1001

describe('frameTime', () => {
  it('snapToFrame legt Zeiten auf den Anfang des sichtbaren Bildes', () => {
    expect(snapToFrame(3.212, 25)).toBe(3.2)
    expect(snapToFrame(3.235, 25)).toBe(3.2)
    expect(snapToFrame(3.24, 25)).toBe(3.24)
    // 29,97 fps: Bild 96 beginnt bei 3,2032 s -> ms-gerundet 3,203
    expect(snapToFrame(3.21, NTSC)).toBe(3.203)
    // ms-gerundeter Bildanfang bleibt stabil (kein Rutschen ins Vorbild)
    expect(snapToFrame(3.203, NTSC)).toBe(3.203)
    expect(snapToFrame(-1, 25)).toBe(0)
  })

  it('ohne Bildrate ms-genau', () => {
    expect(snapToFrame(3.2126, 0)).toBe(3.213)
    expect(stepFrames(3.2, 1, 0)).toBe(3.21)
    expect(stepFrames(0.005, -1, 0)).toBe(0)
    expect(frameSeekTime(1.5, 0)).toBe(1.5)
    expect(frameCount(0, 3, 0)).toBe(0)
  })

  it('stepFrames geht genau ein Bild und bleibt in [0, max]', () => {
    expect(stepFrames(3.2, 1, 25)).toBe(3.24)
    expect(stepFrames(3.2, -1, 25)).toBe(3.16)
    expect(stepFrames(0, -1, 25)).toBe(0)
    expect(stepFrames(9.96, 1, 25, 10)).toBe(10)
    expect(stepFrames(9.99, 5, 25, 10)).toBe(10)
    expect(stepFrames(3.203, 1, NTSC)).toBe(3.237)
    // Bildmitte (Seek-Ziel) zählt zum selben Bild
    expect(stepFrames(frameSeekTime(3.2, 25), 1, 25)).toBe(3.24)
  })

  it('frameSeekTime zielt auf die Bildmitte; Vorschau-Regel start <= t < end', () => {
    const start = snapToFrame(3.212, 25) // 3,2
    const end = snapToFrame(6.212, 25) // 6,2
    const t = frameSeekTime(start, 25)
    expect(t).toBeCloseTo(3.22, 6)
    expect(t >= start && t < end).toBe(true)
    // Cursor auf „Bis" zeigt das erste Bild ohne Text
    const tEnd = frameSeekTime(end, 25)
    expect(tEnd >= start && tEnd < end).toBe(false)
    expect(frameIndex(t, 25)).toBe(80)
  })

  it('frameCount zählt die Bilder mit Text', () => {
    expect(frameCount(3.2, 6.2, 25)).toBe(75)
    expect(frameCount(3.203, 6.206, NTSC)).toBe(90)
  })
})
