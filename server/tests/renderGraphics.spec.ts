import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import express from 'express'
import { config } from '../src/config'
import { buildRenderArgs, compileTimeline } from '../src/lib/render/compile'
import { parseTimelineDoc, type RenderDoc } from '../src/lib/render/doc'
import {
  GraphicStore,
  graphicStore,
  isGraphicId,
  resolveDocGraphics,
} from '../src/lib/render/graphics'
import { graphicsRouter } from '../src/routes/graphics'
import { previewRouter } from '../src/routes/preview'
import { renderRouter } from '../src/routes/render'
import { ValidationError } from '../src/lib/validate'

const s = (seconds: number) => Math.round(seconds * 1_000_000)
const ID = 'a'.repeat(32)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any

/** Rotes Video 0–3 s, darüber eine Ebenen-Spur mit einer Grafik. */
function rawDoc(data: Record<string, unknown>, start = 0.5, duration = 1): Loose {
  return {
    version: 2,
    settings: { width: 640, height: 360, fps: 25, background: '#102030', sampleRate: 48000 },
    assets: { a: { id: 'a', kind: 'video', duration: s(4) } },
    tracks: [
      {
        id: 'G1',
        kind: 'overlay',
        hidden: false,
        clips: [{ id: 'g1', kind: 'graphic', start: s(start), duration: s(duration), data }],
      },
      {
        id: 'V1',
        kind: 'video',
        hidden: false,
        clips: [
          { id: 'v1', kind: 'video', asset: 'a', start: 0, duration: s(3), sourceIn: 0, speed: 1 },
        ],
      },
    ],
  }
}

const graphicData = (over: Record<string, unknown> = {}) => ({
  kind: 'rect',
  png: ID,
  renderHeight: 360,
  x: 0.5,
  y: 0.5,
  animation: 'none',
  loop: 'none',
  ...over,
})

function parsed(raw: unknown): RenderDoc {
  const r = parseTimelineDoc(raw)
  if (!r.ok) throw new Error(JSON.stringify(r.errors))
  return r.doc
}

const sources = { a: { path: '/m/a.mp4', hasAudio: false } }
const image = { [ID]: { path: '/g/x.png', width: 100, height: 60 } }

describe('Grafik-Clips im Dokument', () => {
  it('übernimmt Bild-ID, Maßstab, Lage und Animation', () => {
    const doc = parsed(
      rawDoc(graphicData({ animation: 'pop', loop: 'pulse', animSpeed: 2, w: 0.3 })),
    )
    expect((doc.tracks[0].clips[0] as Loose).graphic).toEqual({
      png: ID,
      refHeight: 360,
      x: 0.5,
      y: 0.5,
      animation: 'pop',
      loop: 'pulse',
      animSpeed: 2,
    })
  })

  it('lässt Grafiken ohne Bild gelten, zeigt sie aber nicht', () => {
    const doc = parsed(rawDoc({ kind: 'rect', x: 0.5, y: 0.5 }))
    expect((doc.tracks[0].clips[0] as Loose).graphic).toBeUndefined()
    const c = compileTimeline(doc, { sources, graphics: image })
    expect(c.filter).not.toContain('overlay=x=')
  })

  it('lehnt kaputte Angaben mit Pfad ab', () => {
    const errorPath = (over: Record<string, unknown>) => {
      const r = parseTimelineDoc(rawDoc(graphicData(over)))
      return r.ok ? null : r.errors[0].path
    }
    expect(errorPath({ png: '../etc/passwd' })).toBe('tracks[0].clips[0].data.png')
    expect(errorPath({ renderHeight: 0 })).toBe('tracks[0].clips[0].data.renderHeight')
    expect(errorPath({ x: 1.5 })).toBe('tracks[0].clips[0].data')
    expect(errorPath({ animation: 'zoom' })).toBe('tracks[0].clips[0].data.animation')
    expect(errorPath({ loop: 'jump' })).toBe('tracks[0].clips[0].data.loop')
    expect(errorPath({ animSpeed: 'schnell' })).toBe('tracks[0].clips[0].data.animSpeed')
  })
})

describe('Keyframes für Grafiken', () => {
  const keys = [
    { at: 0, x: 0.25, y: 0.5, scale: 1 },
    { at: s(2), x: 0.75, y: 0.5, scale: 0.5 },
  ]

  it('übernimmt Keyframes und weiche Bewegung; ohne Keyframes bleibt alles wie bisher', () => {
    const doc = parsed(rawDoc(graphicData({ keys, ease: 'smooth' }), 0.5, 2))
    expect((doc.tracks[0].clips[0] as Loose).graphic).toMatchObject({ keys, ease: 'smooth' })
    // Zeiten vor dem Clip-Anfang sind erlaubt (nach dem Kürzen vorn).
    const early = [{ ...keys[0], at: -s(1) }, keys[1]]
    expect(
      (parsed(rawDoc(graphicData({ keys: early }))).tracks[0].clips[0] as Loose).graphic.keys,
    ).toEqual(early)
    const plain = (
      parsed(rawDoc(graphicData({ keys: [], ease: 'smooth' }))).tracks[0].clips[0] as Loose
    ).graphic
    expect(plain.keys).toBeUndefined()
    expect(plain.ease).toBeUndefined()
  })

  it('lehnt kaputte Keyframes ab', () => {
    const errorPath = (over: Record<string, unknown>) => {
      const r = parseTimelineDoc(rawDoc(graphicData(over)))
      return r.ok ? null : r.errors[0].path
    }
    const at = 'tracks[0].clips[0].data.keys'
    expect(errorPath({ keys: 'x' })).toBe(at)
    expect(errorPath({ keys: [{ at: 0.5, x: 0.5, y: 0.5, scale: 1 }] })).toBe(at)
    expect(errorPath({ keys: [{ at: 0, x: 2, y: 0.5, scale: 1 }] })).toBe(at)
    expect(errorPath({ keys: [{ at: 0, x: 0.5, y: 0.5, scale: 9 }] })).toBe(at)
    expect(errorPath({ keys: [keys[1], keys[0]] })).toBe(at)
    expect(errorPath({ keys: [keys[0], keys[0]] })).toBe(at)
    expect(errorPath({ keys: Array.from({ length: 33 }, (_, i) => ({ ...keys[0], at: i })) })).toBe(
      at,
    )
    expect(errorPath({ keys, ease: 'bounce' })).toBe('tracks[0].clips[0].data.ease')
  })

  it('bewegt Mitte und Größe über Ausdrücke ab Clip-Anfang', () => {
    const c = compileTimeline(parsed(rawDoc(graphicData({ keys }), 0.5, 2)), {
      sources,
      graphics: image,
    })
    const chains = c.filter.split(';')
    const src = chains.find((x) => x.startsWith('[1:v]format=rgba'))!
    expect(src).toContain(':eval=frame')
    expect(src).toContain('1+(-0.25)*((t-0.52)-0)')
    const over = chains.find((x) => x.includes('overlay=x='))!
    expect(over).toContain(
      "x='round((if(lt((t-0.52),0),0.25,if(lt((t-0.52),2),0.25+(0.25)*((t-0.52)-0),0.75)))*640-overlay_w/2)'",
    )
    expect(over).toContain("y='round((0.5)*360-overlay_h/2)'")

    // Gleiche Größe überall: kein Skalieren je Bild, feste halbe Maße.
    const fixed = keys.map((k) => ({ ...k, scale: 1 }))
    const plain = compileTimeline(parsed(rawDoc(graphicData({ keys: fixed }), 0.5, 2)), {
      sources,
      graphics: image,
    }).filter
    expect(plain).not.toContain('eval=frame')
    expect(plain).toContain('*640-50)')
    expect(plain).toContain("y='round((0.5)*360-30)'")
    // Weich: Glättung im Ausdruck.
    const smooth = compileTimeline(
      parsed(rawDoc(graphicData({ keys: fixed, ease: 'smooth' }), 0.5, 2)),
      { sources, graphics: image },
    ).filter
    expect(smooth).toContain('*(3-2*')
  })
})

describe('compileTimeline mit Grafiken', () => {
  it('legt die Grafik mit Zeiten der ganzen Timeline über das Bild', () => {
    const c = compileTimeline(parsed(rawDoc(graphicData())), { sources, graphics: image })
    expect(c.inputs.slice(-8)).toEqual([
      '-loop',
      '1',
      '-framerate',
      '25',
      '-t',
      '4.000000',
      '-i',
      '/g/x.png',
    ])
    const chains = c.filter.split(';')
    const at = chains.findIndex((x) => x.startsWith('[vplain]'))
    expect(chains.slice(at, at + 4)).toEqual([
      '[vplain]setpts=PTS+0.000000/TB[gbase2]',
      '[1:v]format=rgba,setpts=PTS+0.000000/TB[g1]',
      "[gbase2][g1]overlay=x=270:y=150:enable='gte(t,0.519)*lt(t,1.519)':shortest=1[gmix3]",
      '[gmix3]setpts=PTS-STARTPTS,format=yuv420p[vout]',
    ])
    expect(c.filter.match(/\[vout\]/g)).toHaveLength(1)
    expect(c.ass).toBeUndefined()
  })

  it('verschiebt im Abschnitt Bild und Grafik gemeinsam und skaliert für die Vorschau', () => {
    const doc = parsed(rawDoc(graphicData()))
    const part = compileTimeline(doc, {
      sources,
      graphics: image,
      range: { start: s(1), end: s(2) },
      size: { width: 320, height: 180 },
    })
    expect(part.filter).toContain('[vplain]setpts=PTS+1.000000/TB[')
    expect(part.filter).toContain('format=rgba,setpts=PTS+1.000000/TB,scale=50:30[g1]')
    expect(part.filter).toContain("overlay=x=135:y=75:enable='gte(t,0.519)*lt(t,1.519)'")
    // Abschnitt ohne Grafik: keine zusätzliche Eingabe, kein overlay.
    const later = compileTimeline(doc, {
      sources,
      graphics: image,
      range: { start: s(2), end: s(3) },
    })
    expect(later.inputs).not.toContain('/g/x.png')
    expect(later.filter).not.toContain('gbase')
  })

  it('lässt ausgeblendete Spuren und fehlende Bilder weg; Texte liegen über Grafiken', () => {
    const hidden = rawDoc(graphicData())
    hidden.tracks[0].hidden = true
    expect(compileTimeline(parsed(hidden), { sources, graphics: image }).filter).not.toContain(
      'gbase',
    )
    expect(compileTimeline(parsed(rawDoc(graphicData())), { sources }).filter).not.toContain(
      'gbase',
    )

    const both = rawDoc(graphicData())
    both.tracks.unshift({
      id: 'T1',
      kind: 'overlay',
      hidden: false,
      clips: [
        {
          id: 't1',
          kind: 'text',
          start: s(0.5),
          duration: s(1),
          data: {
            text: 'Hallo',
            x: 0.5,
            y: 0.5,
            size: 0.1,
            color: '#ffffff',
            font: 'roboto',
            style: 'box',
            animation: 'none',
            accent: '#00ff00',
          },
        },
      ],
    })
    const c = compileTimeline(parsed(both), { sources, graphics: image })
    expect(c.filter).toMatch(
      /\[gmix\d+\]ass=filename=@@ASS@@:fontsdir=@@FONTS@@,setpts=PTS-STARTPTS,format=yuv420p\[vout\];/,
    )
  })

  it('nennt fehlende Bilder je einmal', () => {
    const raw = rawDoc(graphicData())
    raw.tracks[0].clips.push(
      { id: 'g2', kind: 'graphic', start: s(2), duration: s(1), data: graphicData() },
      {
        id: 'g3',
        kind: 'graphic',
        start: s(3),
        duration: s(1),
        data: graphicData({ png: 'b'.repeat(32) }),
      },
    )
    const doc = parsed(raw)
    const known = { path: '/g/x.png', width: 100, height: 60 }
    expect(resolveDocGraphics(doc, (id) => (id === ID ? known : undefined))).toEqual({
      graphics: { [ID]: known },
      missing: ['b'.repeat(32)],
    })
  })
})

describe('GraphicStore und echtes FFmpeg', () => {
  let dir = ''
  let png = Buffer.alloc(0)
  const pixel = (file: string, t: number, x: number, y: number) => {
    const raw = execFileSync('ffmpeg', [
      ...['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1'],
      ...['-vf', `crop=8:8:${x}:${y},scale=1:1`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
    ])
    return [raw[0], raw[1], raw[2]]
  }
  const near = (rgb: number[], want: number[]) => rgb.every((v, i) => Math.abs(v - want[i]) <= 40)

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'vc-graphics-'))
    execFileSync('ffmpeg', [
      ...['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=640x360:r=25:d=4'],
      ...['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'],
      path.join(dir, 'a.mp4'),
    ])
    // Grünes Rechteck 200×100 als PNG.
    execFileSync('ffmpeg', [
      ...['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x00ff00:s=200x100'],
      ...['-frames:v', '1', path.join(dir, 'green.png')],
    ])
    png = await readFile(path.join(dir, 'green.png'))
  }, 60_000)
  afterAll(() => rm(dir, { recursive: true, force: true }))

  it('legt PNGs unter dem Hash ab, erkennt Doppelte und weist anderes ab', async () => {
    const store = new GraphicStore({ dir: path.join(dir, 'store'), maxBytes: 1024 * 1024 })
    await store.init()
    const a = await store.put(png)
    expect(isGraphicId(a.id)).toBe(true)
    expect(a).toMatchObject({ width: 200, height: 100 })
    expect((await store.put(png)).id).toBe(a.id)
    expect(await readdir(path.join(dir, 'store'))).toEqual([`${a.id}.png`])
    expect(store.get(a.id)).toMatchObject({ path: a.path, width: 200, height: 100 })
    expect(store.get('x')).toBeUndefined()
    await expect(store.put(Buffer.from('kein Bild'))).rejects.toThrow('kein PNG')

    // Neustart: Bild bleibt, Fremdes im Ordner wird entfernt.
    await writeFile(path.join(dir, 'store', 'rest.part'), 'x')
    const again = new GraphicStore({ dir: path.join(dir, 'store'), maxBytes: 1024 * 1024 })
    await again.init()
    expect(again.get(a.id)).toMatchObject({ width: 200, height: 100 })
    expect(await readdir(path.join(dir, 'store'))).toEqual([`${a.id}.png`])
  })

  it('hält die Obergrenze ein und behält das zuletzt Abgelegte', async () => {
    const store = new GraphicStore({ dir: path.join(dir, 'small'), maxBytes: png.length + 10 })
    await store.init()
    const first = await store.put(png)
    execFileSync('ffmpeg', [
      ...['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x0000ff:s=200x100'],
      ...['-frames:v', '1', path.join(dir, 'blue.png')],
    ])
    const second = await store.put(await readFile(path.join(dir, 'blue.png')))
    expect(store.get(first.id)).toBeUndefined()
    expect(store.get(second.id)).toBeDefined()
  })

  it('zeigt die Grafik zur richtigen Zeit an der richtigen Stelle, auch im Abschnitt', async () => {
    const store = new GraphicStore({ dir: path.join(dir, 'render'), maxBytes: 1024 * 1024 })
    await store.init()
    const stored = await store.put(png)
    const doc = parsed(rawDoc(graphicData({ png: stored.id })))
    const real = { a: { path: path.join(dir, 'a.mp4'), hasAudio: false } }
    const { graphics, missing } = resolveDocGraphics(doc, (id) => store.get(id))
    expect(missing).toEqual([])
    const render = (name: string, opts: Partial<Parameters<typeof compileTimeline>[1]> = {}) => {
      const out = path.join(dir, `${name}.mp4`)
      const c = compileTimeline(doc, { sources: real, graphics, ...opts })
      execFileSync('ffmpeg', buildRenderArgs(c, { output: out, preset: 'ultrafast', crf: 20 }), {
        stdio: 'ignore',
      })
      return out
    }
    const green = [0, 255, 0]
    const red = [255, 0, 0]

    // Ganz: 0,5–1,5 s grünes Rechteck 200×100 um die Bildmitte.
    const whole = render('whole')
    expect(near(pixel(whole, 0.2, 316, 176), red)).toBe(true)
    expect(near(pixel(whole, 1.0, 316, 176), green)).toBe(true)
    expect(near(pixel(whole, 1.0, 226, 136), green)).toBe(true)
    expect(near(pixel(whole, 1.0, 206, 176), red)).toBe(true)
    expect(near(pixel(whole, 1.0, 316, 116), red)).toBe(true)
    expect(near(pixel(whole, 2.0, 316, 176), red)).toBe(true)

    // Abschnitt 1–2 s in halber Größe: Grafik endet nach 0,5 s und ist halb so groß.
    const part = render('part', {
      range: { start: s(1), end: s(2) },
      size: { width: 320, height: 180 },
    })
    expect(near(pixel(part, 0.2, 156, 86), green)).toBe(true)
    expect(near(pixel(part, 0.2, 114, 68), green)).toBe(true)
    expect(near(pixel(part, 0.2, 98, 86), red)).toBe(true)
    expect(near(pixel(part, 0.8, 156, 86), red)).toBe(true)
  }, 120_000)

  it('bewegt und verkleinert die Grafik über Keyframes, auch im Abschnitt', async () => {
    const store = new GraphicStore({ dir: path.join(dir, 'keys'), maxBytes: 1024 * 1024 })
    await store.init()
    const stored = await store.put(png)
    const keys = [
      { at: 0, x: 0.25, y: 0.5, scale: 1 },
      { at: s(2), x: 0.75, y: 0.5, scale: 0.5 },
    ]
    const doc = parsed(rawDoc(graphicData({ png: stored.id, keys }), 0.5, 2))
    const real = { a: { path: path.join(dir, 'a.mp4'), hasAudio: false } }
    const { graphics } = resolveDocGraphics(doc, (id) => store.get(id))
    const render = (name: string, opts: Partial<Parameters<typeof compileTimeline>[1]> = {}) => {
      const out = path.join(dir, `${name}.mp4`)
      const c = compileTimeline(doc, { sources: real, graphics, ...opts })
      execFileSync('ffmpeg', buildRenderArgs(c, { output: out, preset: 'ultrafast', crf: 20 }), {
        stdio: 'ignore',
      })
      return out
    }
    const green = [0, 255, 0]
    const red = [255, 0, 0]

    const whole = render('keys-whole')
    // Kurz nach dem Anfang: links, fast volle Größe (Mitte bei x ≈ 176).
    expect(near(pixel(whole, 0.6, 172, 176), green)).toBe(true)
    expect(near(pixel(whole, 0.6, 316, 176), red)).toBe(true)
    // Mitte des Clips: Bildmitte, drei Viertel der Größe (150×75).
    expect(near(pixel(whole, 1.5, 316, 176), green)).toBe(true)
    expect(near(pixel(whole, 1.5, 228, 176), red)).toBe(true)
    // Kurz vor dem Ende: rechts, etwa halbe Größe (Mitte bei x ≈ 464).
    expect(near(pixel(whole, 2.4, 460, 176), green)).toBe(true)
    expect(near(pixel(whole, 2.4, 390, 176), red)).toBe(true)
    expect(near(pixel(whole, 2.4, 172, 176), red)).toBe(true)

    // Abschnitt 1–2 s in halber Größe: bei 1,5 s in der Mitte, 75×37 groß.
    const part = render('keys-part', {
      range: { start: s(1), end: s(2) },
      size: { width: 320, height: 180 },
    })
    expect(near(pixel(part, 0.5, 156, 86), green)).toBe(true)
    expect(near(pixel(part, 0.5, 108, 86), red)).toBe(true)
  }, 120_000)

  it('blendet mit Animation weich ein (Zeit ab Clip-Beginn, auch im Abschnitt)', async () => {
    const store = new GraphicStore({ dir: path.join(dir, 'anim'), maxBytes: 1024 * 1024 })
    await store.init()
    const stored = await store.put(png)
    // Grafik 0,9–2,9 s mit Einblenden (0,4 s): bei 1,0 s erst zu einem Viertel sichtbar.
    const doc = parsed(rawDoc(graphicData({ png: stored.id, animation: 'fade' }), 0.9, 2))
    const out = path.join(dir, 'fade.mp4')
    const c = compileTimeline(doc, {
      sources: { a: { path: path.join(dir, 'a.mp4'), hasAudio: false } },
      graphics: { [stored.id]: stored },
      range: { start: s(1), end: s(2) },
    })
    execFileSync('ffmpeg', buildRenderArgs(c, { output: out, preset: 'ultrafast', crf: 20 }), {
      stdio: 'ignore',
    })
    const early = pixel(out, 0.0, 316, 176)
    expect(early[0]).toBeGreaterThan(120)
    expect(early[1]).toBeGreaterThan(20)
    expect(early[1]).toBeLessThan(140)
    expect(near(pixel(out, 0.6, 316, 176), [0, 255, 0])).toBe(true)
  }, 120_000)
})

describe('Einstellungen', () => {
  it('hat einen Ordner und eine Obergrenze für Grafiken', () => {
    expect(config.graphicsDir).toContain('graphics')
    expect(config.graphicsCacheBytes).toBeGreaterThan(0)
  })
})

describe('Routen für Grafiken', () => {
  let server: Server
  let base = ''
  let png = Buffer.alloc(0)

  beforeAll(async () => {
    await graphicStore.init()
    const dir = await mkdtemp(path.join(os.tmpdir(), 'vc-graphics-route-'))
    execFileSync('ffmpeg', [
      ...['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x123456:s=64x32'],
      ...['-frames:v', '1', path.join(dir, 'x.png')],
    ])
    png = await readFile(path.join(dir, 'x.png'))
    await rm(dir, { recursive: true, force: true })
    const app = express()
    app.use('/api', graphicsRouter)
    app.use('/api', previewRouter)
    app.use('/api', renderRouter)
    app.use(
      (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        res
          .status(err instanceof ValidationError ? err.statusCode : 500)
          .json({ error: String(err) })
      },
    )
    server = app.listen(0, '127.0.0.1')
    await new Promise((r) => server.once('listening', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`
  })
  afterAll(() => new Promise((r) => server.close(r)))

  const json = (url: string, body: unknown) =>
    fetch(`${base}${url}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  /** Nur eine Grafik, kein Video: braucht keine Medien auf dem Server. */
  const docWith = (id: string) => {
    const raw = rawDoc(graphicData({ png: id }))
    raw.tracks.pop()
    raw.assets = {}
    return raw
  }

  it('nimmt ein PNG an und weist anderes ab', async () => {
    const res = await fetch(`${base}/graphics`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/png' },
      body: png,
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { id: string; width: number; height: number }
    expect(isGraphicId(body.id)).toBe(true)
    expect(body).toMatchObject({ width: 64, height: 32 })

    const bad = await fetch(`${base}/graphics`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/png' },
      body: 'kein Bild',
    })
    expect(bad.status).toBe(400)
    const wrongType = await fetch(`${base}/graphics`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: png,
    })
    expect(wrongType.status).toBe(400)
  })

  it('meldet fehlende Grafiken im Vorschau-Plan und lehnt den Export damit ab', async () => {
    const lost = 'c'.repeat(32)
    const plan = await json('/preview/plan', { doc: docWith(lost) })
    expect(plan.status).toBe(200)
    expect(((await plan.json()) as { missingGraphics: string[] }).missingGraphics).toEqual([lost])

    const exported = await json('/render', { doc: docWith(lost) })
    expect(exported.status).toBe(409)
    expect(((await exported.json()) as { missingGraphics: string[] }).missingGraphics).toEqual([
      lost,
    ])

    const { id } = await graphicStore.put(png)
    const ok = await json('/preview/plan', { doc: docWith(id) })
    expect(((await ok.json()) as { missingGraphics: string[] }).missingGraphics).toEqual([])
  })
})
