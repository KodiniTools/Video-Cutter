import { describe, expect, it } from 'vitest'
import { buildChapters, chapterMetadata, FIRST_CHAPTER } from '../src/lib/render/chapters'
import { buildRenderArgs, type CompiledTimeline } from '../src/lib/render/compile'
import { MAX_MARKER_LABEL, MAX_MARKERS, parseMarkers } from '../src/lib/render/doc'
import { buildLosslessArgs } from '../src/lib/render/lossless'

const s = (seconds: number) => Math.round(seconds * 1_000_000)

describe('parseMarkers', () => {
  it('liest nachsichtig: sortiert, je Zeit nur einer, Ungültiges fällt weg', () => {
    expect(parseMarkers(undefined)).toEqual([])
    expect(parseMarkers('x')).toEqual([])
    expect(
      parseMarkers([
        { at: s(4), label: 'Zwei' },
        { at: s(1), label: '  Eins\n\tneu\u0007 ' },
        { at: s(4), label: 'doppelt' },
        { at: -5, label: 'negativ' },
        { at: 1.5, label: 'krumm' },
        { label: 'ohne Zeit' },
        null,
        { at: s(6) },
      ]),
    ).toEqual([
      { at: s(1), label: 'Eins neu' },
      { at: s(4), label: 'Zwei' },
      { at: s(6), label: '' },
    ])
  })

  it('begrenzt Anzahl und Länge', () => {
    const many = Array.from({ length: MAX_MARKERS + 20 }, (_, i) => ({ at: i, label: 'x' }))
    expect(parseMarkers(many)).toHaveLength(MAX_MARKERS)
    const long = parseMarkers([{ at: 0, label: 'a'.repeat(500) }])
    expect(long[0].label).toHaveLength(MAX_MARKER_LABEL)
  })
})

describe('buildChapters', () => {
  it('reicht jedes Kapitel bis zum nächsten Marker und setzt „Anfang“ davor', () => {
    expect(
      buildChapters(
        [
          { at: s(2), label: 'Mitte' },
          { at: s(5), label: '' },
        ],
        8,
      ),
    ).toEqual([
      { start: 0, end: 2000, title: FIRST_CHAPTER },
      { start: 2000, end: 5000, title: 'Mitte' },
      { start: 5000, end: 8000, title: 'Kapitel 3' },
    ])
  })

  it('ohne „Anfang“, wenn der erste Marker bei 0 liegt; Marker hinter dem Ende entfallen', () => {
    expect(
      buildChapters(
        [
          { at: 0, label: 'Start' },
          { at: s(3), label: 'Ende' },
          { at: s(3), label: 'genau am Ende' },
          { at: s(9), label: 'dahinter' },
        ],
        3,
      ),
    ).toEqual([{ start: 0, end: 3000, title: 'Start' }])
    expect(buildChapters([], 3)).toEqual([])
    expect(buildChapters([{ at: s(5), label: 'x' }], 3)).toEqual([])
  })
})

describe('chapterMetadata', () => {
  it('liefert null ohne Kapitel und maskiert Sonderzeichen', () => {
    expect(chapterMetadata([], 5)).toBeNull()
    expect(chapterMetadata([{ at: 0, label: 'a=b; c#d\\e' }], 5)).toBe(
      [
        ';FFMETADATA1',
        '[CHAPTER]',
        'TIMEBASE=1/1000',
        'START=0',
        'END=5000',
        'title=a\\=b\\; c\\#d\\\\e',
        '',
      ].join('\n'),
    )
  })
})

describe('FFmpeg-Argumente', () => {
  const compiled = {
    inputs: ['-i', '/a.mp4', '-loop', '1', '-i', '/b.png'],
    filter: 'x',
    fps: '25',
    duration: 4,
  } as unknown as CompiledTimeline
  const enc = { output: '/out.mp4', preset: 'medium', crf: 23 }

  it('hängt die Kapiteldatei als letzte Eingabe an', () => {
    const args = buildRenderArgs(compiled, { ...enc, chaptersPath: '/k.txt' } as never)
    const at = args.indexOf('/k.txt')
    expect(args.slice(at - 3, at + 3)).toEqual([
      '-f',
      'ffmetadata',
      '-i',
      '/k.txt',
      '-map_chapters',
      '2',
    ])
    expect(at).toBeLessThan(args.indexOf('-filter_complex'))
  })

  it('bleibt ohne Kapitel unverändert', () => {
    expect(buildRenderArgs(compiled, enc as never)).not.toContain('-map_chapters')
    const plan = { ok: true as const, asset: 'a', sourceIn: 0, duration: s(2), audio: true }
    expect(buildLosslessArgs('/a.mp4', '/o.mp4', plan)).not.toContain('-map_chapters')
    const withChapters = buildLosslessArgs('/a.mp4', '/o.mp4', plan, '/k.txt')
    expect(withChapters.join(' ')).toContain('-i /a.mp4 -f ffmetadata -i /k.txt -map_chapters 1')
  })
})
