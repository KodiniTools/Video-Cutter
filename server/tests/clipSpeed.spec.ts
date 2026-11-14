import { describe, expect, it } from 'vitest'
import { atempoFilters, buildMergeArgs, clipSpeed, spedDuration } from '../src/lib/args'
import { parseAppendMeta, parseMainSpeed } from '../src/lib/validate'

const base = {
  inputPath: '/tmp/in.mp4',
  outputPath: '/tmp/out.mp4',
  keep: [{ start: 0, duration: 6 }],
  mainHasAudio: true,
  width: 1280,
  height: 720,
}
const filterOf = (args: string[]) => args[args.indexOf('-filter_complex') + 1]

describe('Geschwindigkeit je Clip beim Zusammenfügen', () => {
  it('clipSpeed/spedDuration', () => {
    expect(clipSpeed(undefined)).toBe(1)
    expect(clipSpeed(0)).toBe(1)
    expect(clipSpeed(10)).toBe(4)
    expect(spedDuration(6, 2)).toBe(3)
    expect(spedDuration(6, 0.5)).toBe(12)
    expect(spedDuration(6)).toBe(6)
  })

  it('atempo-Kette bleibt je Glied im Bereich 0,5–2', () => {
    expect(atempoFilters(1)).toEqual([])
    expect(atempoFilters(2)).toEqual(['atempo=2.000000'])
    expect(atempoFilters(3.5)).toEqual(['atempo=2', 'atempo=1.750000'])
    expect(atempoFilters(1 / 3.5)).toEqual(['atempo=0.5', 'atempo=0.571429'])
    expect(atempoFilters(0.25)).toEqual(['atempo=0.5', 'atempo=0.500000'])
  })

  it('ohne Tempo: Filter unverändert (kein setpts-Faktor, kein atempo)', () => {
    const f = filterOf(
      buildMergeArgs({ ...base, appends: [{ path: '/tmp/b.mp4', duration: 4, hasAudio: true }] }),
    )
    expect(f).not.toContain('atempo')
    expect(f).not.toContain('(PTS-STARTPTS)/')
  })

  it('Tempo: setpts vor fps, atempo am Ton, -t bleibt Quellmaterial, Überblendung mit neuer Länge', () => {
    const args = buildMergeArgs({
      ...base,
      mainSpeed: 2,
      appends: [
        { path: '/tmp/b.mp4', duration: 4, hasAudio: false, speed: 0.5 },
        { path: '/tmp/c.mp4', duration: 4, hasAudio: true },
      ],
      transition: { preset: 'slide', duration: 2 },
    })
    const ts = args.flatMap((a, i) => (a === '-t' ? [args[i + 1]] : []))
    expect(ts).toEqual(['00:00:06.000', '00:00:04.000', '00:00:04.000'])
    const f = filterOf(args)
    expect(f).toContain('[0:v]setpts=(PTS-STARTPTS)/2.000000,scale=')
    expect(f).toContain('[1:v]setpts=(PTS-STARTPTS)/0.500000,scale=')
    expect(f).toMatch(/\[2:v\]scale=/)
    expect(f).toContain('asetpts=PTS-STARTPTS,atempo=2.000000[a0]')
    // Clip 2 ohne Ton: Stille in der Länge im Ergebnis (4 s / 0,5 = 8 s)
    expect(f).toContain('anullsrc=r=48000:cl=stereo:d=8.000')
    // Längen 3 + 8 + 4, Überblendung 1 s: xfade bei 3−1 = 2 und 3+8−2 = 9
    expect(f).toContain('offset=2.000')
    expect(f).toContain('offset=9.000')
  })

  it('Tempo zusammen mit Standbild und Zuschnitt (Zuschnitt vor dem Tempo)', () => {
    const f = filterOf(
      buildMergeArgs({
        ...base,
        mainSpeed: 2,
        mainHold: 1,
        crop: { x: 0, y: 0, width: 0.5, height: 0.5 },
        appends: [{ path: '/tmp/b.mp4', duration: 4, hasAudio: true }],
      }),
    )
    expect(f).toMatch(/\[0:v\]crop=[^,]+,setpts=\(PTS-STARTPTS\)\/2\.000000,scale=/)
    expect(f).toContain('atempo=2.000000,apad=pad_dur=1.000')
  })

  it('parseAppendMeta/parseMainSpeed lesen und prüfen das Tempo', () => {
    expect(parseAppendMeta({ appendMeta: '[{"speed":2}]' }, 1)[0].speed).toBe(2)
    expect(parseAppendMeta({ appendMeta: '[{"speed":1}]' }, 1)[0].speed).toBeUndefined()
    expect(parseAppendMeta({ appendMeta: '[{}]' }, 1)[0].speed).toBeUndefined()
    expect(() => parseAppendMeta({ appendMeta: '[{"speed":5}]' }, 1)).toThrow()
    expect(() => parseAppendMeta({ appendMeta: '[{"speed":0}]' }, 1)).toThrow()
    expect(() => parseAppendMeta({ appendMeta: '[{"speed":"x"}]' }, 1)).toThrow()
    expect(parseMainSpeed({})).toBe(1)
    expect(parseMainSpeed({ mainSpeed: '0.285714' })).toBeCloseTo(0.285714)
    expect(() => parseMainSpeed({ mainSpeed: '0.2' })).toThrow()
  })
})
