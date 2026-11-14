import { describe, it, expect } from 'vitest'
import {
  buildServerArgs,
  buildCropFilter,
  formatFfmpegTime,
  outputDurationFor,
  buildMergeArgs,
  mergeTargetSize,
  mergeSequence,
  LOUDNORM_FILTER,
  outputTargetSize,
  musicMixFilter,
  resolveSeams,
  mergeOutputDuration,
  previewTargetSize,
  PREVIEW_CODECS,
} from '../src/lib/args'
import { parseFrameRate, parseProbeOutput } from '../src/lib/probe'
import {
  parseAppendMeta,
  parseCutParams,
  parseNormalizeAudio,
  parseOutputFormat,
  parseMusicParams,
  parseSeamTransitions,
  resolveAppendRange,
  safeExt,
  safeBaseName,
  ValidationError,
} from '../src/lib/validate'

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

describe('parseProbeOutput', () => {
  it('liest Maße, Tonspur und Dauer', () => {
    const json = JSON.stringify({
      streams: [{ codec_type: 'video', width: 1920, height: 1080 }, { codec_type: 'audio' }],
      format: { duration: '12.5' },
    })
    expect(parseProbeOutput(json)).toEqual({
      width: 1920,
      height: 1080,
      hasAudio: true,
      duration: 12.5,
      fps: 0,
    })
  })

  it('liest die Bildrate (avg_frame_rate bevorzugt, Unsinn -> 0)', () => {
    const probe = (s: Record<string, unknown>) =>
      parseProbeOutput(JSON.stringify({ streams: [{ codec_type: 'video', ...s }] })).fps
    expect(probe({ avg_frame_rate: '25/1', r_frame_rate: '50/1' })).toBe(25)
    expect(probe({ avg_frame_rate: '30000/1001' })).toBeCloseTo(29.97, 2)
    expect(probe({ avg_frame_rate: '0/0', r_frame_rate: '24/1' })).toBe(24)
    expect(probe({ avg_frame_rate: '0/0', r_frame_rate: '90000/1' })).toBe(0)
    expect(parseFrameRate(undefined)).toBe(0)
    expect(parseFrameRate('abc')).toBe(0)
  })

  it('tauscht Breite/Höhe bei 90°-Rotation (Hochkant-Handyvideo)', () => {
    const json = JSON.stringify({
      streams: [
        { codec_type: 'video', width: 1920, height: 1080, side_data_list: [{ rotation: -90 }] },
      ],
      format: { duration: '3' },
    })
    expect(parseProbeOutput(json)).toMatchObject({ width: 1080, height: 1920, hasAudio: false })
  })

  it('unbekannte Werte -> 0, ungültiges JSON wirft', () => {
    expect(parseProbeOutput('{}')).toEqual({
      width: 0,
      height: 0,
      hasAudio: false,
      duration: 0,
      fps: 0,
    })
    expect(() => parseProbeOutput('kein json')).toThrow()
  })
})

describe('mergeTargetSize', () => {
  it('nutzt die Hauptauflösung (gerade Pixel), mit Crop verkleinert', () => {
    expect(mergeTargetSize(1920, 1080)).toEqual({ width: 1920, height: 1080 })
    expect(mergeTargetSize(1921, 1081)).toEqual({ width: 1920, height: 1080 })
    expect(mergeTargetSize(1920, 1080, { x: 0, y: 0, width: 0.5, height: 0.5 })).toEqual({
      width: 960,
      height: 540,
    })
  })

  it('Fallback 1280×720 ohne bekannte Maße', () => {
    expect(mergeTargetSize(0, 0)).toEqual({ width: 1280, height: 720 })
  })
})

describe('buildMergeArgs (Videos anhängen)', () => {
  const base = {
    inputPath: '/tmp/in.mp4',
    outputPath: '/tmp/out.mp4',
    keep: [{ start: 2, duration: 3 }],
    mainHasAudio: true,
    width: 1280,
    height: 720,
  }

  it('Ausschnitt + angehängtes Video -> concat mit Normierung auf Zielauflösung', () => {
    const args = buildMergeArgs({
      ...base,
      appends: [{ path: '/tmp/b.mp4', duration: 4, hasAudio: true }],
    })
    // Hauptvideo als -ss/-t-Input, angehängtes Video vollständig.
    expect(args.slice(args.indexOf('-ss'), args.indexOf('-filter_complex'))).toEqual([
      '-ss',
      '00:00:02.000',
      '-t',
      '00:00:03.000',
      '-i',
      '/tmp/in.mp4',
      '-t',
      '00:00:04.000',
      '-i',
      '/tmp/b.mp4',
    ])
    const filter = args[args.indexOf('-filter_complex') + 1]
    expect(filter).toContain('scale=1280:720:force_original_aspect_ratio=decrease')
    expect(filter).toContain('pad=1280:720:(ow-iw)/2:(oh-ih)/2')
    expect(filter).toContain('[1:a]aresample=48000')
    expect(filter).toContain('concat=n=2:v=1:a=1[outv][outa]')
    expect(args).toContain('libx264')
    expect(args.at(-1)).toBe('/tmp/out.mp4')
  })

  it('fehlende Tonspur wird durch Stille in Clip-Länge ersetzt', () => {
    const args = buildMergeArgs({
      ...base,
      appends: [{ path: '/tmp/b.mp4', duration: 4, hasAudio: false }],
    })
    const filter = args[args.indexOf('-filter_complex') + 1]
    expect(filter).toContain('anullsrc=r=48000:cl=stereo:d=4.000,')
    expect(filter).not.toContain('[1:a]')
  })

  it('Crop gilt nur für das Hauptvideo, nicht für angehängte Videos', () => {
    const args = buildMergeArgs({
      ...base,
      appends: [{ path: '/tmp/b.mp4', duration: 4, hasAudio: true }],
      crop: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 },
    })
    const filter = args[args.indexOf('-filter_complex') + 1]
    expect(filter.match(/crop=/g)).toHaveLength(1)
    expect(filter).toMatch(/\[0:v\]crop=/)
  })

  it('Übergang slide -> xfade-Kette über alle Clips', () => {
    const args = buildMergeArgs({
      ...base,
      appends: [
        { path: '/tmp/b.mp4', duration: 4, hasAudio: true },
        { path: '/tmp/c.mp4', duration: 5, hasAudio: true },
      ],
      transition: { preset: 'slide', duration: 2 },
    })
    const filter = args[args.indexOf('-filter_complex') + 1]
    // d = 1 s (Hälfte der Gesamtdauer); Offsets: 3-1=2, 7-2=5.
    expect(filter).toContain('xfade=transition=slideleft:duration=1.000:offset=2.000[vx1]')
    expect(filter).toContain('xfade=transition=slideleft:duration=1.000:offset=5.000[outv]')
    expect(filter).not.toContain('concat=')
  })

  it('WebM-Ziel nutzt VP9/Opus', () => {
    const args = buildMergeArgs({
      ...base,
      outputPath: '/tmp/out.webm',
      appends: [{ path: '/tmp/b.mp4', duration: 4, hasAudio: true }],
    })
    expect(args).toContain('libvpx-vp9')
  })
})

describe('Angehängte Videos: Kürzung und Position', () => {
  const base = {
    inputPath: '/tmp/in.mp4',
    outputPath: '/tmp/out.mp4',
    keep: [{ start: 2, duration: 3 }],
    mainHasAudio: true,
    width: 1280,
    height: 720,
  }

  it('gekürztes Video wird per -ss/-t eingelesen', () => {
    const args = buildMergeArgs({
      ...base,
      appends: [{ path: '/tmp/b.mp4', start: 1.5, duration: 2, hasAudio: true }],
    })
    const i = args.indexOf('/tmp/b.mp4')
    expect(args.slice(i - 5, i + 1)).toEqual([
      '-ss',
      '00:00:01.500',
      '-t',
      '00:00:02.000',
      '-i',
      '/tmp/b.mp4',
    ])
  })

  it('Reihenfolge: davor -> Ausschnitte -> danach (Listenreihenfolge je Gruppe)', () => {
    const args = buildMergeArgs({
      ...base,
      appends: [
        { path: '/tmp/after1.mp4', duration: 4, hasAudio: true, position: 'after' },
        { path: '/tmp/intro.mp4', duration: 2, hasAudio: true, position: 'before' },
        { path: '/tmp/after2.mp4', duration: 5, hasAudio: true },
      ],
    })
    const inputs = args.filter((_, k) => args[k - 1] === '-i')
    expect(inputs).toEqual(['/tmp/intro.mp4', '/tmp/in.mp4', '/tmp/after1.mp4', '/tmp/after2.mp4'])
    // Crop/Ton-Zuordnung folgt den Input-Indizes: Hauptvideo ist jetzt Input 1.
    const filter = args[args.indexOf('-filter_complex') + 1]
    expect(filter).toContain('concat=n=4:v=1:a=1')
  })

  it('Crop trifft auch bei einem Intro nur das Hauptvideo', () => {
    const args = buildMergeArgs({
      ...base,
      appends: [{ path: '/tmp/intro.mp4', duration: 2, hasAudio: true, position: 'before' }],
      crop: { x: 0, y: 0, width: 0.5, height: 0.5 },
    })
    const filter = args[args.indexOf('-filter_complex') + 1]
    expect(filter).toMatch(/\[1:v\]crop=/)
    expect(filter).not.toMatch(/\[0:v\]crop=/)
  })

  it('parseAppendMeta: Standardwerte ohne Feld, liest JSON, prüft Anzahl/Werte', () => {
    expect(parseAppendMeta({}, 2)).toEqual([
      { start: 0, position: 'after' },
      { start: 0, position: 'after' },
    ])
    expect(
      parseAppendMeta(
        { appendMeta: JSON.stringify([{ start: 1, duration: 2, position: 'before' }]) },
        1,
      ),
    ).toEqual([{ start: 1, duration: 2, position: 'before' }])
    expect(() => parseAppendMeta({ appendMeta: '[]' }, 1)).toThrow(ValidationError)
    expect(() => parseAppendMeta({ appendMeta: 'x' }, 1)).toThrow(ValidationError)
    expect(() => parseAppendMeta({ appendMeta: '[{"start":-1}]' }, 1)).toThrow(ValidationError)
    expect(() => parseAppendMeta({ appendMeta: '[{"duration":0}]' }, 1)).toThrow(ValidationError)
    expect(() => parseAppendMeta({ appendMeta: '[{"position":"mitte"}]' }, 1)).toThrow(
      ValidationError,
    )
  })

  it('resolveAppendRange begrenzt auf die echte Dauer', () => {
    expect(resolveAppendRange({ start: 0, position: 'after' }, 10)).toEqual({
      start: 0,
      duration: 10,
    })
    expect(resolveAppendRange({ start: 4, duration: 100, position: 'after' }, 10)).toEqual({
      start: 4,
      duration: 6,
    })
    expect(() => resolveAppendRange({ start: 10, position: 'after' }, 10)).toThrow(ValidationError)
  })
})

describe('Angehängte Videos: freie Einfügestelle (slot)', () => {
  const base = {
    inputPath: '/tmp/in.mp4',
    outputPath: '/tmp/out.mp4',
    keep: [
      { start: 0, duration: 2 },
      { start: 5, duration: 3 },
      { start: 10, duration: 1 },
    ],
    mainHasAudio: true,
    width: 1280,
    height: 720,
  }
  const inputsOf = (args: string[]) => args.filter((_, k) => args[k - 1] === '-i')

  it('mergeSequence: davor, zwischen den Bereichen, danach (Listenreihenfolge je Stelle)', () => {
    const seq = mergeSequence(3, [
      { path: 'a', duration: 1, hasAudio: true, position: 'after' },
      { path: 'b', duration: 1, hasAudio: true, position: 'after', slot: 1 },
      { path: 'c', duration: 1, hasAudio: true, position: 'before', slot: 2 },
      { path: 'd', duration: 1, hasAudio: true, position: 'after', slot: 1 },
      { path: 'e', duration: 1, hasAudio: true, position: 'after', slot: 2 },
    ])
    expect(seq.map((x) => `${x.kind[0]}${x.index}`)).toEqual([
      'a2', // c (before, slot ignoriert)
      'm0',
      'a1',
      'a3',
      'm1',
      'a4',
      'm2',
      'a0',
    ])
  })

  it('Slot außerhalb (≥ Anzahl Bereiche) landet am Ende', () => {
    const seq = mergeSequence(1, [
      { path: 'a', duration: 1, hasAudio: true, position: 'after', slot: 1 },
      { path: 'b', duration: 1, hasAudio: true, position: 'after', slot: 7 },
    ])
    expect(seq.map((x) => `${x.kind[0]}${x.index}`)).toEqual(['m0', 'a0', 'a1'])
  })

  it('buildMergeArgs fügt ein Video zwischen zwei Ausschnitte ein', () => {
    const args = buildMergeArgs({
      ...base,
      appends: [{ path: '/tmp/x.mp4', duration: 4, hasAudio: true, position: 'after', slot: 2 }],
    })
    expect(inputsOf(args)).toEqual(['/tmp/in.mp4', '/tmp/in.mp4', '/tmp/x.mp4', '/tmp/in.mp4'])
    const ss = args.filter((_, k) => args[k - 1] === '-ss')
    expect(ss).toEqual(['00:00:00.000', '00:00:05.000', '00:00:10.000'])
    expect(args[args.indexOf('-filter_complex') + 1]).toContain('concat=n=4:v=1:a=1')
  })

  it('ohne slot bleibt das bisherige Verhalten (davor/danach) unverändert', () => {
    const args = buildMergeArgs({
      ...base,
      appends: [
        { path: '/tmp/out1.mp4', duration: 4, hasAudio: true },
        { path: '/tmp/intro.mp4', duration: 2, hasAudio: true, position: 'before' },
      ],
    })
    expect(inputsOf(args)).toEqual([
      '/tmp/intro.mp4',
      '/tmp/in.mp4',
      '/tmp/in.mp4',
      '/tmp/in.mp4',
      '/tmp/out1.mp4',
    ])
  })

  it('parseAppendMeta liest slot, verwirft ihn bei "before" und prüft den Wert', () => {
    expect(
      parseAppendMeta({ appendMeta: JSON.stringify([{ position: 'after', slot: 2 }]) }, 1),
    ).toEqual([{ start: 0, position: 'after', slot: 2 }])
    expect(
      parseAppendMeta({ appendMeta: JSON.stringify([{ position: 'before', slot: 2 }]) }, 1)[0],
    ).not.toHaveProperty('slot')
    expect(() => parseAppendMeta({ appendMeta: '[{"slot":0}]' }, 1)).toThrow(ValidationError)
    expect(() => parseAppendMeta({ appendMeta: '[{"slot":1.5}]' }, 1)).toThrow(ValidationError)
    expect(() => parseAppendMeta({ appendMeta: '[{"slot":"x"}]' }, 1)).toThrow(ValidationError)
  })
})

describe('Lautstärke angleichen (loudnorm)', () => {
  const base = {
    inputPath: '/tmp/in.mp4',
    outputPath: '/tmp/out.mp4',
    keep: [{ start: 2, duration: 3 }],
    mainHasAudio: true,
    width: 1280,
    height: 720,
  }

  it('ohne Schalter kein loudnorm', () => {
    const args = buildMergeArgs({
      ...base,
      appends: [{ path: '/tmp/b.mp4', duration: 4, hasAudio: true }],
    })
    expect(args[args.indexOf('-filter_complex') + 1]).not.toContain('loudnorm')
  })

  it('mit Schalter loudnorm je Clip mit Ton, vor dem Resampling auf 48 kHz', () => {
    const args = buildMergeArgs({
      ...base,
      appends: [
        { path: '/tmp/b.mp4', duration: 4, hasAudio: true },
        { path: '/tmp/stumm.mp4', duration: 2, hasAudio: false },
      ],
      normalizeAudio: true,
    })
    const filter = args[args.indexOf('-filter_complex') + 1]
    expect(filter.match(/loudnorm=/g)).toHaveLength(2)
    expect(filter).toContain(`[0:a]${LOUDNORM_FILTER},aresample=48000`)
    expect(filter).toContain(`[1:a]${LOUDNORM_FILTER},aresample=48000`)
    // Stille wird nicht normalisiert.
    expect(filter).toContain('anullsrc=r=48000:cl=stereo:d=2.000,aresample=48000')
  })

  it('parseNormalizeAudio', () => {
    expect(parseNormalizeAudio({})).toBe(false)
    expect(parseNormalizeAudio({ normalizeAudio: '1' })).toBe(true)
    expect(parseNormalizeAudio({ normalizeAudio: 'true' })).toBe(true)
    expect(parseNormalizeAudio({ normalizeAudio: '0' })).toBe(false)
  })
})

describe('Ausgabeformat (Seitenverhältnis + Füllmodus)', () => {
  const base = {
    inputPath: '/tmp/in.mp4',
    outputPath: '/tmp/out.mp4',
    keep: [{ start: 2, duration: 3 }],
    mainHasAudio: true,
    width: 1080,
    height: 1920,
    appends: [],
  }
  const filterOf = (args: string[]) => args[args.indexOf('-filter_complex') + 1]

  it('outputTargetSize behält die kurze Kante', () => {
    const hd = { width: 1920, height: 1080 }
    expect(outputTargetSize(hd, 'auto')).toEqual({ width: 1920, height: 1080 })
    expect(outputTargetSize(hd, '16:9')).toEqual({ width: 1920, height: 1080 })
    expect(outputTargetSize(hd, '9:16')).toEqual({ width: 1080, height: 1920 })
    expect(outputTargetSize(hd, '1:1')).toEqual({ width: 1080, height: 1080 })
    // Ungerade/kleine Quellen -> gerade Pixelzahlen.
    expect(outputTargetSize({ width: 641, height: 361 }, '9:16')).toEqual({
      width: 360,
      height: 640,
    })
  })

  it("'pad' (Standard) = schwarze Balken wie bisher", () => {
    const f = filterOf(buildMergeArgs(base))
    expect(f).toContain('scale=1080:1920:force_original_aspect_ratio=decrease')
    expect(f).toContain('pad=1080:1920:(ow-iw)/2:(oh-ih)/2')
  })

  it("'crop' füllt und schneidet den Überstand ab", () => {
    const f = filterOf(buildMergeArgs({ ...base, fill: 'crop' }))
    expect(f).toContain('[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,')
    expect(f).not.toContain('pad=')
  })

  it("'blur' legt das Bild auf einen unscharfen Hintergrund", () => {
    const f = filterOf(buildMergeArgs({ ...base, fill: 'blur' }))
    expect(f).toContain('[0:v]split=2[v0b][v0f];')
    expect(f).toContain(
      '[v0b]scale=134:240:force_original_aspect_ratio=increase,crop=134:240,gblur',
    )
    expect(f).toContain('scale=1080:1920,setsar=1[v0bb]')
    expect(f).toContain('[v0bb][v0ff]overlay=(W-w)/2:(H-h)/2,setsar=1,fps=30')
    expect(f).toContain('concat=n=1:v=1:a=1[outv][outa]')
  })

  it("'blur' mit Crop: Zuschnitt vor dem split", () => {
    const f = filterOf(
      buildMergeArgs({ ...base, fill: 'blur', crop: { x: 0, y: 0, width: 0.5, height: 1 } }),
    )
    expect(f).toMatch(/\[0:v\]crop=[^;]*,split=2\[v0b\]\[v0f\]/)
  })

  it('parseOutputFormat: Standard, gültige und ungültige Werte', () => {
    expect(parseOutputFormat({})).toEqual({ aspect: 'auto', fill: 'pad' })
    expect(parseOutputFormat({ outputAspect: '9:16', outputFill: 'blur' })).toEqual({
      aspect: '9:16',
      fill: 'blur',
    })
    expect(() => parseOutputFormat({ outputAspect: '4:3' })).toThrow(ValidationError)
    expect(() => parseOutputFormat({ outputFill: 'stretch' })).toThrow(ValidationError)
  })
})

describe('Hintergrundmusik', () => {
  const base = {
    inputPath: '/tmp/in.mp4',
    outputPath: '/tmp/out.mp4',
    keep: [{ start: 2, duration: 3 }],
    mainHasAudio: true,
    width: 1280,
    height: 720,
    appends: [{ path: '/tmp/b.mp4', duration: 5, hasAudio: true }],
  }
  const music = { path: '/tmp/m.mp3', volume: 0.3, originalVolume: 1, fade: true, loop: true }
  const filterOf = (args: string[]) => args[args.indexOf('-filter_complex') + 1]

  it('Musik als letzter Input (mit Endlosschleife) und Mischung in [outa]', () => {
    const args = buildMergeArgs({ ...base, music })
    const i = args.indexOf('/tmp/m.mp3')
    expect(args.slice(i - 3, i + 1)).toEqual(['-stream_loop', '-1', '-i', '/tmp/m.mp3'])
    // Musik kommt nach allen Clip-Inputs, vor dem Filtergraph.
    expect(i).toBeLessThan(args.indexOf('-filter_complex'))
    const f = filterOf(args)
    expect(f).toContain('concat=n=2:v=1:a=1[outv][amain]')
    expect(f).toContain('[2:a]aresample=48000')
    expect(f).toContain('volume=0.300,atrim=0:8.000')
    expect(f).toContain('afade=t=in:st=0:d=2.000')
    expect(f).toContain('afade=t=out:st=6.000:d=2.000')
    expect(f).toContain('[amain]volume=1.000[aorig]')
    expect(f).toMatch(
      /\[aorig\]\[mus\]amix=inputs=2:duration=first:dropout_transition=0,volume=2\[outa\]$/,
    )
    expect(args.slice(args.indexOf('-map'), args.indexOf('-map') + 4)).toEqual([
      '-map',
      '[outv]',
      '-map',
      '[outa]',
    ])
  })

  it('ohne Wiederholen/Fades; mit xfade endet die Kette ebenfalls in [amain]', () => {
    const args = buildMergeArgs({
      ...base,
      music: { ...music, loop: false, fade: false },
      transition: { preset: 'slide', duration: 2 },
    })
    expect(args).not.toContain('-stream_loop')
    const f = filterOf(args)
    expect(f).not.toContain('afade=')
    expect(f).toContain('acrossfade=d=1.000:c1=tri:c2=tri[amain]')
    // Gesamtlänge = 3 + 5 - 1 (Überlappung).
    expect(f).toContain('atrim=0:7.000')
  })

  it('ohne Musik unverändert [outa] aus concat', () => {
    const f = filterOf(buildMergeArgs(base))
    expect(f).toContain('concat=n=2:v=1:a=1[outv][outa]')
    expect(f).not.toContain('amix')
  })

  it('musicMixFilter begrenzt Lautstärken und Fade-Länge', () => {
    const f = musicMixFilter({ ...music, volume: 5, originalVolume: -1 }, 3, 'x', 4)
    expect(f).toContain('volume=1.000,atrim=0:4.000')
    expect(f).toContain('[x]volume=0.000[aorig]')
    expect(f).toContain('afade=t=in:st=0:d=1.000')
    expect(f).toContain('afade=t=out:st=3.000:d=1.000')
  })

  it('parseMusicParams: Standardwerte, Werte, Fehler', () => {
    expect(parseMusicParams({})).toEqual({ volume: 0.3, originalVolume: 1, fade: true, loop: true })
    expect(
      parseMusicParams({
        musicVolume: '0.5',
        musicOriginalVolume: '0',
        musicFade: '0',
        musicLoop: 'false',
      }),
    ).toEqual({ volume: 0.5, originalVolume: 0, fade: false, loop: false })
    expect(() => parseMusicParams({ musicVolume: '2' })).toThrow(ValidationError)
    expect(() => parseMusicParams({ musicOriginalVolume: 'x' })).toThrow(ValidationError)
  })
})

describe('Übergang je Nahtstelle', () => {
  const base = {
    inputPath: '/tmp/in.mp4',
    outputPath: '/tmp/out.mp4',
    keep: [{ start: 0, duration: 4 }],
    mainHasAudio: true,
    width: 1280,
    height: 720,
    appends: [
      { path: '/tmp/b.mp4', duration: 4, hasAudio: true },
      { path: '/tmp/c.mp4', duration: 4, hasAudio: true },
      { path: '/tmp/d.mp4', duration: 4, hasAudio: true },
    ],
  }
  const filterOf = (args: string[]) => args[args.indexOf('-filter_complex') + 1]
  const ranges = [4, 4, 4, 4].map((duration) => ({ start: 0, duration }))

  it('resolveSeams: null = global, gemeinsame Dauer d, alles „none" -> d = 0', () => {
    expect(resolveSeams(ranges, [null, 'slide', 'none'], { preset: 'fade', duration: 2 })).toEqual({
      presets: ['fade', 'slide', 'none'],
      d: 1,
    })
    expect(resolveSeams(ranges, [null, null, null], undefined)).toEqual({
      presets: ['none', 'none', 'none'],
      d: 0,
    })
  })

  it('gemischte Kette: Dip, xfade, harter Schnitt mit korrekten Offsets', () => {
    const f = filterOf(
      buildMergeArgs({
        ...base,
        transition: { preset: 'none', duration: 2 },
        seams: ['fade', 'slide', 'none'],
      }),
    )
    // Nahtstelle 1 (Dip): Clip 0 blendet aus, Clip 1 blendet ein.
    expect(f).toMatch(/\[v0\];/)
    expect(f).toContain('fade=t=out:st=3.000:d=1.000')
    expect(f).toContain('[v0][a0][v1][a1]concat=n=2:v=1:a=1[vs1c][as1];[vs1c]settb=1/30[vs1]')
    // Nahtstelle 2 (xfade): bisherige Länge 8 s -> Offset 7 s.
    expect(f).toContain('[vs1][v2]xfade=transition=slideleft:duration=1.000:offset=7.000[vs2]')
    expect(f).toContain('[as1][a2]acrossfade=d=1.000:c1=tri:c2=tri[as2]')
    // Nahtstelle 3 (harter Schnitt) als letzter Schritt.
    expect(f).toContain('[vs2][as2][v3][a3]concat=n=2:v=1:a=1[outvc][outa];[outvc]settb=1/30[outv]')
    // Clip 2 bekommt keine Dip-Blenden.
    expect(f).not.toMatch(/\[2:v\][^;]*fade=t=/)
    expect(
      mergeOutputDuration(ranges, { preset: 'none', duration: 2 }, ['fade', 'slide', 'none']),
    ).toBe(15)
  })

  it('ohne seams bleibt der globale Pfad unverändert', () => {
    const f = filterOf(buildMergeArgs({ ...base, transition: { preset: 'slide', duration: 2 } }))
    expect(f).toContain('xfade=transition=slideleft:duration=1.000:offset=3.000[vx1]')
    expect(f).not.toContain('[vs1]')
  })

  it('falsche Anzahl wirft', () => {
    expect(() => buildMergeArgs({ ...base, seams: ['fade'] })).toThrow()
  })

  it('Musik nutzt die Dauer mit Übergängen je Nahtstelle', () => {
    const f = filterOf(
      buildMergeArgs({
        ...base,
        transition: { preset: 'none', duration: 2 },
        seams: ['slide', 'slide', 'none'],
        music: { path: '/tmp/m.mp3', volume: 0.3, originalVolume: 1, fade: false, loop: false },
      }),
    )
    expect(f).toContain('atrim=0:14.000')
    expect(f).toContain('concat=n=2:v=1:a=1[outvc][amain]')
  })

  it('parseSeamTransitions', () => {
    expect(parseSeamTransitions({})).toBeUndefined()
    expect(
      parseSeamTransitions({ seamTransitions: '[null,"slide","none"]', transitionDuration: '4' }),
    ).toEqual({ seams: [null, 'slide', 'none'], duration: 4 })
    expect(parseSeamTransitions({ seamTransitions: '[]' })).toEqual({ seams: [], duration: 1 })
    expect(() => parseSeamTransitions({ seamTransitions: '["wobble"]' })).toThrow(ValidationError)
    expect(() => parseSeamTransitions({ seamTransitions: '{}' })).toThrow(ValidationError)
    expect(() => parseSeamTransitions({ seamTransitions: 'x' })).toThrow(ValidationError)
  })
})

describe('Vorschau des Zusammenfügens', () => {
  const base = {
    inputPath: '/tmp/in.webm',
    outputPath: '/tmp/out.mp4',
    keep: [{ start: 0, duration: 3 }],
    mainHasAudio: true,
    appends: [{ path: '/tmp/b.mp4', duration: 4, hasAudio: true }],
    width: 640,
    height: 360,
  }

  it('previewTargetSize verkleinert auf höchstens 640 px (Seitenverhältnis bleibt)', () => {
    expect(previewTargetSize({ width: 1920, height: 1080 })).toEqual({ width: 640, height: 360 })
    expect(previewTargetSize({ width: 1080, height: 1920 })).toEqual({ width: 360, height: 640 })
    expect(previewTargetSize({ width: 1080, height: 1080 })).toEqual({ width: 640, height: 640 })
    // Kleiner als die Grenze: nie hochskalieren.
    expect(previewTargetSize({ width: 480, height: 270 })).toEqual({ width: 480, height: 270 })
  })

  it('preview nutzt H.264 ultrafast, sonst unveränderte Codecs', () => {
    const fast = buildMergeArgs({ ...base, preview: true })
    expect(fast.slice(fast.indexOf('-c:v'), -1)).toEqual(PREVIEW_CODECS)
    expect(fast.at(-1)).toBe('/tmp/out.mp4')
    const normal = buildMergeArgs(base)
    expect(normal).toContain('veryfast')
    expect(normal).not.toContain('ultrafast')
    // Filtergraph ist identisch – die Vorschau zeigt genau dasselbe Ergebnis.
    const f = (a: string[]) => a[a.indexOf('-filter_complex') + 1]
    expect(f(fast)).toBe(f(normal))
  })
})
