import { describe, it, expect } from 'vitest'
import { buildServerArgs, formatFfmpegTime } from '../src/lib/args'
import { parseCutParams, safeExt, safeBaseName, ValidationError } from '../src/lib/validate'

describe('formatFfmpegTime', () => {
  it('formatiert korrekt', () => {
    expect(formatFfmpegTime(0)).toBe('00:00:00.000')
    expect(formatFfmpegTime(65.5)).toBe('00:01:05.500')
    expect(formatFfmpegTime(0.9996)).toBe('00:00:01.000')
  })
})

describe('buildServerArgs', () => {
  it('enthält Progress-Flags und Copy-Codec', () => {
    const args = buildServerArgs({
      inputPath: '/tmp/in.mp4',
      outputPath: '/tmp/out.mp4',
      start: 10,
      duration: 15,
      mode: 'copy',
    })
    expect(args).toContain('-progress')
    expect(args).toContain('pipe:1')
    expect(args.slice(args.indexOf('-ss'))).toEqual([
      '-ss',
      '00:00:10.000',
      '-i',
      '/tmp/in.mp4',
      '-t',
      '00:00:15.000',
      '-c',
      'copy',
      '-avoid_negative_ts',
      'make_zero',
      '/tmp/out.mp4',
    ])
  })

  it('reencode nutzt libx264/aac und faststart', () => {
    const args = buildServerArgs({
      inputPath: '/tmp/in.webm',
      outputPath: '/tmp/out.mp4',
      start: 0,
      duration: 5,
      mode: 'reencode',
    })
    expect(args).toContain('libx264')
    expect(args).toContain('aac')
    expect(args).toContain('+faststart')
    expect(args.at(-1)).toBe('/tmp/out.mp4')
  })

  it('reencode nach .webm nutzt VP9/Opus statt H.264/AAC', () => {
    const args = buildServerArgs({
      inputPath: '/tmp/in.webm',
      outputPath: '/tmp/out.webm',
      start: 0,
      duration: 5,
      mode: 'reencode',
    })
    expect(args).toContain('libvpx-vp9')
    expect(args).toContain('libopus')
    expect(args).not.toContain('libx264')
    expect(args.at(-1)).toBe('/tmp/out.webm')
  })

  it('remove (Mitte) liest den Input zweimal und concatet (kein Split -> kein OOM)', () => {
    const args = buildServerArgs({
      inputPath: '/tmp/in.mp4',
      outputPath: '/tmp/out.mp4',
      start: 10,
      duration: 5, // entfernt [10, 15]
      mode: 'copy', // wird bei remove ignoriert
      operation: 'remove',
      total: 30,
    })
    // Input 0 auf [0,10] begrenzt, Input 1 ab 15 -> zwei -i auf denselben Pfad.
    expect(args.filter((a) => a === '/tmp/in.mp4')).toHaveLength(2)
    expect(args.slice(args.indexOf('-t'), args.indexOf('-t') + 2)).toEqual(['-t', '00:00:10.000'])
    expect(args.slice(args.indexOf('-ss'), args.indexOf('-ss') + 2)).toEqual([
      '-ss',
      '00:00:15.000',
    ])
    const fc = args[args.indexOf('-filter_complex') + 1]
    expect(fc).toContain('[1:v]') // zweiter Input wird referenziert
    expect(fc).toContain('concat=n=2:v=1:a=1')
    expect(args).toContain('libx264') // immer Re-Encode
    expect(args).toContain('-map')
  })

  it('remove am Anfang behält nur den Teil danach (einzelner Trim)', () => {
    const args = buildServerArgs({
      inputPath: '/tmp/in.mp4',
      outputPath: '/tmp/out.mp4',
      start: 0,
      duration: 8, // entfernt [0, 8]
      mode: 'reencode',
      operation: 'remove',
      total: 30,
    })
    expect(args).not.toContain('-filter_complex')
    expect(args.slice(args.indexOf('-ss'), args.indexOf('-i'))).toEqual(['-ss', '00:00:08.000'])
    expect(args).toContain('libx264')
  })
})

describe('parseCutParams', () => {
  const MAX = 3600
  it('akzeptiert gültige Werte', () => {
    expect(parseCutParams({ start: '3', duration: '7', mode: 'copy' }, MAX)).toEqual({
      start: 3,
      duration: 7,
      mode: 'copy',
      operation: 'keep',
      total: undefined,
    })
  })
  it('remove: verlangt gültige Gesamtdauer', () => {
    expect(() =>
      parseCutParams({ start: '5', duration: '3', mode: 'copy', operation: 'remove' }, MAX),
    ).toThrow(ValidationError)
  })
  it('remove: lehnt ab, wenn nichts übrig bliebe', () => {
    expect(() =>
      parseCutParams(
        { start: '0', duration: '10', mode: 'copy', operation: 'remove', total: '10' },
        MAX,
      ),
    ).toThrow(ValidationError)
  })
  it('remove: akzeptiert gültige Werte inkl. total', () => {
    expect(
      parseCutParams(
        { start: '5', duration: '3', mode: 'reencode', operation: 'remove', total: '30' },
        MAX,
      ),
    ).toEqual({ start: 5, duration: 3, mode: 'reencode', operation: 'remove', total: 30 })
  })
  it('lehnt negativen Start ab', () => {
    expect(() => parseCutParams({ start: '-1', duration: '7', mode: 'copy' }, MAX)).toThrow(
      ValidationError,
    )
  })
  it('lehnt Dauer <= 0 ab', () => {
    expect(() => parseCutParams({ start: '0', duration: '0', mode: 'copy' }, MAX)).toThrow(
      ValidationError,
    )
  })
  it('lehnt zu lange Dauer ab', () => {
    expect(() => parseCutParams({ start: '0', duration: '99999', mode: 'copy' }, MAX)).toThrow(
      ValidationError,
    )
  })
  it('lehnt unbekannten Modus ab', () => {
    expect(() => parseCutParams({ start: '0', duration: '7', mode: 'xyz' }, MAX)).toThrow(
      ValidationError,
    )
  })
})

describe('Namens-Helfer', () => {
  it('safeExt', () => {
    expect(safeExt('clip.MP4')).toBe('mp4')
    expect(safeExt('kein')).toBe('mp4')
  })
  it('safeBaseName entfernt gefährliche Zeichen', () => {
    expect(safeBaseName('../../etc/passwd.mp4')).toBe('etcpasswd')
    expect(safeBaseName('Mein Clip.mov')).toBe('Mein Clip')
    expect(safeBaseName('.mp4')).toBe('video')
  })
})
