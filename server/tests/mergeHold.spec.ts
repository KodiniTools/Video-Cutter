import { describe, expect, it } from 'vitest'
import { buildMergeArgs, clipSpan } from '../src/lib/args'
import { parseAppendMeta, parseMainHold } from '../src/lib/validate'

const base = {
  inputPath: '/tmp/in.mp4',
  outputPath: '/tmp/out.mp4',
  keep: [{ start: 0, duration: 5 }],
  mainHasAudio: false,
  width: 1280,
  height: 720,
}
const filterOf = (args: string[]) => args[args.indexOf('-filter_complex') + 1]

describe('Standbild am Clip-Ende (Lücke im Gesamtvideo)', () => {
  it('clipSpan addiert das Standbild', () => {
    expect(clipSpan(5)).toBe(5)
    expect(clipSpan(5, 1.5)).toBe(6.5)
    expect(clipSpan(5, 0)).toBe(5)
  })

  it('Hauptvideo hält das letzte Bild; Stille in voller Länge; -t bleibt die Clip-Länge', () => {
    const args = buildMergeArgs({
      ...base,
      mainHold: 1,
      appends: [{ path: '/tmp/b.mp4', duration: 4, hasAudio: true }],
    })
    expect(args.slice(args.indexOf('-t'), args.indexOf('-t') + 2)).toEqual(['-t', '00:00:05.000'])
    const f = filterOf(args)
    expect(f).toContain('setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=1.000[v0]')
    expect(f).toContain('anullsrc=r=48000:cl=stereo:d=6.000')
    expect(f).not.toContain('apad')
  })

  it('angehängtes Video mit Ton: tpad + apad; Überblendung rechnet mit der verlängerten Länge', () => {
    const f = filterOf(
      buildMergeArgs({
        ...base,
        appends: [
          { path: '/tmp/b.mp4', duration: 4, hasAudio: true, hold: 2 },
          { path: '/tmp/c.mp4', duration: 4, hasAudio: true },
        ],
        transition: { preset: 'slide', duration: 2 },
      }),
    )
    expect(f).toContain('tpad=stop_mode=clone:stop_duration=2.000')
    expect(f).toContain('apad=pad_dur=2.000')
    // Clip 1 (5 s) + Clip 2 (4 s + 2 s Standbild): zweites xfade bei 5 + 6 − 2·1 = 9 s.
    expect(f).toContain('offset=9.000')
  })

  it('ohne Standbild unverändert (kein tpad/apad)', () => {
    const f = filterOf(
      buildMergeArgs({ ...base, appends: [{ path: '/tmp/b.mp4', duration: 4, hasAudio: true }] }),
    )
    expect(f).not.toContain('tpad')
    expect(f).not.toContain('apad')
  })

  it('parseAppendMeta/parseMainHold lesen und prüfen das Standbild', () => {
    expect(parseAppendMeta({ appendMeta: '[{"start":1,"hold":1.5}]' }, 1)).toEqual([
      { start: 1, duration: undefined, position: 'after', hold: 1.5 },
    ])
    expect(parseAppendMeta({ appendMeta: '[{"hold":0}]' }, 1)[0].hold).toBeUndefined()
    expect(() => parseAppendMeta({ appendMeta: '[{"hold":-1}]' }, 1)).toThrow()
    expect(() => parseAppendMeta({ appendMeta: '[{"hold":"x"}]' }, 1)).toThrow()
    expect(parseMainHold({})).toBe(0)
    expect(parseMainHold({ mainHold: '2.5' })).toBe(2.5)
    expect(() => parseMainHold({ mainHold: '9999' })).toThrow()
  })
})
