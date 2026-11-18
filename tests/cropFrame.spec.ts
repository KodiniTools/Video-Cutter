import { describe, expect, it } from 'vitest'
import {
  cropFrameSourceTime,
  cropPixelSize,
  DEFAULT_CLIP_CROP,
  playheadInClip,
  sameCrop,
} from '@/timeline/cropFrame'

const clip = { start: 2_000_000, duration: 4_000_000, sourceIn: 1_000_000, speed: 2 }

describe('cropFrameSourceTime', () => {
  it('nimmt die Quellzeit am Abspielkopf (mit Tempo)', () => {
    expect(cropFrameSourceTime(clip, 3_000_000)).toBe(3_000_000)
  })
  it('holt den Abspielkopf vor dem Clip an dessen Anfang', () => {
    expect(cropFrameSourceTime(clip, 0)).toBe(1_000_000)
  })
  it('holt den Abspielkopf hinter dem Clip an dessen letztes Bild', () => {
    expect(cropFrameSourceTime(clip, 99_000_000)).toBe(1_000_000 + (4_000_000 - 1) * 2)
  })
})

describe('playheadInClip', () => {
  it('Anfang zählt, Ende nicht', () => {
    expect(playheadInClip(clip, 2_000_000)).toBe(true)
    expect(playheadInClip(clip, 6_000_000)).toBe(false)
    expect(playheadInClip(clip, 1_999_999)).toBe(false)
  })
})

describe('cropPixelSize', () => {
  it('rechnet den Ausschnitt in Pixel der Quelle um', () => {
    expect(cropPixelSize({ width: 1920, height: 1080 }, DEFAULT_CLIP_CROP)).toEqual({
      width: 1536,
      height: 864,
    })
  })
  it('ohne Zuschnitt die ganze Größe, ohne bekannte Größe null', () => {
    expect(cropPixelSize({ width: 640, height: 360 }, null)).toEqual({ width: 640, height: 360 })
    expect(cropPixelSize(undefined, DEFAULT_CLIP_CROP)).toBeNull()
    expect(cropPixelSize({}, DEFAULT_CLIP_CROP)).toBeNull()
  })
})

describe('sameCrop', () => {
  it('vergleicht wie gespeichert', () => {
    expect(sameCrop(null, undefined)).toBe(true)
    expect(sameCrop(null, { x: 0, y: 0, width: 1, height: 1 })).toBe(true)
    expect(sameCrop(DEFAULT_CLIP_CROP, { ...DEFAULT_CLIP_CROP, x: 0.100001 })).toBe(true)
    expect(sameCrop(DEFAULT_CLIP_CROP, { ...DEFAULT_CLIP_CROP, x: 0.12 })).toBe(false)
    expect(sameCrop(DEFAULT_CLIP_CROP, null)).toBe(false)
  })
})
