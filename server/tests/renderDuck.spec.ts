import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { buildRenderArgs, compileTimeline } from '../src/lib/render/compile'
import { parseTimelineDoc, type RenderDoc } from '../src/lib/render/doc'

const s = (seconds: number) => Math.round(seconds * 1_000_000)

const audioClip = (id: string, asset: string, start: number, duration: number) => ({
  id,
  kind: 'audio',
  asset,
  start: s(start),
  duration: s(duration),
  sourceIn: 0,
  speed: 1,
  gain: 1,
})

/** Musik über 6 s, Sprache von 2 bis 4 s. */
function rawDoc(duck?: unknown, extra: unknown[] = []): Record<string, unknown> {
  return {
    version: 2,
    settings: { width: 320, height: 180, fps: 25, background: '#000000', sampleRate: 48000 },
    assets: {
      music: { id: 'music', kind: 'audio', duration: s(6) },
      voice: { id: 'voice', kind: 'audio', duration: s(6) },
    },
    tracks: [
      {
        id: 'A1',
        kind: 'audio',
        muted: false,
        solo: false,
        volume: 1,
        clips: [audioClip('v', 'voice', 2, 2)],
      },
      {
        id: 'A2',
        kind: 'audio',
        muted: false,
        solo: false,
        volume: 1,
        ...(duck === undefined ? {} : { duck }),
        clips: [audioClip('m', 'music', 0, 6)],
      },
      ...extra,
    ],
  }
}
function parsed(raw: unknown): RenderDoc {
  const r = parseTimelineDoc(raw)
  if (!r.ok) throw new Error(JSON.stringify(r.errors))
  return r.doc
}
const sources = {
  music: { path: '/m/music.wav', hasAudio: true },
  voice: { path: '/m/voice.wav', hasAudio: true },
}

describe('Automatisches Absenken: Prüfung und Filter', () => {
  it('nimmt 0 bis 1 an; 0 und fehlend bedeuten aus', () => {
    expect(parsed(rawDoc(0.7)).tracks[1]).toMatchObject({ duck: 0.7 })
    expect(parsed(rawDoc(0)).tracks[1]).not.toHaveProperty('duck')
    expect(parsed(rawDoc()).tracks[1]).not.toHaveProperty('duck')
    for (const bad of [1.5, -0.1, 'ja', Number.NaN]) {
      const r = parseTimelineDoc(rawDoc(bad))
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.errors[0].path).toBe('tracks[1].duck')
    }
  })

  it('setzt den Kompressor nur, wenn es eine steuernde Spur gibt', () => {
    expect(compileTimeline(parsed(rawDoc()), { sources }).filter).not.toContain('sidechaincompress')
    const c = compileTimeline(parsed(rawDoc(0.7)), { sources })
    expect(c.filter).toContain(
      'sidechaincompress=threshold=0.02:ratio=20:attack=20:release=600:mix=0.7',
    )
    // Stummgeschaltete Sprache steuert nicht.
    const muted = rawDoc(0.7)
    ;(muted.tracks as Array<Record<string, unknown>>)[0].muted = true
    expect(compileTimeline(parsed(muted), { sources }).filter).not.toContain('sidechaincompress')
    // Sind alle Spuren abgesenkt, fehlt das Steuersignal.
    const all = rawDoc(0.7)
    ;(all.tracks as Array<Record<string, unknown>>)[0].duck = 0.5
    expect(compileTimeline(parsed(all), { sources }).filter).not.toContain('sidechaincompress')
  })
})

describe('Automatisches Absenken mit echtem FFmpeg', () => {
  let dir = ''
  let real: typeof sources = sources
  /** Pegel der Musik (220 Hz) in dB für 0,3 s ab `at`. */
  const level = (file: string, at: number): number => {
    const r = spawnSync(
      'ffmpeg',
      [
        ...['-hide_banner', '-ss', String(at), '-t', '0.3', '-i', file],
        ...['-af', 'bandpass=f=220:width_type=h:w=60,volumedetect', '-vn', '-f', 'null', '-'],
      ],
      { encoding: 'utf8' },
    )
    const m = /mean_volume: (-?[\d.]+) dB/.exec(r.stderr)
    if (!m) throw new Error(r.stderr)
    return Number(m[1])
  }
  const render = (doc: RenderDoc, name: string, range?: { start: number; end: number }) => {
    const out = path.join(dir, name)
    const c = compileTimeline(doc, { sources: real, ...(range ? { range } : {}) })
    execFileSync('ffmpeg', buildRenderArgs(c, { output: out, preset: 'ultrafast', crf: 30 }), {
      stdio: 'ignore',
    })
    return out
  }
  const tone = (name: string, freq: number) => {
    const file = path.join(dir, name)
    execFileSync('ffmpeg', [
      ...['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=f=${freq}:d=6:r=48000,volume=3`],
      file,
    ])
    return file
  }

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'vc-duck-'))
    real = {
      music: { path: tone('music.wav', 220), hasAudio: true },
      voice: { path: tone('voice.wav', 1000), hasAudio: true },
    }
  })
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it('senkt die Musik nur während der Sprache ab', () => {
    const plain = render(parsed(rawDoc()), 'plain.mp4')
    const duck = render(parsed(rawDoc(0.7)), 'duck.mp4')
    const loud = level(plain, 3)
    expect(Math.abs(level(plain, 1) - loud)).toBeLessThan(1)
    expect(Math.abs(level(duck, 1) - loud)).toBeLessThan(1)
    expect(loud - level(duck, 3)).toBeGreaterThan(5)
    expect(Math.abs(level(duck, 5.2) - loud)).toBeLessThan(1)
    // Stärker eingestellt wird es leiser.
    const strong = render(parsed(rawDoc(1)), 'strong.mp4')
    expect(level(duck, 3) - level(strong, 3)).toBeGreaterThan(5)
  })

  it('ist in einem Vorschau-Abschnitt mitten in der Sprache sofort abgesenkt', () => {
    const whole = render(parsed(rawDoc(0.7)), 'whole.mp4')
    const part = render(parsed(rawDoc(0.7)), 'part.mp4', { start: s(2.6), end: s(3.6) })
    expect(Math.abs(level(part, 0) - level(whole, 2.6))).toBeLessThan(1.5)
    const r = spawnSync(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', part],
      { encoding: 'utf8' },
    )
    expect(Number(r.stdout)).toBeCloseTo(1, 1)
  })
})
