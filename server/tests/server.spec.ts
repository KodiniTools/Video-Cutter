import { describe, it, expect } from 'vitest'
import { buildServerArgs, formatFfmpegTime, outputDurationFor } from '../src/lib/args'
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
    // Behalten: [0,10] und [15,30] -> zwei -i auf denselben Pfad.
    expect(args.filter((a) => a === '/tmp/in.mp4')).toHaveLength(2)
    // Erster Input: -ss 0 -t 10, zweiter Input: -ss 15 -t 15.
    const j = args.join(' ')
    expect(j).toContain('-ss 00:00:00.000 -t 00:00:10.000 -i /tmp/in.mp4')
    expect(j).toContain('-ss 00:00:15.000 -t 00:00:15.000 -i /tmp/in.mp4')
    const fc = args[args.indexOf('-filter_complex') + 1]
    expect(fc).toContain('[1:v]') // zweiter Input wird referenziert
    expect(fc).toContain('concat=n=2:v=1:a=1')
    expect(args).toContain('libx264') // immer Re-Encode
    expect(args).toContain('-map')
  })

  it('drei Behalten-Segmente werden zu concat=n=3 zusammengefügt', () => {
    const args = buildServerArgs({
      inputPath: '/tmp/in.mp4',
      outputPath: '/tmp/out.mp4',
      mode: 'reencode',
      operation: 'keep',
      segments: [
        { start: 0, duration: 5 },
        { start: 10, duration: 5 },
        { start: 20, duration: 5 },
      ],
    })
    expect(args.filter((a) => a === '/tmp/in.mp4')).toHaveLength(3)
    const fc = args[args.indexOf('-filter_complex') + 1]
    expect(fc).toContain('concat=n=3:v=1:a=1')
    expect(fc).toContain('[2:v]')
    expect(args).toContain('libx264')
  })

  it('Übergang: zwei Segmente werden per xfade/acrossfade überblendet', () => {
    const args = buildServerArgs({
      inputPath: '/tmp/in.mp4',
      outputPath: '/tmp/out.mp4',
      mode: 'reencode',
      operation: 'keep',
      segments: [
        { start: 0, duration: 8 },
        { start: 20, duration: 8 },
      ],
      transition: { preset: 'fade', duration: 2 },
    })
    const fc = args[args.indexOf('-filter_complex') + 1]
    // xfade mit Typ fade, Dauer 2, Offset = L0 - d = 8 - 2 = 6.
    expect(fc).toContain('xfade=transition=fade:duration=2.000:offset=6.000')
    expect(fc).toContain('acrossfade=d=2.000')
    expect(fc).toContain('[outv]')
    expect(fc).toContain('[outa]')
    expect(fc).not.toContain('concat=')
    expect(args).toContain('libx264')
  })

  it('Übergang: Preset wird auf xfade-Typ abgebildet (slide -> slideleft)', () => {
    const args = buildServerArgs({
      inputPath: '/tmp/in.mp4',
      outputPath: '/tmp/out.mp4',
      mode: 'reencode',
      operation: 'keep',
      segments: [
        { start: 0, duration: 6 },
        { start: 20, duration: 6 },
      ],
      transition: { preset: 'slide', duration: 3 },
    })
    const fc = args[args.indexOf('-filter_complex') + 1]
    expect(fc).toContain('xfade=transition=slideleft:')
  })

  it('Übergang: zu lange Dauer wird auf die Bereichslänge begrenzt', () => {
    const args = buildServerArgs({
      inputPath: '/tmp/in.mp4',
      outputPath: '/tmp/out.mp4',
      mode: 'reencode',
      operation: 'keep',
      segments: [
        { start: 0, duration: 3 },
        { start: 20, duration: 3 },
      ],
      transition: { preset: 'fade', duration: 10 },
    })
    const fc = args[args.indexOf('-filter_complex') + 1]
    // duration auf min(10, 3 - 0.05) = 2.95 begrenzt.
    expect(fc).toContain('duration=2.950')
  })

  it('Übergang none: normaler concat ohne xfade', () => {
    const args = buildServerArgs({
      inputPath: '/tmp/in.mp4',
      outputPath: '/tmp/out.mp4',
      mode: 'reencode',
      operation: 'keep',
      segments: [
        { start: 0, duration: 5 },
        { start: 10, duration: 5 },
      ],
      transition: { preset: 'none', duration: 2 },
    })
    const fc = args[args.indexOf('-filter_complex') + 1]
    expect(fc).toContain('concat=n=2')
    expect(fc).not.toContain('xfade')
  })

  it('outputDurationFor zieht die Übergangs-Überlappungen ab', () => {
    const keep = [
      { start: 0, duration: 8 },
      { start: 20, duration: 8 },
    ]
    expect(outputDurationFor(keep, undefined)).toBe(16)
    expect(outputDurationFor(keep, { preset: 'fade', duration: 2 })).toBe(14)
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
  it('akzeptiert gültige Werte (Fallback start/duration -> segments)', () => {
    expect(parseCutParams({ start: '3', duration: '7', mode: 'copy' }, MAX)).toEqual({
      segments: [{ start: 3, duration: 7 }],
      mode: 'copy',
      operation: 'keep',
      total: undefined,
    })
  })
  it('akzeptiert eine JSON-Segment-Liste', () => {
    expect(
      parseCutParams(
        {
          segments: JSON.stringify([
            { start: 1, duration: 2 },
            { start: 10, duration: 5 },
          ]),
          mode: 'reencode',
        },
        MAX,
      ),
    ).toEqual({
      segments: [
        { start: 1, duration: 2 },
        { start: 10, duration: 5 },
      ],
      mode: 'reencode',
      operation: 'keep',
      total: undefined,
    })
  })
  it('lehnt eine ungültige Segment-Liste (kein JSON) ab', () => {
    expect(() => parseCutParams({ segments: 'nicht-json', mode: 'copy' }, MAX)).toThrow(
      ValidationError,
    )
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
    ).toEqual({
      segments: [{ start: 5, duration: 3 }],
      mode: 'reencode',
      operation: 'remove',
      total: 30,
    })
  })
  it('remove: mehrere Segmente lassen Rest übrig', () => {
    expect(
      parseCutParams(
        {
          segments: JSON.stringify([
            { start: 2, duration: 3 },
            { start: 10, duration: 4 },
          ]),
          mode: 'reencode',
          operation: 'remove',
          total: '30',
        },
        MAX,
      ),
    ).toEqual({
      segments: [
        { start: 2, duration: 3 },
        { start: 10, duration: 4 },
      ],
      mode: 'reencode',
      operation: 'remove',
      total: 30,
    })
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
