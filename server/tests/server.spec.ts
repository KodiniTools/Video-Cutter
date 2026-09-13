import { describe, it, expect } from 'vitest'
import {
  buildServerArgs,
  buildCropFilter,
  formatFfmpegTime,
  outputDurationFor,
} from '../src/lib/args'
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

  it('Übergang fade: Dip to Black (ausblenden + einblenden, kein xfade)', () => {
    const args = buildServerArgs({
      inputPath: '/tmp/in.mp4',
      outputPath: '/tmp/out.mp4',
      mode: 'reencode',
      operation: 'keep',
      segments: [
        { start: 0, duration: 8 },
        { start: 20, duration: 8 },
      ],
      transition: { preset: 'fade', duration: 4 },
    })
    const fc = args[args.indexOf('-filter_complex') + 1]
    // Gesamtdauer 4 -> je Seite f = 2 s.
    // Clip 0 blendet am Ende aus (st = 8 - 2 = 6), Clip 1 blendet am Anfang ein.
    expect(fc).toContain('fade=t=out:st=6.000:d=2.000')
    expect(fc).toContain('fade=t=in:st=0:d=2.000')
    expect(fc).toContain('afade=t=out:st=6.000:d=2.000')
    expect(fc).toContain('afade=t=in:st=0:d=2.000')
    expect(fc).toContain('concat=n=2:v=1:a=1')
    expect(fc).not.toContain('xfade')
    expect(args).toContain('libx264')
  })

  it('Übergang: geometrisches Preset nutzt xfade (slide -> slideleft)', () => {
    const args = buildServerArgs({
      inputPath: '/tmp/in.mp4',
      outputPath: '/tmp/out.mp4',
      mode: 'reencode',
      operation: 'keep',
      segments: [
        { start: 0, duration: 8 },
        { start: 20, duration: 8 },
      ],
      transition: { preset: 'slide', duration: 4 },
    })
    const fc = args[args.indexOf('-filter_complex') + 1]
    // Gesamtdauer 4 -> Überblendung d = 2; Offset = L0 - d = 8 - 2 = 6.
    expect(fc).toContain('xfade=transition=slideleft:duration=2.000:offset=6.000')
    expect(fc).toContain('acrossfade=d=2.000')
  })

  it('Übergang: zu lange Dauer wird auf die Bereichslänge begrenzt (xfade)', () => {
    const args = buildServerArgs({
      inputPath: '/tmp/in.mp4',
      outputPath: '/tmp/out.mp4',
      mode: 'reencode',
      operation: 'keep',
      segments: [
        { start: 0, duration: 3 },
        { start: 20, duration: 3 },
      ],
      transition: { preset: 'scale', duration: 10 },
    })
    const fc = args[args.indexOf('-filter_complex') + 1]
    // d = min(10/2=5, 3 - 0.05=2.95) = 2.95 (auf Bereichslänge begrenzt).
    expect(fc).toContain('duration=2.950')
  })

  it('Übergang none: normaler concat ohne xfade/fade', () => {
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
    expect(fc).not.toContain('fade=t=')
  })

  it('outputDurationFor: xfade verkürzt, Dip-to-Black behält die Länge', () => {
    const keep = [
      { start: 0, duration: 8 },
      { start: 20, duration: 8 },
    ]
    expect(outputDurationFor(keep, undefined)).toBe(16)
    // Dip to Black überlappt nicht -> volle Länge.
    expect(outputDurationFor(keep, { preset: 'fade', duration: 4 })).toBe(16)
    // xfade (slide) überlappt um d = 2 -> 16 - 2 = 14.
    expect(outputDurationFor(keep, { preset: 'slide', duration: 4 })).toBe(14)
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

describe('buildCropFilter', () => {
  it('baut den crop-Filter über iw/ih-Ausdrücke mit geraden Pixelzahlen', () => {
    expect(buildCropFilter({ x: 0.25, y: 0.1, width: 0.5, height: 0.6 })).toBe(
      'crop=trunc(iw*0.5/2)*2:trunc(ih*0.6/2)*2:trunc(iw*0.25/2)*2:trunc(ih*0.1/2)*2',
    )
  })
  it('begrenzt Position, damit der Ausschnitt nie über den Rand ragt', () => {
    // x/y = 0.9 mit Breite/Höhe 0.5 würde über den Rand ragen -> auf 1-0.5=0.5 geklemmt.
    const f = buildCropFilter({ x: 0.9, y: 0.9, width: 0.5, height: 0.5 })
    expect(f).toBe('crop=trunc(iw*0.5/2)*2:trunc(ih*0.5/2)*2:trunc(iw*0.5/2)*2:trunc(ih*0.5/2)*2')
  })
})

describe('buildServerArgs mit Bildausschnitt (Crop)', () => {
  it('einzelnes Segment + copy + crop -> erzwingt Re-Encode mit -vf crop', () => {
    const args = buildServerArgs({
      inputPath: '/tmp/in.mp4',
      outputPath: '/tmp/out.mp4',
      start: 0,
      duration: 5,
      mode: 'copy',
      crop: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
    })
    expect(args).not.toContain('-c')
    expect(args).toContain('libx264') // kein Stream-Copy mehr möglich
    const vf = args[args.indexOf('-vf') + 1]
    expect(vf).toContain('crop=')
  })

  it('mehrere Segmente (concat) + crop: Filter enthält crop vor setpts', () => {
    const args = buildServerArgs({
      inputPath: '/tmp/in.mp4',
      outputPath: '/tmp/out.mp4',
      mode: 'reencode',
      operation: 'keep',
      segments: [
        { start: 0, duration: 5 },
        { start: 10, duration: 5 },
      ],
      crop: { x: 0, y: 0, width: 0.5, height: 0.5 },
    })
    const fc = args[args.indexOf('-filter_complex') + 1]
    expect(fc).toMatch(/\[0:v\]crop=.*,setpts=PTS-STARTPTS\[v0\]/)
    expect(fc).toMatch(/\[1:v\]crop=.*,setpts=PTS-STARTPTS\[v1\]/)
  })

  it('Übergang (xfade) + crop: Filter enthält crop vor fps/format', () => {
    const args = buildServerArgs({
      inputPath: '/tmp/in.mp4',
      outputPath: '/tmp/out.mp4',
      mode: 'reencode',
      operation: 'keep',
      segments: [
        { start: 0, duration: 8 },
        { start: 20, duration: 8 },
      ],
      transition: { preset: 'slide', duration: 4 },
      crop: { x: 0.2, y: 0.2, width: 0.6, height: 0.6 },
    })
    const fc = args[args.indexOf('-filter_complex') + 1]
    expect(fc).toMatch(/\[0:v\]crop=.*,fps=30,format=yuv420p/)
  })

  it('ohne Crop bleibt der verlustfreie Copy-Pfad unverändert', () => {
    const args = buildServerArgs({
      inputPath: '/tmp/in.mp4',
      outputPath: '/tmp/out.mp4',
      start: 0,
      duration: 5,
      mode: 'copy',
    })
    expect(args).toContain('-c')
    expect(args).not.toContain('-vf')
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

  it('akzeptiert einen gültigen Bildausschnitt (JSON)', () => {
    const params = parseCutParams(
      {
        start: '0',
        duration: '7',
        mode: 'copy',
        crop: JSON.stringify({ x: 0.1, y: 0.2, width: 0.5, height: 0.6 }),
      },
      MAX,
    )
    expect(params.crop).toEqual({ x: 0.1, y: 0.2, width: 0.5, height: 0.6 })
  })
  it('ohne crop-Feld bleibt crop undefined', () => {
    const params = parseCutParams({ start: '0', duration: '7', mode: 'copy' }, MAX)
    expect(params.crop).toBeUndefined()
  })
  it('lehnt einen Bildausschnitt außerhalb des Bildes ab', () => {
    expect(() =>
      parseCutParams(
        {
          start: '0',
          duration: '7',
          mode: 'copy',
          crop: JSON.stringify({ x: 0.6, y: 0, width: 0.6, height: 0.5 }),
        },
        MAX,
      ),
    ).toThrow(ValidationError)
  })
  it('lehnt eine Ausschnittgröße von 0 oder > 1 ab', () => {
    expect(() =>
      parseCutParams(
        {
          start: '0',
          duration: '7',
          mode: 'copy',
          crop: JSON.stringify({ x: 0, y: 0, width: 0, height: 0.5 }),
        },
        MAX,
      ),
    ).toThrow(ValidationError)
    expect(() =>
      parseCutParams(
        {
          start: '0',
          duration: '7',
          mode: 'copy',
          crop: JSON.stringify({ x: 0, y: 0, width: 1.5, height: 0.5 }),
        },
        MAX,
      ),
    ).toThrow(ValidationError)
  })
  it('lehnt ungültiges Crop-JSON ab', () => {
    expect(() =>
      parseCutParams({ start: '0', duration: '7', mode: 'copy', crop: 'nicht-json' }, MAX),
    ).toThrow(ValidationError)
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
