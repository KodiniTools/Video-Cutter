import { describe, it, expect } from 'vitest'
import {
  audioFadeFilters,
  audioFadeForcesReencode,
  buildMergeArgs,
  buildServerArgs,
  type AudioFade,
} from '../src/lib/args'
import { parseAudioFade, ValidationError } from '../src/lib/validate'

const fade: AudioFade = { inDuration: 2, inCurve: 'exp', outDuration: 3, outCurve: 'qsin' }
const filterOf = (args: string[]) => args[args.indexOf('-filter_complex') + 1]

describe('audioFadeFilters', () => {
  it('liefert afade-Filter mit Kurve, Ausblenden endet am Ende des Ergebnisses', () => {
    expect(audioFadeFilters(fade, 10)).toEqual([
      'afade=t=in:st=0:d=2.000:curve=exp',
      'afade=t=out:st=7.000:d=3.000:curve=qsin',
    ])
  })

  it('begrenzt jede Blende auf die halbe Länge', () => {
    expect(audioFadeFilters(fade, 4)).toEqual([
      'afade=t=in:st=0:d=2.000:curve=exp',
      'afade=t=out:st=2.000:d=2.000:curve=qsin',
    ])
  })

  it('lässt eine Seite mit Dauer 0 weg; nichts verlangt -> leer', () => {
    expect(audioFadeFilters({ ...fade, inDuration: 0 }, 10)).toEqual([
      'afade=t=out:st=7.000:d=3.000:curve=qsin',
    ])
    expect(audioFadeFilters(undefined, 10)).toEqual([])
    expect(audioFadeFilters(fade, 0)).toEqual([])
  })
})

describe('buildServerArgs mit Ton-Blende', () => {
  const base = { inputPath: '/in.mp4', outputPath: '/out.mp4' }

  it('ein Bereich + copy -> Re-Encode mit -af statt Stream-Copy', () => {
    const args = buildServerArgs({ ...base, start: 5, duration: 10, mode: 'copy', audioFade: fade })
    expect(args).not.toContain('copy')
    expect(args[args.indexOf('-af') + 1]).toBe(
      'afade=t=in:st=0:d=2.000:curve=exp,afade=t=out:st=7.000:d=3.000:curve=qsin',
    )
    expect(audioFadeForcesReencode(fade, [{ start: 5, duration: 10 }])).toBe(true)
  })

  it('ohne Blende bleibt der verlustfreie Weg unverändert', () => {
    const args = buildServerArgs({ ...base, start: 5, duration: 10, mode: 'copy' })
    expect(args).toContain('copy')
    expect(args).not.toContain('-af')
  })

  it('Zuschnitt + Blende -> -vf und -af', () => {
    const args = buildServerArgs({
      ...base,
      start: 0,
      duration: 10,
      mode: 'reencode',
      crop: { x: 0, y: 0, width: 0.5, height: 0.5 },
      audioFade: fade,
    })
    expect(args).toContain('-vf')
    expect(args).toContain('-af')
  })

  it('mehrere Bereiche (concat) -> Blende am Ausgang, Länge = Summe', () => {
    const args = buildServerArgs({
      ...base,
      mode: 'reencode',
      segments: [
        { start: 0, duration: 4 },
        { start: 10, duration: 6 },
      ],
      audioFade: fade,
    })
    const f = filterOf(args)
    expect(f).toContain('concat=n=2:v=1:a=1[outv][afpre];[afpre]afade=t=in')
    expect(f).toContain('afade=t=out:st=7.000:d=3.000:curve=qsin[outa]')
    expect(f.match(/\[outa\]/g)).toHaveLength(1)
  })

  it('xfade-Übergang -> Ausblenden berücksichtigt die Überlappung', () => {
    const args = buildServerArgs({
      ...base,
      mode: 'reencode',
      segments: [
        { start: 0, duration: 5 },
        { start: 10, duration: 5 },
      ],
      transition: { preset: 'slide', duration: 1 },
      audioFade: fade,
    })
    // 5 + 5 − 0,5 (xfade-Dauer = halbe Übergangsdauer) = 9,5 s
    expect(filterOf(args)).toContain('afade=t=out:st=6.500:d=3.000:curve=qsin[outa]')
  })
})

describe('buildMergeArgs mit Ton-Blende', () => {
  const base = {
    inputPath: '/in.mp4',
    outputPath: '/out.mp4',
    keep: [{ start: 0, duration: 4 }],
    mainHasAudio: true,
    appends: [{ path: '/b.mp4', duration: 6, hasAudio: true }],
    width: 1280,
    height: 720,
  }

  it('Blende über das Gesamtergebnis', () => {
    const f = filterOf(buildMergeArgs({ ...base, audioFade: fade }))
    expect(f).toContain('[outv][afpre];[afpre]afade=t=in:st=0:d=2.000:curve=exp')
    expect(f).toContain('afade=t=out:st=7.000:d=3.000:curve=qsin[outa]')
  })

  it('mit Musik: Blende NACH der Mischung (Musik wird mit ausgeblendet)', () => {
    const f = filterOf(
      buildMergeArgs({
        ...base,
        audioFade: fade,
        music: { path: '/m.mp3', volume: 0.3, originalVolume: 1, fade: false, loop: true },
      }),
    )
    expect(f).toMatch(/amix=.*volume=2\[afpre\];\[afpre\]afade=t=in/)
    expect(f.match(/\[outa\]/g)).toHaveLength(1)
  })

  it('ohne Blende unverändert', () => {
    expect(filterOf(buildMergeArgs(base))).not.toContain('afpre')
  })
})

describe('parseAudioFade', () => {
  it('nichts / Dauern 0 -> undefined', () => {
    expect(parseAudioFade({})).toBeUndefined()
    expect(parseAudioFade({ audioFadeIn: '0', audioFadeOut: '0' })).toBeUndefined()
  })

  it('liest Dauern und Kurven, Standardkurve linear', () => {
    expect(
      parseAudioFade({ audioFadeIn: '1.5', audioFadeOutCurve: 'log', audioFadeOut: '2' }),
    ).toEqual({
      inDuration: 1.5,
      inCurve: 'tri',
      outDuration: 2,
      outCurve: 'log',
    })
  })

  it('lehnt ungültige Werte ab', () => {
    expect(() => parseAudioFade({ audioFadeIn: '-1' })).toThrow(ValidationError)
    expect(() => parseAudioFade({ audioFadeIn: '31' })).toThrow(ValidationError)
    expect(() => parseAudioFade({ audioFadeIn: 'abc' })).toThrow(ValidationError)
    expect(() => parseAudioFade({ audioFadeIn: '1', audioFadeInCurve: 'evil;rm' })).toThrow(
      ValidationError,
    )
  })
})
