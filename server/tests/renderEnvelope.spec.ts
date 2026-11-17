import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { buildRenderArgs, compileTimeline, envelopeFilter } from '../src/lib/render/compile'
import { parseTimelineDoc, type RenderDoc } from '../src/lib/render/doc'

const s = (seconds: number) => Math.round(seconds * 1_000_000)
const point = (at: number, gain: number) => ({ at: s(at), gain })
/** Voll bis 1 s, bis 2 s auf ein Viertel, ab 4 s bis 5 s wieder voll. */
const DIP = [point(1, 1), point(2, 0.25), point(4, 0.25), point(5, 1)]

function rawDoc(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 2,
    settings: { width: 320, height: 180, fps: 25, background: '#000000', sampleRate: 48000 },
    assets: { tone: { id: 'tone', kind: 'audio', duration: s(6) } },
    tracks: [
      {
        id: 'A1',
        kind: 'audio',
        muted: false,
        solo: false,
        volume: 1,
        clips: [
          {
            id: 'a',
            kind: 'audio',
            asset: 'tone',
            start: 0,
            duration: s(6),
            sourceIn: 0,
            speed: 1,
            gain: 1,
            ...over,
          },
        ],
      },
    ],
  }
}
function parsed(raw: unknown): RenderDoc {
  const r = parseTimelineDoc(raw)
  if (!r.ok) throw new Error(JSON.stringify(r.errors))
  return r.doc
}
const sources = { tone: { path: '/m/tone.wav', hasAudio: true } }

describe('Lautstärke-Kurve: Prüfung und Filter', () => {
  it('nimmt aufsteigende Punkte an; leer und fehlend bedeuten keine Kurve', () => {
    expect(parsed(rawDoc({ envelope: DIP })).tracks[0].clips[0]).toMatchObject({ envelope: DIP })
    expect(parsed(rawDoc({ envelope: [] })).tracks[0].clips[0]).toMatchObject({ envelope: null })
    expect(parsed(rawDoc()).tracks[0].clips[0]).toMatchObject({ envelope: null })
    const bad: unknown[] = [
      'laut',
      [point(2, 1), point(1, 1)],
      [point(1, 1), point(1, 0.5)],
      [point(1, 2.5)],
      [point(1, -0.1)],
      [{ at: 0.5, gain: 1 }],
      Array.from({ length: 33 }, (_, i) => point(i, 1)),
    ]
    for (const envelope of bad) {
      const r = parseTimelineDoc(rawDoc({ envelope }))
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.errors[0].path).toBe('tracks[0].clips[0].envelope')
    }
  })

  it('baut einen stückweise linearen Ausdruck in Quellzeit', () => {
    expect(envelopeFilter([], 0)).toEqual([])
    expect(envelopeFilter([point(1, 0.5)], 0)).toEqual([
      "volume='if(lt((t+0),1),0.5,0.5)':eval=frame",
    ])
    expect(envelopeFilter([point(1, 1), point(3, 0)], 2.5)).toEqual([
      "volume='if(lt((t+2.5),1),1,if(lt((t+2.5),3),1+(-0.5)*((t+2.5)-1),0))':eval=frame",
    ])
    const plain = compileTimeline(parsed(rawDoc()), { sources })
    expect(plain.filter).not.toContain('eval=frame')
    const c = compileTimeline(parsed(rawDoc({ envelope: DIP })), { sources })
    expect(c.filter).toMatch(/asetpts=PTS-STARTPTS,volume='if\(lt\(\(t\+0\),1\),1,/)
  })
})

describe('Lautstärke-Kurve mit echtem FFmpeg', () => {
  let dir = ''
  let real: typeof sources = sources
  /** Pegel in dB für 0,2 s ab `at`. */
  const level = (file: string, at: number): number => {
    const r = spawnSync(
      'ffmpeg',
      [
        ...['-hide_banner', '-ss', String(at), '-t', '0.2', '-i', file],
        ...['-af', 'volumedetect', '-vn', '-f', 'null', '-'],
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

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'vc-env-'))
    const file = path.join(dir, 'tone.wav')
    execFileSync('ffmpeg', [
      ...['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=440:d=6:r=48000,volume=2'],
      file,
    ])
    real = { tone: { path: file, hasAudio: true } }
  })
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it('folgt den Punkten: voll, Rampe, ein Viertel, wieder voll', () => {
    const plain = render(parsed(rawDoc()), 'plain.mp4')
    const out = render(parsed(rawDoc({ envelope: DIP })), 'dip.mp4')
    const full = level(plain, 3)
    expect(Math.abs(level(out, 0.3) - full)).toBeLessThan(0.7)
    // Mitte der Rampe: Faktor 0,625 = −4,1 dB
    expect(full - level(out, 1.4)).toBeGreaterThan(3)
    expect(full - level(out, 1.4)).toBeLessThan(5.5)
    // Faktor 0,25 = −12 dB
    expect(Math.abs(full - level(out, 3) - 12)).toBeLessThan(1)
    expect(Math.abs(level(out, 5.5) - full)).toBeLessThan(0.7)
  })

  it('hängt an der Quelle: getrimmter Anfang, Tempo und Vorschau-Abschnitt', () => {
    const plain = render(parsed(rawDoc()), 'plain2.mp4')
    const full = level(plain, 3)
    // Clip beginnt bei 2,5 s der Quelle: sofort ein Viertel.
    const trimmed = render(
      parsed(rawDoc({ envelope: DIP, sourceIn: s(2.5), duration: s(3) })),
      'trim.mp4',
    )
    expect(Math.abs(full - level(trimmed, 0.2) - 12)).toBeLessThan(1)
    expect(Math.abs(level(trimmed, 2.7) - full)).toBeLessThan(0.7)
    // Doppeltes Tempo: Quelle 3 s liegt bei 1,5 s.
    const fast = render(parsed(rawDoc({ envelope: DIP, speed: 2, duration: s(3) })), 'fast.mp4')
    expect(Math.abs(level(fast, 0.1) - full)).toBeLessThan(0.7)
    expect(Math.abs(full - level(fast, 1.4) - 12)).toBeLessThan(1)
    expect(Math.abs(level(fast, 2.7) - full)).toBeLessThan(0.7)
    // Vorschau-Abschnitt mitten im leisen Teil.
    const part = render(parsed(rawDoc({ envelope: DIP })), 'part.mp4', {
      start: s(2.6),
      end: s(3.6),
    })
    expect(Math.abs(full - level(part, 0.1) - 12)).toBeLessThan(1)
  })
})
