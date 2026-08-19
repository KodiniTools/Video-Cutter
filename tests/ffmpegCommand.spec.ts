import { describe, it, expect } from 'vitest'
import {
  clamp,
  formatFfmpegTime,
  formatDisplayTime,
  getExtension,
  buildTrimArgs,
} from '@/lib/ffmpegCommand'

describe('clamp', () => {
  it('begrenzt auf das Intervall', () => {
    expect(clamp(5, 0, 10)).toBe(5)
    expect(clamp(-3, 0, 10)).toBe(0)
    expect(clamp(99, 0, 10)).toBe(10)
  })
  it('gibt bei NaN min zurück', () => {
    expect(clamp(Number.NaN, 2, 10)).toBe(2)
  })
})

describe('formatFfmpegTime', () => {
  it('formatiert Null korrekt', () => {
    expect(formatFfmpegTime(0)).toBe('00:00:00.000')
  })
  it('formatiert Minuten/Sekunden/Millisekunden', () => {
    expect(formatFfmpegTime(65.5)).toBe('00:01:05.500')
  })
  it('formatiert Stunden', () => {
    expect(formatFfmpegTime(3661.25)).toBe('01:01:01.250')
  })
  it('fängt Millisekunden-Rundung auf 1000 ab', () => {
    expect(formatFfmpegTime(0.9996)).toBe('00:00:01.000')
  })
})

describe('formatDisplayTime', () => {
  it('zeigt MM:SS', () => {
    expect(formatDisplayTime(0)).toBe('00:00')
    expect(formatDisplayTime(75)).toBe('01:15')
  })
})

describe('getExtension', () => {
  it('liefert die Endung klein', () => {
    expect(getExtension('clip.MP4')).toBe('mp4')
    expect(getExtension('a.b.webm')).toBe('webm')
  })
  it('fällt auf mp4 zurück', () => {
    expect(getExtension('ohneendung')).toBe('mp4')
  })
})

describe('buildTrimArgs', () => {
  it('copy: nutzt Stream-Copy und korrekte Dauer', () => {
    const args = buildTrimArgs({
      inputName: 'input.mp4',
      outputName: 'output.mp4',
      start: 10,
      end: 25,
      mode: 'copy',
    })
    expect(args).toEqual([
      '-ss',
      '00:00:10.000',
      '-i',
      'input.mp4',
      '-t',
      '00:00:15.000',
      '-c',
      'copy',
      '-avoid_negative_ts',
      'make_zero',
      'output.mp4',
    ])
  })

  it('reencode: nutzt libx264/aac', () => {
    const args = buildTrimArgs({
      inputName: 'input.webm',
      outputName: 'output.mp4',
      start: 0,
      end: 5,
      mode: 'reencode',
    })
    expect(args).toContain('-c:v')
    expect(args).toContain('libx264')
    expect(args).toContain('-c:a')
    expect(args).toContain('aac')
    expect(args.at(-1)).toBe('output.mp4')
  })

  it('negative Dauer wird auf 0 begrenzt', () => {
    const args = buildTrimArgs({
      inputName: 'i.mp4',
      outputName: 'o.mp4',
      start: 20,
      end: 10,
      mode: 'copy',
    })
    const tIndex = args.indexOf('-t')
    expect(args[tIndex + 1]).toBe('00:00:00.000')
  })
})
