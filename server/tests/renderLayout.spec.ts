import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { buildRenderArgs, compileTimeline, piecewiseExpr } from '../src/lib/render/compile'
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

const keyed = (keys: unknown, over: Record<string, unknown> = {}) => ({
  layout: { x: 0.5, y: 0.5, scale: 0.25, opacity: 1, keys },
  ...over,
})
const LEFT_TO_RIGHT = [
  { at: 0, x: 0, y: 0.5, scale: 0.25 },
  { at: s(2), x: 1, y: 0.5, scale: 0.5 },
]

describe('Keyframes der Lage: Prüfung und Filter', () => {
  it('nimmt aufsteigende Keyframes an; ein einzelner wird zur festen Lage', () => {
    const two = parsed(rawDoc(keyed(LEFT_TO_RIGHT))).tracks[0].clips[0]
    expect(two).toMatchObject({ layout: { keys: LEFT_TO_RIGHT, opacity: 1 } })
    const one = parsed(rawDoc(keyed([{ at: s(1), x: 0.2, y: 0.3, scale: 0.4 }]))).tracks[0].clips[0]
    expect(one).toMatchObject({ layout: { x: 0.2, y: 0.3, scale: 0.4, opacity: 1 } })
    expect((one as { layout: object }).layout).not.toHaveProperty('keys')
    // Volle Größe in allen Keyframes bleibt eine Lage, sobald sie sich bewegt.
    const full = LEFT_TO_RIGHT.map((k) => ({ ...k, scale: 1 }))
    expect(parsed(rawDoc(keyed(full))).tracks[0].clips[0]).toHaveProperty('layout.keys')
    expect(parsed(rawDoc(keyed([]))).tracks[0].clips[0]).not.toHaveProperty('layout.keys')
  })

  it('Deckkraft je Keyframe: fehlt sie, gilt die des Clips; die Lage trägt die des ersten', () => {
    const fade = [{ ...LEFT_TO_RIGHT[0], opacity: 0 }, { ...LEFT_TO_RIGHT[1] }]
    const c = parsed(rawDoc({ layout: { x: 0, y: 0, scale: 0.5, opacity: 0.8, keys: fade } }))
      .tracks[0].clips[0] as { layout: { opacity: number; keys: Array<{ opacity: number }> } }
    expect(c.layout.keys.map((k) => k.opacity)).toEqual([0, 0.8])
    expect(c.layout.opacity).toBe(0)
    const r = parseTimelineDoc(rawDoc(keyed([{ ...LEFT_TO_RIGHT[0], opacity: 1.5 }])))
    expect(r.ok).toBe(false)
  })

  it('wechselnde Deckkraft läuft über eine Maske, gleiche Deckkraft bleibt beim einfachen Weg', () => {
    const fade = LEFT_TO_RIGHT.map((k, i) => ({ ...k, opacity: i }))
    const moving = compileTimeline(parsed(rawDoc(keyed(fade))), { sources })
    expect(moving.filter).toContain("geq=lum='255*(if(lt((0+(T+0)*1),0),0,")
    expect(moving.filter).toContain('blend=all_mode=multiply:shortest=1')
    expect(moving.filter).toContain('alphamerge')
    expect(moving.filter).not.toContain('lut=a=')
    const same = LEFT_TO_RIGHT.map((k) => ({ ...k, opacity: 0.4 }))
    const steady = compileTimeline(parsed(rawDoc(keyed(same))), { sources })
    expect(steady.filter).toContain('lut=a=val*0.4')
    expect(steady.filter).not.toContain('geq=')
  })

  it('lehnt ungültige Keyframes ab', () => {
    const bad = [
      'x',
      [{ at: 0, x: 0, y: 0, scale: 0.01 }],
      [{ at: 0, x: 2, y: 0, scale: 0.5 }],
      [{ at: -1, x: 0, y: 0, scale: 0.5 }],
      [LEFT_TO_RIGHT[1], LEFT_TO_RIGHT[0]],
      [LEFT_TO_RIGHT[0], LEFT_TO_RIGHT[0]],
      Array.from({ length: 33 }, (_, i) => ({ at: i, x: 0, y: 0, scale: 0.5 })),
    ]
    for (const keys of bad) {
      const r = parseTimelineDoc(rawDoc(keyed(keys)))
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.errors[0].path).toBe('tracks[0].clips[0].layout.keys')
    }
  })

  it('piecewiseExpr: gleichmäßig zwischen den Punkten, außen gehalten', () => {
    expect(piecewiseExpr([{ at: 1, value: 0.5 }], 't')).toBe('if(lt(t,1),0.5,0.5)')
    expect(
      piecewiseExpr(
        [
          { at: 0, value: 0 },
          { at: 2, value: 1 },
          { at: 3, value: 1 },
        ],
        'T',
      ),
    ).toBe('if(lt(T,0),0,if(lt(T,2),0+(0.5)*(T-0),if(lt(T,3),1,1)))')
  })

  it('rechnet Größe und Mitte je Bild in Quellzeit, auch im Abschnitt und mit Tempo', () => {
    const whole = compileTimeline(parsed(rawDoc(keyed(LEFT_TO_RIGHT))), { sources })
    expect(whole.filter).toContain(
      ':force_original_aspect_ratio=decrease:force_divisible_by=2:eval=frame',
    )
    expect(whole.filter).toContain('(0+(t+0)*1)')
    expect(whole.filter).toContain("overlay=x='max(0,min(W-w,(")
    expect(whole.filter).not.toContain("pad=640:360:'max")
    const part = compileTimeline(parsed(rawDoc(keyed(LEFT_TO_RIGHT))), {
      sources,
      range: { start: s(1), end: s(2) },
    })
    expect(part.filter).toContain('(0+(t+1)*1)')
    const fast = compileTimeline(
      parsed(rawDoc(keyed(LEFT_TO_RIGHT, { speed: 2, sourceIn: s(0.5), duration: s(1) }))),
      { sources },
    )
    expect(fast.filter).toContain('(0.5+(t+0)*2)')
    const dim = compileTimeline(
      parsed(rawDoc({ layout: { x: 0, y: 0, scale: 0.5, opacity: 0.4, keys: LEFT_TO_RIGHT } })),
      { sources },
    )
    expect(dim.filter).toContain('lut=a=val*0.4')
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

  const pixelAt = (file: string, frame: number, x: number, y: number) => {
    const raw = execFileSync('ffmpeg', [
      ...['-v', 'error', '-i', file, '-frames:v', '1'],
      ...['-vf', `select=eq(n\\,${frame}),crop=8:8:${x}:${y},scale=1:1`],
      ...['-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
    ])
    return [raw[0], raw[1], raw[2]]
  }

  it('Keyframes bewegen und vergrößern das Bild über die Zeit', () => {
    const out = render(parsed(rawDoc(keyed(LEFT_TO_RIGHT))), 'keys.mp4')
    // Anfang: klein (160×90) ganz links, Mitte der Höhe.
    expect(near(pixelAt(out, 0, 70, 176), BLUE)).toBe(true)
    expect(near(pixelAt(out, 0, 200, 176), RED)).toBe(true)
    expect(near(pixelAt(out, 0, 70, 100), RED)).toBe(true)
    // Mitte (1 s): Größe 0,375 (240×135) um die Bildmitte.
    expect(near(pixelAt(out, 25, 316, 176), BLUE)).toBe(true)
    expect(near(pixelAt(out, 25, 70, 176), RED)).toBe(true)
    expect(near(pixelAt(out, 25, 560, 176), RED)).toBe(true)
    // Ende: halb so groß wie das Format (320×180) ganz rechts.
    expect(near(pixelAt(out, 49, 560, 176), BLUE)).toBe(true)
    expect(near(pixelAt(out, 49, 340, 100), BLUE)).toBe(true)
    expect(near(pixelAt(out, 49, 200, 176), RED)).toBe(true)
  })

  it('Deckkraft als Keyframe blendet das Bild über die Zeit ein', () => {
    const still = { x: 0.5, y: 0.5, scale: 0.5 }
    const keys = [
      { at: 0, ...still, opacity: 0 },
      { at: s(2), ...still, opacity: 1 },
    ]
    const doc = parsed(rawDoc(keyed(keys)))
    const out = render(doc, 'keys-fade.mp4')
    expect(near(pixelAt(out, 0, 316, 176), RED)).toBe(true)
    expect(near(pixelAt(out, 25, 316, 176), [128, 0, 128], 50)).toBe(true)
    expect(near(pixelAt(out, 49, 316, 176), BLUE, 60)).toBe(true)
    // Außerhalb des kleinen Bildes bleibt die untere Spur unverändert.
    expect(near(pixelAt(out, 25, 40, 40), RED)).toBe(true)
    // Abschnitt ab 1 s: beginnt halb durchscheinend.
    const part = path.join(dir, 'keys-fade-part.mp4')
    const c = compileTimeline(doc, { sources: real, range: { start: s(1), end: s(2) } })
    execFileSync('ffmpeg', buildRenderArgs(c, { output: part, preset: 'ultrafast', crf: 16 }), {
      stdio: 'ignore',
    })
    expect(near(pixelAt(part, 0, 316, 176), [128, 0, 128], 50)).toBe(true)
    expect(near(pixelAt(part, 24, 316, 176), BLUE, 60)).toBe(true)
  })

  it('ein Abschnitt der Vorschau zeigt dieselbe Lage wie der ganze Film', () => {
    const doc = parsed(rawDoc(keyed(LEFT_TO_RIGHT)))
    const out = path.join(dir, 'keys-part.mp4')
    const c = compileTimeline(doc, { sources: real, range: { start: s(1), end: s(2) } })
    execFileSync('ffmpeg', buildRenderArgs(c, { output: out, preset: 'ultrafast', crf: 16 }), {
      stdio: 'ignore',
    })
    expect(near(pixelAt(out, 0, 316, 176), BLUE)).toBe(true)
    expect(near(pixelAt(out, 0, 70, 176), RED)).toBe(true)
    expect(near(pixelAt(out, 24, 560, 176), BLUE)).toBe(true)
  })

  it('Standbild und Übergang eines Clips mit Keyframes rendern; das Standbild hält die letzte Lage', () => {
    const doc = parsed({
      ...rawDoc(null),
      tracks: [
        {
          id: 'V1',
          kind: 'video',
          hidden: false,
          clips: [
            clip('v1', 'b', { ...keyed(LEFT_TO_RIGHT), hold: true }),
            clip('v2', 'a', {
              ...keyed(LEFT_TO_RIGHT),
              start: s(3),
              transitionIn: { preset: 'slide', duration: s(1) },
            }),
          ],
        },
      ],
    })
    const out = render(doc, 'keys-mix.mp4')
    // In der Lücke (2,4 s) steht das blaue Bild groß ganz rechts.
    expect(near(pixelAt(out, 60, 560, 176), BLUE)).toBe(true)
    expect(near(pixelAt(out, 60, 100, 176), GREEN)).toBe(true)
    const count = execFileSync('ffprobe', [
      ...['-v', 'error', '-select_streams', 'v:0', '-count_frames'],
      ...['-show_entries', 'stream=nb_read_frames', '-of', 'default=nw=1:nk=1', out],
    ])
    expect(count.toString().trim()).toBe('125')
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
