import { describe, it, expect } from 'vitest'
import {
  isClientRemuxEligible,
  selectSampleWindow,
  selectAudioWindow,
  MAX_CLIENT_REMUX_BYTES,
  type TimedSample,
} from '@/lib/remux'

/** Baut eine Sample-Liste: Keyframe alle `gop` Frames, 1 s Abstand. */
function makeSamples(count: number, gop = 5, step = 1): TimedSample[] {
  return Array.from({ length: count }, (_, i) => ({
    cts: i * step,
    dts: i * step,
    isSync: i % gop === 0,
  }))
}

describe('isClientRemuxEligible', () => {
  const base = { operation: 'keep', mode: 'copy', segmentCount: 1, ext: 'mp4' } as const

  it('erlaubt genau den verlustfreien Einzel-Ausschnitt in MP4/MOV', () => {
    expect(isClientRemuxEligible(base)).toBe(true)
    expect(isClientRemuxEligible({ ...base, ext: 'MOV' })).toBe(true)
    expect(isClientRemuxEligible({ ...base, ext: 'm4v' })).toBe(true)
  })

  it('lehnt Re-Encode, Entfernen, mehrere Ausschnitte und WebM ab', () => {
    expect(isClientRemuxEligible({ ...base, mode: 'reencode' })).toBe(false)
    expect(isClientRemuxEligible({ ...base, operation: 'remove' })).toBe(false)
    expect(isClientRemuxEligible({ ...base, segmentCount: 2 })).toBe(false)
    expect(isClientRemuxEligible({ ...base, segmentCount: 0 })).toBe(false)
    expect(isClientRemuxEligible({ ...base, ext: 'webm' })).toBe(false)
    expect(isClientRemuxEligible({ ...base, ext: 'mkv' })).toBe(false)
  })

  it('ignoriert die Größe, wenn keine angegeben ist', () => {
    expect(isClientRemuxEligible(base)).toBe(true)
  })

  it('lehnt Dateien über dem RAM-Limit ab, erlaubt Dateien darunter', () => {
    expect(isClientRemuxEligible({ ...base, sizeBytes: MAX_CLIENT_REMUX_BYTES + 1 })).toBe(false)
    expect(isClientRemuxEligible({ ...base, sizeBytes: MAX_CLIENT_REMUX_BYTES })).toBe(true)
    expect(isClientRemuxEligible({ ...base, sizeBytes: 5_000_000 })).toBe(true)
  })
})

describe('selectSampleWindow', () => {
  it('richtet den Start auf das letzte Keyframe bei/vor start aus', () => {
    const s = makeSamples(20) // Keyframes bei 0,5,10,15
    const win = selectSampleWindow(s, 7, 12)
    expect(win).not.toBeNull()
    // Letztes Keyframe <= 7 ist Index 5 (Zeit 5).
    expect(win!.firstIndex).toBe(5)
    expect(win!.startTime).toBe(5)
    // Letztes Sample mit cts <= 12 ist Index 12 (Zeit 12).
    expect(win!.lastIndex).toBe(12)
    expect(win!.endTime).toBe(12)
  })

  it('nimmt das Keyframe exakt am Startpunkt', () => {
    const s = makeSamples(20)
    const win = selectSampleWindow(s, 10, 14)
    expect(win!.firstIndex).toBe(10)
    expect(win!.startTime).toBe(10)
  })

  it('fällt auf das erste Keyframe zurück, wenn start davor liegt', () => {
    const s = makeSamples(20, 5, 1).map((x) => ({ ...x, cts: x.cts + 3, dts: x.dts + 3 }))
    // Erstes Keyframe liegt jetzt bei Zeit 3; Start 1 liegt davor.
    const win = selectSampleWindow(s, 1, 6)
    expect(win!.firstIndex).toBe(0)
    expect(win!.startTime).toBe(3)
  })

  it('klemmt das Ende ans letzte Sample', () => {
    const s = makeSamples(10) // 0..9
    const win = selectSampleWindow(s, 0, 999)
    expect(win!.lastIndex).toBe(9)
    expect(win!.endTime).toBe(9)
  })

  it('liefert mindestens ein Sample, wenn start≈end', () => {
    const s = makeSamples(20)
    const win = selectSampleWindow(s, 11, 11)
    expect(win!.firstIndex).toBe(10) // Keyframe bei 10
    expect(win!.lastIndex).toBeGreaterThanOrEqual(win!.firstIndex)
  })

  it('gibt null bei leerer Liste zurück', () => {
    expect(selectSampleWindow([], 0, 5)).toBeNull()
  })

  it('gibt null zurück, wenn es kein einziges Keyframe gibt', () => {
    const s = makeSamples(5, 999) // nie ein Sync-Sample außer evtl. Index 0
    const noSync = s.map((x) => ({ ...x, isSync: false }))
    expect(selectSampleWindow(noSync, 0, 3)).toBeNull()
  })
})

describe('selectAudioWindow', () => {
  it('wählt Audio-Samples im Video-Zeitfenster (inklusiv)', () => {
    const a: TimedSample[] = Array.from({ length: 100 }, (_, i) => ({
      cts: i * 0.02,
      dts: i * 0.02,
      isSync: true,
    }))
    const win = selectAudioWindow(a, 0.5, 1.0)
    expect(win).not.toBeNull()
    expect(a[win!.firstIndex].cts).toBeGreaterThanOrEqual(0.5 - 1e-3)
    expect(a[win!.lastIndex].cts).toBeLessThanOrEqual(1.0 + 1e-3)
  })

  it('gibt null zurück, wenn nichts im Fenster liegt', () => {
    const a: TimedSample[] = [{ cts: 5, dts: 5, isSync: true }]
    expect(selectAudioWindow(a, 0, 1)).toBeNull()
    expect(selectAudioWindow([], 0, 1)).toBeNull()
  })
})
