import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { buildRenderArgs, compileTimeline } from '../src/lib/render/compile'
import { parseTimelineDoc, type RenderDoc } from '../src/lib/render/doc'

const s = (seconds: number) => Math.round(seconds * 1_000_000)

/** V1: rot (0–2 s), Lücke, blau (3–5 s). `first`/`second` ergänzen die Clips. */
function rawDoc(
  first: Record<string, unknown> = {},
  second: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    version: 2,
    settings: { width: 640, height: 360, fps: 25, background: '#00ff00', sampleRate: 48000 },
    assets: {
      a: { id: 'a', kind: 'video', duration: s(4) },
      b: { id: 'b', kind: 'video', duration: s(4) },
    },
    tracks: [
      {
        id: 'V1',
        kind: 'video',
        hidden: false,
        clips: [
          {
            id: 'v1',
            kind: 'video',
            asset: 'a',
            start: 0,
            duration: s(2),
            sourceIn: 0,
            speed: 1,
            ...first,
          },
          {
            id: 'v2',
            kind: 'video',
            asset: 'b',
            start: s(3),
            duration: s(2),
            sourceIn: 0,
            speed: 1,
            ...second,
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

const sources = {
  a: { path: '/m/a.mp4', hasAudio: false },
  b: { path: '/m/b.mp4', hasAudio: false },
}

describe('Standbild in der Lücke: Prüfung und Filter', () => {
  it('nimmt nur Wahr/Falsch an und lässt „aus“ weg', () => {
    expect(parsed(rawDoc({ hold: true })).tracks[0].clips[0]).toMatchObject({ hold: true })
    expect(parsed(rawDoc({ hold: false })).tracks[0].clips[0]).not.toHaveProperty('hold')
    const bad = parseTimelineDoc(rawDoc({ hold: 'ja' }))
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.errors[0].path).toBe('tracks[0].clips[0].hold')
  })

  it('füllt die Lücke mit dem letzten Bild statt mit dem Hintergrund', () => {
    const plain = compileTimeline(parsed(rawDoc()), { sources })
    expect(plain.filter).not.toContain('reverse')
    expect(plain.inputs.filter((x) => x === '-i')).toHaveLength(2)

    const held = compileTimeline(parsed(rawDoc({ hold: true })), { sources })
    expect(held.filter).toContain('reverse,trim=end_frame=1')
    expect(held.filter).toContain('trim=end_frame=25')
    expect(held.filter).not.toContain('color=c=0x00ff00')
    expect(held.inputs.filter((x) => x === '-i')).toHaveLength(3)
    expect(held.frames).toBe(125)
  })

  it('gilt auch für einen Abschnitt, der ganz in der Lücke liegt', () => {
    const range = { start: s(2.2), end: s(2.8) }
    const held = compileTimeline(parsed(rawDoc({ hold: true })), { sources, range })
    expect(held.frames).toBe(15)
    expect(held.filter).toContain('reverse,trim=end_frame=1')
    const plain = compileTimeline(parsed(rawDoc()), { sources, range })
    expect(plain.filter).toContain('color=c=0x00ff00')
    expect(plain.inputs).toEqual([])
  })

  it('wirkt nicht hinter dem letzten Clip', () => {
    const last = compileTimeline(parsed(rawDoc({}, { hold: true })), { sources })
    expect(last.filter).not.toContain('reverse')
    expect(last.frames).toBe(125)
  })

  it('Übergang des nächsten Clips: Blende am Ende des Standbilds, sonst über dem Standbild', () => {
    const fade = { transitionIn: { preset: 'fade', duration: s(1) } }
    const f = compileTimeline(parsed(rawDoc({ hold: true }, fade)), { sources })
    // Lücke 25 Bilder, die letzten 13 blenden aus.
    expect(f.filter).toContain('fade=t=out:st=0.480000:d=0.520000:color=0x00ff00')
    const slide = { transitionIn: { preset: 'slide', duration: s(1) } }
    const x = compileTimeline(parsed(rawDoc({ hold: true }, slide)), { sources })
    expect(x.filter.match(/reverse/g)).toHaveLength(2)
    // Ohne Halten kommt der Clip nach der Lücke aus dem Hintergrund.
    const bg = compileTimeline(parsed(rawDoc({}, slide)), { sources })
    expect(bg.filter).not.toContain('reverse')
  })
})

describe('Standbild in der Lücke mit echtem FFmpeg', () => {
  let dir = ''
  let real: Record<string, { path: string; hasAudio: boolean }> = {}
  const frames = (file: string) =>
    execFileSync('ffprobe', [
      ...['-v', 'error', '-select_streams', 'v:0', '-count_frames'],
      ...['-show_entries', 'stream=nb_read_frames', '-of', 'default=nw=1:nk=1', file],
    ])
      .toString()
      .trim()
  const pixel = (file: string, n: number, x: number, y: number) => {
    const raw = execFileSync('ffmpeg', [
      ...['-v', 'error', '-i', file, '-frames:v', '1'],
      ...['-vf', `select=eq(n\\,${n}),crop=8:8:${x}:${y},scale=1:1`],
      ...['-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
    ])
    return [raw[0], raw[1], raw[2]]
  }
  const near = (rgb: number[], want: number[], tol = 45) =>
    rgb.every((v, i) => Math.abs(v - want[i]) <= tol)
  const render = (doc: RenderDoc, name: string, range?: { start: number; end: number }) => {
    const out = path.join(dir, name)
    const c = compileTimeline(doc, { sources: real, range })
    execFileSync('ffmpeg', buildRenderArgs(c, { output: out, preset: 'ultrafast', crf: 16 }), {
      stdio: 'ignore',
    })
    return out
  }

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'vc-hold-'))
    for (const [name, color] of [
      ['a', 'red'],
      ['b', 'blue'],
    ]) {
      execFileSync('ffmpeg', [
        ...['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=640x360:r=25:d=4`],
        ...['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'],
        path.join(dir, `${name}.mp4`),
      ])
    }
    real = {
      a: { path: path.join(dir, 'a.mp4'), hasAudio: false },
      b: { path: path.join(dir, 'b.mp4'), hasAudio: false },
    }
  }, 60_000)
  afterAll(() => rm(dir, { recursive: true, force: true }))

  it('hält das letzte Bild bis zum nächsten Clip, auch im Abschnitt', () => {
    const plain = render(parsed(rawDoc()), 'plain.mp4')
    expect(near(pixel(plain, 60, 320, 180), [0, 255, 0])).toBe(true)

    const doc = parsed(rawDoc({ hold: true }))
    const out = render(doc, 'hold.mp4')
    expect(frames(out)).toBe('125')
    expect(near(pixel(out, 51, 320, 180), [255, 0, 0])).toBe(true)
    expect(near(pixel(out, 74, 320, 180), [255, 0, 0])).toBe(true)
    expect(near(pixel(out, 76, 320, 180), [0, 0, 255])).toBe(true)

    const part = render(doc, 'hold-part.mp4', { start: s(2.2), end: s(2.8) })
    expect(frames(part)).toBe('15')
    expect(near(pixel(part, 7, 320, 180), [255, 0, 0])).toBe(true)
  }, 120_000)

  it('blendet das Standbild aus, wenn der nächste Clip mit Blende beginnt', () => {
    const doc = parsed(rawDoc({ hold: true }, { transitionIn: { preset: 'fade', duration: s(1) } }))
    const out = render(doc, 'hold-fade.mp4')
    expect(frames(out)).toBe('125')
    expect(near(pixel(out, 55, 320, 180), [255, 0, 0])).toBe(true)
    expect(near(pixel(out, 74, 320, 180), [0, 255, 0], 60)).toBe(true)
    expect(near(pixel(out, 75, 320, 180), [0, 255, 0], 60)).toBe(true)
    expect(near(pixel(out, 100, 320, 180), [0, 0, 255])).toBe(true)
  }, 120_000)
})
