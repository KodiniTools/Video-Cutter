import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { buildRenderArgs, colorFilter, compileTimeline } from '../src/lib/render/compile'
import { parseTimelineDoc, type RenderDoc } from '../src/lib/render/doc'
import { checkLossless } from '../src/lib/render/lossless'

const s = (seconds: number) => Math.round(seconds * 1_000_000)

function rawDoc(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 2,
    settings: { width: 640, height: 360, fps: 25, background: '#000000', sampleRate: 48000 },
    assets: { a: { id: 'a', kind: 'video', duration: s(4) } },
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
const color = (over: Record<string, number> = {}) => ({
  color: { brightness: 0, contrast: 0, saturation: 0, ...over },
})
const sources = { a: { path: '/m/a.mp4', hasAudio: false } }

describe('Farbkorrektur: Prüfung und Filter', () => {
  it('nimmt Werte von −1 bis 1 an; alles auf 0 entfällt', () => {
    expect(parsed(rawDoc(color({ saturation: -1 }))).tracks[0].clips[0]).toMatchObject(
      color({ saturation: -1 }),
    )
    expect(parsed(rawDoc(color())).tracks[0].clips[0]).not.toHaveProperty('color')
    for (const bad of [{ brightness: 1.5 }, { contrast: -2 }, { saturation: Number.NaN }]) {
      const r = parseTimelineDoc(rawDoc(color(bad)))
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.errors[0].path).toBe('tracks[0].clips[0].color')
    }
    expect(parseTimelineDoc(rawDoc({ color: 'bunt' })).ok).toBe(false)
  })

  it('setzt den eq-Filter vor das Einpassen', () => {
    expect(colorFilter({ brightness: 0.5, contrast: -0.5, saturation: -1 })).toBe(
      'eq=brightness=0.2:contrast=0.7:saturation=0',
    )
    const plain = compileTimeline(parsed(rawDoc()), { sources })
    expect(plain.filter).not.toContain('eq=')
    const c = compileTimeline(parsed(rawDoc(color({ saturation: 1 }))), { sources })
    expect(c.filter).toContain('eq=brightness=0:contrast=1:saturation=2,scale=640:360')
  })

  it('schließt den verlustfreien Export aus', () => {
    const info = () => ({ width: 640, height: 360, hasAudio: false })
    expect(checkLossless(parsed(rawDoc(color({ contrast: 0.2 }))), info)).toEqual({
      ok: false,
      reason: 'color',
    })
  })
})

describe('Farbkorrektur mit echtem FFmpeg', () => {
  let dir = ''
  let real: Record<string, { path: string; hasAudio: boolean }> = {}
  const pixel = (file: string) => {
    const raw = execFileSync('ffmpeg', [
      ...['-v', 'error', '-i', file, '-frames:v', '1'],
      ...['-vf', 'select=eq(n\\,10),crop=8:8:320:180,scale=1:1'],
      ...['-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
    ])
    return [raw[0], raw[1], raw[2]]
  }
  const render = (doc: RenderDoc, name: string) => {
    const out = path.join(dir, name)
    const c = compileTimeline(doc, { sources: real })
    execFileSync('ffmpeg', buildRenderArgs(c, { output: out, preset: 'ultrafast', crf: 16 }), {
      stdio: 'ignore',
    })
    return out
  }

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'vc-color-'))
    execFileSync('ffmpeg', [
      ...['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0xb04020:s=640x360:r=25:d=4'],
      ...['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'],
      path.join(dir, 'a.mp4'),
    ])
    real = { a: { path: path.join(dir, 'a.mp4'), hasAudio: false } }
  })
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it('Sättigung −1 ergibt Grau, Helligkeit hebt alle Kanäle', () => {
    const base = pixel(render(parsed(rawDoc()), 'base.mp4'))
    expect(base[0] - base[2]).toBeGreaterThan(100)
    const grey = pixel(render(parsed(rawDoc(color({ saturation: -1 }))), 'grey.mp4'))
    expect(Math.max(...grey) - Math.min(...grey)).toBeLessThan(12)
    const bright = pixel(render(parsed(rawDoc(color({ brightness: 0.5 }))), 'bright.mp4'))
    expect(bright[1] - base[1]).toBeGreaterThan(25)
    expect(bright[2] - base[2]).toBeGreaterThan(25)
  })

  it('wirkt auch zusammen mit Bild-in-Bild', () => {
    const doc = parsed(
      rawDoc({ ...color({ saturation: -1 }), layout: { x: 0.5, y: 0.5, scale: 0.5, opacity: 1 } }),
    )
    const grey = pixel(render(doc, 'pip.mp4'))
    expect(Math.max(...grey) - Math.min(...grey)).toBeLessThan(12)
  })
})
