import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { buildRenderArgs, compileTimeline } from '../src/lib/render/compile'
import { parseTimelineDoc, type RenderDoc } from '../src/lib/render/doc'
import { effectEnvelope, markerEffectFilters } from '../src/lib/render/effects'

const s = (seconds: number) => Math.round(seconds * 1_000_000)

function rawDoc(markers: unknown[]): Record<string, unknown> {
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
          { id: 'v1', kind: 'video', asset: 'a', start: 0, duration: s(4), sourceIn: 0, speed: 1 },
        ],
      },
    ],
    markers,
  }
}
function parsed(raw: unknown): RenderDoc {
  const r = parseTimelineDoc(raw)
  if (!r.ok) throw new Error(JSON.stringify(r.errors))
  return r.doc
}
const effect = (over: Record<string, unknown> = {}) => ({
  kind: 'flash',
  color: '#FFFFFF',
  intensity: 1,
  duration: s(0.4),
  ...over,
})
const sources = { a: { path: '/m/a.mp4', hasAudio: false } }

describe('Drop-Effekte: Prüfung und Filter', () => {
  it('liest gültige Effekte, Ungültiges fällt still weg', () => {
    const doc = parsed(
      rawDoc([
        { id: 'm1', at: s(1), label: 'Drop', effect: effect() },
        { id: 'm2', at: s(2), label: '', effect: effect({ kind: 'laser' }) },
        { id: 'm3', at: s(2.5), label: '', effect: effect({ intensity: 2 }) },
        { id: 'm4', at: s(3), label: '', effect: effect({ kind: 'strobe', rate: 50 }) },
        { id: 'm5', at: s(3.5), label: 'ohne' },
      ]),
    )
    expect(doc.effects).toEqual([
      { at: s(1), kind: 'flash', color: '#ffffff', intensity: 1, duration: s(0.4), rate: 8 },
    ])
    // Kapitel bleiben unberührt.
    expect(doc.markers.map((m) => m.label)).toEqual(['Drop', '', '', '', 'ohne'])
  })

  it('Hüllkurven: Blitz klingt ab, Farbblitz steigt erst, Vignette pulsiert', () => {
    expect(effectEnvelope('flash', 0)).toBe(1)
    expect(effectEnvelope('flash', 1)).toBe(0)
    expect(effectEnvelope('burst', 0.2)).toBeCloseTo(1)
    expect(effectEnvelope('burst', 0)).toBe(0)
    expect(effectEnvelope('vignette', 0.5)).toBeCloseTo(1)
  })

  it('baut Stufen nur im Abschnitt, Stroboskop als ein Filter', () => {
    const doc = parsed(
      rawDoc([
        { id: 'm1', at: s(1), label: '', effect: effect() },
        { id: 'm2', at: s(3), label: '', effect: effect({ kind: 'strobe', rate: 10 }) },
      ]),
    )
    const all = markerEffectFilters(doc.effects ?? [], {
      t0: 0,
      t1: 4,
      frameSec: 0.04,
      width: 640,
      height: 360,
    })
    expect(all.filter((f) => f.includes('0xffffff')).length).toBe(all.length)
    expect(all.some((f) => f.includes('mod(t-3,0.1),0.05)'))).toBe(true)
    // 0,4 s bei 25 Bildern/s = 10 Stufen (die letzte fast durchsichtig).
    expect(all.length).toBeGreaterThanOrEqual(9)
    const late = markerEffectFilters(doc.effects ?? [], {
      t0: 2,
      t1: 4,
      frameSec: 0.04,
      width: 640,
      height: 360,
    })
    expect(late).toHaveLength(1)
    const c = compileTimeline(doc, { sources })
    expect(c.filter).toContain('[vprefx]setpts=PTS+0.000000/TB,drawbox=')
    expect(compileTimeline(parsed(rawDoc([])), { sources }).filter).not.toContain('drawbox')
  })

  it('Vignette zeichnet Ringe vom Rand nach innen', () => {
    const doc = parsed(
      rawDoc([
        { id: 'm', at: 0, label: '', effect: effect({ kind: 'vignette', color: '#ff0044' }) },
      ]),
    )
    const f = markerEffectFilters(doc.effects ?? [], {
      t0: 0,
      t1: 4,
      frameSec: 0.04,
      width: 640,
      height: 360,
    })
    expect(f.some((x) => x.startsWith('drawbox=x=0:y=0:w=iw-0:h=ih-0:t=14:color=0xff0044@'))).toBe(
      true,
    )
    expect(f.some((x) => x.startsWith('drawbox=x=56:y=56:'))).toBe(true)
  })
})

describe('Drop-Effekte mit echtem FFmpeg', () => {
  let dir = ''
  let real: Record<string, { path: string; hasAudio: boolean }> = {}
  /** Mittlerer Farbwert (RGB) eines Bildes; `n` = Bildnummer. */
  const pixel = (file: string, n: number, x = 320, y = 180) => {
    const raw = execFileSync('ffmpeg', [
      ...['-v', 'error', '-i', file],
      ...['-vf', `select=eq(n\\,${n}),crop=8:8:${x}:${y},scale=1:1`, '-frames:v', '1'],
      ...['-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
    ])
    return [raw[0], raw[1], raw[2]]
  }
  const render = (doc: RenderDoc, name: string, range?: { start: number; end: number }) => {
    const out = path.join(dir, name)
    const c = compileTimeline(doc, { sources: real, ...(range ? { range } : {}) })
    execFileSync('ffmpeg', buildRenderArgs(c, { output: out, preset: 'ultrafast', crf: 16 }), {
      stdio: 'ignore',
    })
    return out
  }

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'vc-fx-'))
    execFileSync('ffmpeg', [
      ...['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x202020:s=640x360:r=25:d=4'],
      ...['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'],
      path.join(dir, 'a.mp4'),
    ])
    real = { a: { path: path.join(dir, 'a.mp4'), hasAudio: false } }
  })
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it('Blitz macht das Bild am Marker hell und klingt ab', () => {
    const doc = parsed(rawDoc([{ id: 'm', at: s(1), label: '', effect: effect() }]))
    const out = render(doc, 'flash.mp4')
    expect(pixel(out, 10)[0]).toBeLessThan(50) // vorher
    expect(pixel(out, 25)[0]).toBeGreaterThan(200) // am Marker
    expect(pixel(out, 32)[0]).toBeLessThan(pixel(out, 27)[0]) // klingt ab
    expect(pixel(out, 40)[0]).toBeLessThan(50) // vorbei
  })

  it('Farbblitz färbt, Vignette nur den Rand; Abschnitt ab Mitte des Effekts', () => {
    const doc = parsed(
      rawDoc([
        { id: 'm', at: s(1), label: '', effect: effect({ kind: 'burst', color: '#ff0000' }) },
        {
          id: 'n',
          at: s(2),
          label: '',
          effect: effect({ kind: 'vignette', color: '#00ff00', duration: s(1) }),
        },
      ]),
    )
    const out = render(doc, 'fx.mp4')
    const red = pixel(out, 27)
    expect(red[0] - red[2]).toBeGreaterThan(80)
    const edge = pixel(out, 62, 0, 0)
    const centre = pixel(out, 62)
    expect(edge[1] - edge[0]).toBeGreaterThan(80)
    expect(Math.abs(centre[1] - centre[0])).toBeLessThan(15)
    // Vorschau-Abschnitt ab 2,48 s: Effekt läuft mit Timeline-Zeit weiter.
    const part = render(doc, 'part.mp4', { start: s(2.48), end: s(3) })
    const e2 = pixel(part, 0, 0, 0)
    expect(e2[1] - e2[0]).toBeGreaterThan(80)
  })
  it('Stroboskop wechselt hell und dunkel', () => {
    const doc = parsed(
      rawDoc([
        {
          id: 'm',
          at: s(1),
          label: '',
          effect: effect({ kind: 'strobe', rate: 5, duration: s(1) }),
        },
      ]),
    )
    const out = render(doc, 'strobe.mp4')
    // 5 Blitze je s bei 25 Bildern/s: 2–3 Bilder hell, dann dunkel.
    expect(pixel(out, 26)[0]).toBeGreaterThan(200)
    expect(pixel(out, 29)[0]).toBeLessThan(50)
    expect(pixel(out, 31)[0]).toBeGreaterThan(200)
    expect(pixel(out, 55)[0]).toBeLessThan(50)
  })
})
