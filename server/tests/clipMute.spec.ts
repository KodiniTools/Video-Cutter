import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildMergeArgs, buildServerArgs, buildSpeedArgs, stripAudioArgs } from '../src/lib/args'
import { parseAppendMeta, parseMute } from '../src/lib/validate'

describe('Stumm: Eingaben', () => {
  it('parseMute: nur 1/true', () => {
    expect(parseMute({ mute: '1' })).toBe(true)
    expect(parseMute({ mute: 'true' })).toBe(true)
    expect(parseMute({ mute: '0' })).toBe(false)
    expect(parseMute({})).toBe(false)
  })

  it('appendMeta: mute nur bei true, sonst fehlt das Feld', () => {
    const meta = parseAppendMeta(
      { appendMeta: JSON.stringify([{ mute: true }, { mute: false }, {}]) },
      3,
    )
    expect(meta.map((m) => m.mute)).toEqual([true, undefined, undefined])
  })
})

describe('Stumm: Argumente', () => {
  it('ein Bereich, kopieren: -an vor der Ausgabe, sonst unverändert', () => {
    const args = buildServerArgs({
      inputPath: '/tmp/in.mp4',
      outputPath: '/tmp/out.mp4',
      mode: 'copy',
      segments: [{ start: 1, duration: 2 }],
    })
    const muted = stripAudioArgs(args)
    expect(muted.slice(0, -2)).toEqual(args.slice(0, -1))
    expect(muted.slice(-2)).toEqual(['-an', '/tmp/out.mp4'])
  })

  it('mehrere Bereiche: [outa] endet im anullsink und wird nicht gemappt', () => {
    const args = stripAudioArgs(
      buildServerArgs({
        inputPath: '/tmp/in.mp4',
        outputPath: '/tmp/out.mp4',
        mode: 'reencode',
        segments: [
          { start: 0, duration: 1 },
          { start: 2, duration: 1 },
        ],
        audioFade: { inDuration: 0.5, inCurve: 'tri', outDuration: 0, outCurve: 'tri' },
      }),
    )
    const f = args[args.indexOf('-filter_complex') + 1]
    expect(f.endsWith(';[outa]anullsink')).toBe(true)
    expect(args.join(' ')).not.toContain('-map [outa]')
    expect(args).toContain('-an')
  })

  it('Tempo-Pfad: -af fällt weg', () => {
    const args = stripAudioArgs(
      buildSpeedArgs({
        inputPath: '/tmp/in.mp4',
        outputPath: '/tmp/out.mp4',
        start: 0,
        duration: 4,
        speed: 2,
        hasAudio: true,
      }),
    )
    expect(args).not.toContain('-af')
    expect(args.at(-2)).toBe('-an')
  })
})

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0

/** Pegel der Tonspur (max_volume in dB) oder `null` ohne Tonspur. */
function maxVolume(file: string): number | null {
  const probe = spawnSync('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'a',
    '-show_entries',
    'stream=index',
    '-of',
    'csv=p=0',
    file,
  ])
  if (!probe.stdout.toString().trim()) return null
  const r = spawnSync('ffmpeg', [
    '-hide_banner',
    '-i',
    file,
    '-af',
    'volumedetect',
    '-f',
    'null',
    '-',
  ])
  const m = r.stderr.toString().match(/max_volume: (-?[\d.]+|-inf) dB/)
  if (!m) return null
  return m[1] === '-inf' ? -Infinity : Number(m[1])
}

function run(args: string[]): void {
  const r = spawnSync(
    'ffmpeg',
    args.filter((a) => a !== '-progress' && a !== 'pipe:1'),
  )
  if (r.status !== 0) throw new Error(r.stderr.toString().slice(-2000))
}

describe.skipIf(!hasFfmpeg)('Stumm mit echtem ffmpeg', () => {
  let dir = ''
  let loud = ''
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'mute-'))
    loud = path.join(dir, 'loud.mp4')
    run([
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=320x240:rate=25:duration=4',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=4',
      '-c:v',
      'libx264',
      '-c:a',
      'aac',
      '-shortest',
      loud,
    ])
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('Testvideo hat hörbaren Ton', () => {
    expect(maxVolume(loud)).toBeGreaterThan(-30)
  })

  it('Herunterladen (kopieren) und Schneiden mehrerer Bereiche: keine Tonspur', () => {
    const copy = path.join(dir, 'copy.mp4')
    run(
      stripAudioArgs(
        buildServerArgs({
          inputPath: loud,
          outputPath: copy,
          mode: 'copy',
          segments: [{ start: 0, duration: 4 }],
        }),
      ),
    )
    expect(maxVolume(copy)).toBeNull()

    const multi = path.join(dir, 'multi.mp4')
    run(
      stripAudioArgs(
        buildServerArgs({
          inputPath: loud,
          outputPath: multi,
          mode: 'reencode',
          segments: [
            { start: 0, duration: 1 },
            { start: 2, duration: 1 },
          ],
          transition: { preset: 'slide', duration: 0.5 },
        }),
      ),
    )
    expect(maxVolume(multi)).toBeNull()
  })

  it('Zusammenfügen: stummer Clip wird zu Stille, der andere bleibt hörbar', () => {
    const out = path.join(dir, 'merged.mp4')
    // Erster Clip stumm (mainHasAudio false = wie im Router bei mute), zweiter mit Ton.
    run(
      buildMergeArgs({
        inputPath: loud,
        outputPath: out,
        keep: [{ start: 0, duration: 2 }],
        mainHasAudio: false,
        appends: [{ path: loud, start: 0, duration: 2, hasAudio: true, speed: 2 }],
        width: 320,
        height: 240,
        transition: { preset: 'fade', duration: 0.5 },
      }),
    )
    const first = path.join(dir, 'first.mp4')
    run(['-y', '-i', out, '-t', '1.5', '-c', 'copy', first])
    expect(maxVolume(first)).toBeLessThan(-80) // Tonspur da, aber still
    expect(maxVolume(out)).toBeGreaterThan(-30)
  })
})
