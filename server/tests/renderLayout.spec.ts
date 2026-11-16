import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { buildRenderArgs, compileTimeline } from '../src/lib/render/compile'
import { parseTimelineDoc, type RenderDoc } from '../src/lib/render/doc'
import { checkLossless } from '../src/lib/render/lossless'

const s = (seconds: number) => Math.round(seconds * 1_000_000)

const clip = (id: string, asset: string, over: Record<string, unknown> = {}) => ({
  id,
  kind: 'video',
  asset,
  start: 0,
  duration: s(2),
  sourceIn: 0,
  speed: 1,
  ...over,
})

/** V2 (oben): blau mit `top`; V1 (unten): rot mit `bottom`. Ohne `top` nur V1. */
function rawDoc(
  top: Record<string, unknown> | null,
  bottom: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    version: 2,
    settings: { width: 640, height: 360, fps: 25, background: '#00ff00', sampleRate: 48000 },
    assets: {
      a: { id: 'a', kind: 'video', duration: s(4) },
      b: { id: 'b', kind: 'video', duration: s(4) },
    },
    tracks: [
      ...(top ? [{ id: 'V2', kind: 'video', hidden: false, clips: [clip('v2', 'b', top)] }] : []),
      { id: 'V1', kind: 'video', hidden: false, clips: [clip('v1', 'a', bottom)] },
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
const layout = (over: Record<string, number> = {}) => ({
  layout: { x: 0.5, y: 0.5, scale: 0.5, opacity: 1, ...over },
})

describe('Bild-in-Bild: Prüfung und Filter', () => {
  it('nimmt gültige Lagen an; volle Größe und Deckkraft entfällt', () => {
    expect(parsed(rawDoc(layout())).tracks[0].clips[0]).toMatchObject(layout())
    expect(parsed(rawDoc(layout({ scale: 1 }))).tracks[0].clips[0]).not.toHaveProperty('layout')
    expect(parsed(rawDoc({})).tracks[0].clips[0]).not.toHaveProperty('layout')
    for (const bad of [{ scale: 0.01 }, { scale: 1.5 }, { x: -0.1 }, { y: 2 }, { opacity: 1.1 }]) {
      const r = parseTimelineDoc(rawDoc(layout(bad)))
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.errors[0].path).toBe('tracks[0].clips[0].layout')
    }
    expect(parseTimelineDoc(rawDoc({ layout: 'klein' })).ok).toBe(false)
  })

  it('passt in den verkleinerten Rahmen ein und legt ihn um die Mitte, ganz im Bild', () => {
    const c = compileTimeline(parsed(rawDoc(layout({ x: 0.8, y: 0.25 }))), { sources })
    expect(c.filter).toContain('scale=320:180:force_original_aspect_ratio=decrease')
    expect(c.filter).toContain(
      "pad=640:360:'max(0,min(ow-iw,0.8*ow-iw/2))':'max(0,min(oh-ih,0.25*oh-ih/2))':color=black@0",
    )
    expect(c.filter).not.toContain('lut=a=')
    // Die untere Spur bleibt unverändert im vollen Format.
    expect(c.filter).toContain('scale=640:360:force_original_aspect_ratio=decrease')
    const half = compileTimeline(parsed(rawDoc(layout({ scale: 1, opacity: 0.5 }))), { sources })
    expect(half.filter).toContain('lut=a=val*0.5')
  })

  it('legt unter die unterste Spur den Hintergrund', () => {
    const plain = compileTimeline(parsed(rawDoc(null)), { sources })
    expect(plain.filter).not.toContain('color=c=0x00ff00')
    const small = compileTimeline(parsed(rawDoc(null, layout())), { sources })
    expect(small.filter).toContain('color=c=0x00ff00:s=640x360')
    expect(small.filter).toContain('overlay=format=auto')
  })

  it('schließt den verlustfreien Export aus', () => {
    const doc = parsed(rawDoc(null, layout()))
    const info = () => ({ width: 640, height: 360, hasAudio: false })
    expect(checkLossless(doc, info)).toEqual({ ok: false, reason: 'layout' })
    expect(checkLossless(parsed(rawDoc(null)), info).ok).toBe(true)
  })
})

describe('Bild-in-Bild mit echtem FFmpeg', () => {
  let dir = ''
  let real: Record<string, { path: string; hasAudio: boolean }> = {}
  const pixel = (file: string, x: number, y: number) => {
    const raw = execFileSync('ffmpeg', [
      ...['-v', 'error', '-i', file, '-frames:v', '1'],
      ...['-vf', `select=eq(n\\,10),crop=8:8:${x}:${y},scale=1:1`],
      ...['-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
    ])
    return [raw[0], raw[1], raw[2]]
  }
  const near = (rgb: number[], want: number[], tol = 45) =>
    rgb.every((v, i) => Math.abs(v - want[i]) <= tol)
  const render = (doc: RenderDoc, name: string) => {
    const out = path.join(dir, name)
    const c = compileTimeline(doc, { sources: real })
    execFileSync('ffmpeg', buildRenderArgs(c, { output: out, preset: 'ultrafast', crf: 16 }), {
      stdio: 'ignore',
    })
    return out
  }
  const RED = [255, 0, 0]
  const BLUE = [0, 0, 255]
  const GREEN = [0, 255, 0]

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'vc-layout-'))
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
  })
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it('kleines Bild unten rechts über dem vollen Bild der unteren Spur', () => {
    // Mitte (1, 1) liegt außerhalb: Das Bild rückt ganz ins Format.
    const out = render(parsed(rawDoc(layout({ x: 1, y: 1 }))), 'pip.mp4')
    expect(near(pixel(out, 480, 270), BLUE)).toBe(true)
    expect(near(pixel(out, 630, 350), BLUE)).toBe(true)
    expect(near(pixel(out, 300, 170), RED)).toBe(true)
    expect(near(pixel(out, 100, 100), RED)).toBe(true)
  })

  it('Deckkraft mischt mit der Spur darunter', () => {
    const out = render(parsed(rawDoc(layout({ scale: 1, opacity: 0.5 }))), 'half.mp4')
    expect(near(pixel(out, 320, 180), [128, 0, 128], 50)).toBe(true)
  })

  it('auf der untersten Spur steht das kleine Bild vor dem Hintergrund', () => {
    const out = render(parsed(rawDoc(null, layout())), 'solo.mp4')
    expect(near(pixel(out, 320, 180), RED)).toBe(true)
    expect(near(pixel(out, 40, 40), GREEN)).toBe(true)
    expect(near(pixel(out, 600, 320), GREEN)).toBe(true)
  })

  it('Übergang und Standbild eines verkleinerten Clips rendern', () => {
    const doc = parsed({
      ...rawDoc(null),
      tracks: [
        {
          id: 'V1',
          kind: 'video',
          hidden: false,
          clips: [
            clip('v1', 'a', { ...layout(), hold: true }),
            clip('v2', 'b', {
              ...layout({ x: 0, y: 0 }),
              start: s(3),
              transitionIn: { preset: 'slide', duration: s(1) },
            }),
          ],
        },
      ],
    })
    const out = render(doc, 'mix.mp4')
    const count = execFileSync('ffprobe', [
      ...['-v', 'error', '-select_streams', 'v:0', '-count_frames'],
      ...['-show_entries', 'stream=nb_read_frames', '-of', 'default=nw=1:nk=1', out],
    ])
    expect(count.toString().trim()).toBe('125')
  })
})
