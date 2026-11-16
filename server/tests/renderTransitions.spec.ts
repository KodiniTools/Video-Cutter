import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { buildRenderArgs, compileTimeline } from '../src/lib/render/compile'
import { parseTimelineDoc, type RenderDoc } from '../src/lib/render/doc'
import { checkLossless } from '../src/lib/render/lossless'

const s = (seconds: number) => Math.round(seconds * 1_000_000)

/** Zwei Clips auf V1: rot (0–2 s), dann blau; der blaue beginnt mit einem Übergang. */
function rawDoc(transitionIn: unknown, secondStart = 2): Record<string, unknown> {
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
          { id: 'v1', kind: 'video', asset: 'a', start: 0, duration: s(2), sourceIn: 0, speed: 1 },
          {
            id: 'v2',
            kind: 'video',
            asset: 'b',
            start: s(secondStart),
            duration: s(2),
            sourceIn: 0,
            speed: 1,
            ...(transitionIn === undefined ? {} : { transitionIn }),
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

describe('Übergänge: Prüfung', () => {
  it('nimmt bekannte Übergänge an und lehnt Unsinn ab', () => {
    const ok = parsed(rawDoc({ preset: 'slide', duration: s(1), mehr: 1 }))
    const clip = ok.tracks[0].clips[1] as { transitionIn?: unknown }
    expect(clip.transitionIn).toEqual({ preset: 'slide', duration: s(1) })
    expect(parsed(rawDoc(null)).tracks[0].clips[1]).not.toHaveProperty('transitionIn')
    for (const bad of [
      { preset: 'none', duration: s(1) },
      { preset: 'wipe', duration: s(1) },
      { preset: 'fade', duration: 10 },
      { preset: 'fade', duration: s(11) },
      { preset: 'fade', duration: 0.5 },
      'fade',
    ]) {
      const r = parseTimelineDoc(rawDoc(bad))
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.errors[0].path).toBe('tracks[0].clips[1].transitionIn')
    }
  })
})

describe('Übergänge: verlustfreier Export', () => {
  it('ist mit einem Übergang nicht möglich', () => {
    const raw = rawDoc(undefined) as { tracks: { clips: Record<string, unknown>[] }[] }
    raw.tracks[0].clips = [raw.tracks[0].clips[0]]
    const info = () => ({ width: 640, height: 360, hasAudio: false })
    expect(checkLossless(parsed(raw), info).ok).toBe(true)
    raw.tracks[0].clips[0].transitionIn = { preset: 'fade', duration: s(1) }
    expect(checkLossless(parsed(raw), info)).toEqual({ ok: false, reason: 'transition' })
  })
})

describe('Übergänge: Filter', () => {
  it('ohne Übergang bleibt der Filter wie bisher', () => {
    const plain = compileTimeline(parsed(rawDoc(undefined)), { sources })
    expect(plain.filter).not.toMatch(/xfade|fade=/)
  })

  it('Blende: voriger Clip blendet aus, dieser ein, mit Zeiten im Clip', () => {
    const c = compileTimeline(parsed(rawDoc({ preset: 'fade', duration: s(1) })), { sources })
    // 0,5 s = 13 Bilder bei 25 Bildern/s (gerundet) = 0,52 s.
    expect(c.filter).toContain('fade=t=out:st=1.480000:d=0.520000:color=0x00ff00')
    expect(c.filter).toContain('fade=t=in:st=0.000000:d=0.520000:color=0x00ff00')
    expect(c.filter).not.toContain('xfade')
    // Abschnitt hinter der Blende: nichts mehr davon.
    const later = compileTimeline(parsed(rawDoc({ preset: 'fade', duration: s(1) })), {
      sources,
      range: { start: s(3), end: s(4) },
    })
    expect(later.filter).not.toContain('fade=')
    // Abschnitt mitten in der Einblendung: Zeit im Clip wird mitgegeben.
    const mid = compileTimeline(parsed(rawDoc({ preset: 'fade', duration: s(1) })), {
      sources,
      range: { start: s(2.2), end: s(3) },
    })
    expect(mid.filter).toContain('setpts=PTS+0.200000/TB,fade=t=in:st=0.000000:d=0.520000')
  })

  it('Schieben: läuft über dem angehaltenen letzten Bild des vorigen Clips', () => {
    const c = compileTimeline(parsed(rawDoc({ preset: 'slide', duration: s(1) })), { sources })
    expect(c.filter).toContain('reverse,trim=end_frame=1')
    expect(c.filter).toContain('xfade=transition=slideleft:duration=0.520000:offset=0')
    expect(c.filter).toContain('trim=start_frame=0:end_frame=50')
    // Eingaben: Clip 1, Ende von Clip 1 (letzte 13 Bilder ab 1,48 s), Clip 2.
    expect(c.inputs.filter((x) => x === '-i')).toHaveLength(3)
    expect(c.inputs).toContain('1.480000')
    // Stück aus der Mitte des Übergangs: Der Clip wird von vorn gerechnet und dann gekürzt.
    const mid = compileTimeline(parsed(rawDoc({ preset: 'slide', duration: s(1) })), {
      sources,
      range: { start: s(2.2), end: s(3) },
    })
    expect(mid.filter).toContain('trim=start_frame=5:end_frame=25')
    expect(mid.frames).toBe(20)
  })

  it('nach einer Lücke kommt der Clip aus dem Hintergrund', () => {
    const c = compileTimeline(parsed(rawDoc({ preset: 'scale', duration: s(1) }, 2.4)), { sources })
    expect(c.filter).toContain('xfade=transition=zoomin')
    expect(c.filter).not.toContain('reverse')
    expect(c.inputs.filter((x) => x === '-i')).toHaveLength(2)
  })
})

describe('Übergänge mit echtem FFmpeg', () => {
  let dir = ''
  let real: Record<string, { path: string; hasAudio: boolean }> = {}
  const frames = (file: string) =>
    execFileSync('ffprobe', [
      ...['-v', 'error', '-select_streams', 'v:0', '-count_frames'],
      ...['-show_entries', 'stream=nb_read_frames', '-of', 'default=nw=1:nk=1', file],
    ])
      .toString()
      .trim()
  /** Mittlere Farbe (R, G, B) um (x, y) im Bild Nr. `n`. */
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
    dir = await mkdtemp(path.join(os.tmpdir(), 'vc-trans-'))
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

  it('Blende: über die Hintergrundfarbe, Länge bleibt gleich', () => {
    const doc = parsed(rawDoc({ preset: 'fade', duration: s(1) }))
    const out = render(doc, 'fade.mp4')
    expect(frames(out)).toBe('100')
    expect(near(pixel(out, 20, 320, 180), [255, 0, 0])).toBe(true)
    // Bild 49 (letztes von Rot) und Bild 50 (erstes von Blau): fast nur Hintergrund.
    expect(near(pixel(out, 49, 320, 180), [0, 255, 0], 60)).toBe(true)
    expect(near(pixel(out, 50, 320, 180), [0, 255, 0], 60)).toBe(true)
    // Mitten in den Blenden: Mischung.
    const mixOut = pixel(out, 43, 320, 180)
    expect(mixOut[0]).toBeGreaterThan(60)
    expect(mixOut[1]).toBeGreaterThan(60)
    const mixIn = pixel(out, 56, 320, 180)
    expect(mixIn[2]).toBeGreaterThan(60)
    expect(mixIn[1]).toBeGreaterThan(60)
    expect(near(pixel(out, 75, 320, 180), [0, 0, 255])).toBe(true)

    // Ein Abschnitt, der mitten in der Ausblendung beginnt, zeigt dasselbe Bild.
    const part = render(doc, 'fade-part.mp4', { start: s(1.6), end: s(2.4) })
    expect(frames(part)).toBe('20')
    const whole = pixel(out, 43, 320, 180)
    const piece = pixel(part, 3, 320, 180)
    expect(near(piece, whole, 12)).toBe(true)
    expect(near(pixel(part, 16, 320, 180), pixel(out, 56, 320, 180), 12)).toBe(true)
  }, 120_000)

  it('Schieben: neues Bild kommt von rechts über das alte, auch im Abschnitt', () => {
    const doc = parsed(rawDoc({ preset: 'slide', duration: s(1) }))
    const out = render(doc, 'slide.mp4')
    expect(frames(out)).toBe('100')
    expect(near(pixel(out, 49, 320, 180), [255, 0, 0])).toBe(true)
    // Bild 56 = 6 von 13 Bildern: links noch Rot (angehalten), rechts schon Blau.
    expect(near(pixel(out, 56, 40, 180), [255, 0, 0])).toBe(true)
    expect(near(pixel(out, 56, 600, 180), [0, 0, 255])).toBe(true)
    expect(near(pixel(out, 70, 40, 180), [0, 0, 255])).toBe(true)

    const part = render(doc, 'slide-part.mp4', { start: s(2.2), end: s(3) })
    expect(frames(part)).toBe('20')
    expect(near(pixel(part, 1, 40, 180), [255, 0, 0])).toBe(true)
    expect(near(pixel(part, 1, 600, 180), [0, 0, 255])).toBe(true)
    expect(near(pixel(part, 15, 40, 180), [0, 0, 255])).toBe(true)
  }, 120_000)

  it('auf einer oberen Spur wird durchsichtig geblendet', () => {
    const raw = rawDoc({ preset: 'fade', duration: s(1) }) as { tracks: unknown[] }
    // Darunter: Rot über die ganze Länge; oben nur der blaue Clip ab 2 s.
    const top = raw.tracks[0] as { id: string; clips: unknown[] }
    top.clips = [top.clips[1]]
    raw.tracks.push({
      id: 'V0',
      kind: 'video',
      hidden: false,
      clips: [
        { id: 'u', kind: 'video', asset: 'a', start: 0, duration: s(4), sourceIn: 0, speed: 1 },
      ],
    })
    const out = render(parsed(raw), 'alpha.mp4')
    // Bild 50: Blau noch durchsichtig, Rot scheint durch (kein Grün).
    expect(near(pixel(out, 50, 320, 180), [255, 0, 0], 60)).toBe(true)
    const mix = pixel(out, 56, 320, 180)
    expect(mix[0]).toBeGreaterThan(50)
    expect(mix[2]).toBeGreaterThan(50)
    expect(mix[1]).toBeLessThan(60)
    expect(near(pixel(out, 75, 320, 180), [0, 0, 255])).toBe(true)
  }, 120_000)
})
