import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  buildRenderArgs,
  CompileError,
  compileTimeline,
  fpsRational,
} from '../src/lib/render/compile'
import { docDuration, parseTimelineDoc, type RenderDoc } from '../src/lib/render/doc'

const s = (seconds: number) => Math.round(seconds * 1_000_000)

/** Rohes JSON, das die Tests gezielt verbiegen dürfen. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any

/** Rohes Dokument, wie es der Editor schickt (mit Feldern, die der Server ignoriert). */
function rawDoc(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 2,
    settings: { width: 640, height: 360, fps: 25, background: '#102030', sampleRate: 48000 },
    assets: {
      a: { id: 'a', kind: 'video', name: 'a.mp4', duration: s(4), hasAudio: true },
      b: { id: 'b', kind: 'video', name: 'b.mp4', duration: s(4), hasAudio: false },
    },
    tracks: [
      {
        id: 'V1',
        kind: 'video',
        name: 'V1',
        locked: false,
        hidden: false,
        clips: [
          {
            id: 'v1',
            kind: 'video',
            asset: 'a',
            start: 0,
            duration: s(2),
            sourceIn: s(1),
            speed: 1,
          },
          {
            id: 'v2',
            kind: 'video',
            asset: 'b',
            start: s(3),
            duration: s(1),
            sourceIn: 0,
            speed: 2,
            crop: { x: 0.25, y: 0, width: 0.5, height: 1 },
          },
        ],
      },
      {
        id: 'A1',
        kind: 'audio',
        name: 'A1',
        locked: false,
        muted: false,
        solo: false,
        volume: 1,
        clips: [
          {
            id: 'a1',
            kind: 'audio',
            asset: 'a',
            start: 0,
            duration: s(2),
            sourceIn: s(1),
            speed: 1,
            gain: 0.5,
            linkGroup: 'g',
          },
        ],
      },
    ],
    markers: [],
    ...over,
  }
}

function parsed(raw: unknown): RenderDoc {
  const r = parseTimelineDoc(raw)
  if (!r.ok) throw new Error(JSON.stringify(r.errors))
  return r.doc
}

const sources = {
  a: { path: '/m/a.mp4', hasAudio: true },
  b: { path: '/m/b.mp4', hasAudio: false },
}

describe('parseTimelineDoc', () => {
  it('nimmt ein gültiges Dokument an und behält nur bekannte Felder', () => {
    const doc = parsed(rawDoc())
    expect(docDuration(doc)).toBe(s(4))
    expect(doc.tracks[0].clips[0]).toEqual({
      id: 'v1',
      kind: 'video',
      asset: 'a',
      start: 0,
      duration: s(2),
      sourceIn: s(1),
      speed: 1,
      crop: null,
    })
    expect(doc.assets.a).toEqual({ id: 'a', kind: 'video', duration: s(4) })
    expect(doc.tracks[1]).toMatchObject({ kind: 'audio', muted: false, volume: 1 })
  })

  const broken: Array<[string, (d: Loose) => void, string]> = [
    ['falsche Version', (d) => (d.version = 1), 'version'],
    ['ungerade Breite', (d) => (d.settings.width = 641), 'settings.width'],
    ['Bildrate 0', (d) => (d.settings.fps = 0), 'settings.fps'],
    ['Farbe als Wort', (d) => (d.settings.background = 'red'), 'settings.background'],
    [
      'Filter im Farbwert',
      (d) => (d.settings.background = '#000000,drawtext'),
      'settings.background',
    ],
    ['unbekanntes Medium', (d) => (d.tracks[0].clips[0].asset = 'x'), 'tracks[0].clips[0].asset'],
    ['Kommazahl als Zeit', (d) => (d.tracks[0].clips[0].start = 0.5), 'tracks[0].clips[0].start'],
    ['negative Zeit', (d) => (d.tracks[0].clips[0].sourceIn = -1), 'tracks[0].clips[0].sourceIn'],
    ['zu kurzer Clip', (d) => (d.tracks[0].clips[0].duration = 10), 'tracks[0].clips[0].duration'],
    ['Tempo außerhalb', (d) => (d.tracks[0].clips[0].speed = 8), 'tracks[0].clips[0].speed'],
    ['über die Quelle hinaus', (d) => (d.tracks[0].clips[0].sourceIn = s(3)), 'tracks[0].clips[0]'],
    ['Zuschnitt außerhalb', (d) => (d.tracks[0].clips[1].crop.x = 0.8), 'tracks[0].clips[1].crop'],
    ['Überlappung', (d) => (d.tracks[0].clips[1].start = s(1)), 'tracks[0].clips'],
    [
      'Ton-Clip auf Video-Spur',
      (d) => (d.tracks[0].clips[0].kind = 'audio'),
      'tracks[0].clips[0].kind',
    ],
    ['doppelte ID', (d) => (d.tracks[1].clips[0].id = 'v1'), 'tracks[1].clips[0].id'],
    ['Lautstärke zu hoch', (d) => (d.tracks[1].clips[0].gain = 9), 'tracks[1].clips[0].gain'],
    ['Spur-Lautstärke fehlt', (d) => delete d.tracks[1].volume, 'tracks[1].volume'],
    ['unbekannte Spur-Art', (d) => (d.tracks[1].kind = 'midi'), 'tracks[1].kind'],
  ]
  it.each(broken)('lehnt ab: %s', (_name, mutate, where) => {
    const raw = rawDoc()
    mutate(raw)
    const r = parseTimelineDoc(raw)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.map((e) => e.path)).toContain(where)
  })

  it('lehnt Nicht-Objekte ab und hält die Grenzen ein', () => {
    expect(parseTimelineDoc(null).ok).toBe(false)
    expect(parseTimelineDoc('{}').ok).toBe(false)
    const limits = { maxTracks: 1, maxClips: 500, maxDuration: s(100), maxSide: 3840 }
    expect(parseTimelineDoc(rawDoc(), limits)).toMatchObject({
      ok: false,
      errors: [{ path: 'tracks' }],
    })
    const few = { maxTracks: 16, maxClips: 2, maxDuration: s(100), maxSide: 3840 }
    expect(parseTimelineDoc(rawDoc(), few)).toMatchObject({
      ok: false,
      errors: [{ path: 'tracks' }],
    })
    const short = { maxTracks: 16, maxClips: 500, maxDuration: s(3), maxSide: 3840 }
    expect(parseTimelineDoc(rawDoc(), short).ok).toBe(false)
    const small = { maxTracks: 16, maxClips: 500, maxDuration: s(100), maxSide: 320 }
    expect(parseTimelineDoc(rawDoc(), small).ok).toBe(false)
  })

  it('sammelt höchstens 20 Fehler', () => {
    const raw = rawDoc()
    const track = (raw.tracks as Loose[])[0]
    track.clips = Array.from({ length: 50 }, (_, i) => ({ id: `c${i}`, kind: 'video', start: -1 }))
    const r = parseTimelineDoc(raw)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors).toHaveLength(20)
  })
})

describe('fpsRational', () => {
  it('erkennt ganze und NTSC-Raten', () => {
    expect(fpsRational(25)).toEqual({ num: 25, den: 1 })
    expect(fpsRational(29.97)).toEqual({ num: 30000, den: 1001 })
    expect(fpsRational(23.976)).toEqual({ num: 24000, den: 1001 })
    expect(fpsRational(12.5)).toEqual({ num: 12500, den: 1000 })
  })
})

describe('compileTimeline', () => {
  it('verkettet Clips und Lücken je Spur (Snapshot der Argumente)', () => {
    const c = compileTimeline(parsed(rawDoc()), { sources })
    expect(c).toMatchObject({ frames: 100, duration: 4, width: 640, height: 360, fps: '25' })
    expect(c.inputs).toEqual([
      ...['-an', '-ss', '1.000000', '-t', '2.500000', '-i', '/m/a.mp4'],
      ...['-an', '-ss', '0.000000', '-t', '2.500000', '-i', '/m/b.mp4'],
      ...['-vn', '-ss', '1.000000', '-t', '2.500000', '-i', '/m/a.mp4'],
    ])
    expect(c.filter.split(';')).toEqual([
      '[0:v:0]setpts=PTS-STARTPTS,fps=25,scale=640:360:force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuv420p,pad=640:360:(ow-iw)/2:(oh-ih)/2:color=0x102030,setsar=1,tpad=stop_mode=clone:stop_duration=2.000000,trim=end_frame=50,setpts=PTS-STARTPTS[v0]',
      'color=c=0x102030:s=640x360:r=25,format=yuv420p,trim=end_frame=25[v1]',
      '[1:v:0]setpts=(PTS-STARTPTS)/2,fps=25,crop=trunc(iw*0.5/2)*2:trunc(ih*1/2)*2:trunc(iw*0.25/2)*2:trunc(ih*0/2)*2,scale=640:360:force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuv420p,pad=640:360:(ow-iw)/2:(oh-ih)/2:color=0x102030,setsar=1,tpad=stop_mode=clone:stop_duration=1.000000,trim=end_frame=25,setpts=PTS-STARTPTS[v2]',
      '[v0][v1][v2]concat=n=3:v=1:a=0[layer3]',
      '[layer3]format=yuv420p[vout]',
      '[2:a:0]asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=0.5,apad,atrim=duration=2.000000,asetpts=PTS-STARTPTS[a4]',
      'anullsrc=r=48000:cl=stereo,atrim=duration=2.000000[a5]',
      '[a4][a5]concat=n=2:v=0:a=1[track6]',
      '[track6]anull[aout]',
    ])
  })

  it('rendert einen Abschnitt: Clips werden am Rand beschnitten, die Quelle rückt mit', () => {
    const c = compileTimeline(parsed(rawDoc()), {
      sources,
      range: { start: s(1.6), end: s(3.6) },
      size: { width: 320, height: 180 },
    })
    expect(c).toMatchObject({ frames: 50, duration: 2, width: 320, height: 180 })
    // v1 ab 1,6 s: Quelle 1 s + 1,6 s; v2 mit Tempo 2: 0,6 s Timeline = 1,2 s Quelle.
    expect(c.inputs.slice(0, 14)).toEqual([
      ...['-an', '-ss', '2.600000', '-t', '0.900000', '-i', '/m/a.mp4'],
      ...['-an', '-ss', '0.000000', '-t', '1.700000', '-i', '/m/b.mp4'],
    ])
    expect(c.filter).toContain('trim=end_frame=10,setpts=PTS-STARTPTS[v0]')
    expect(c.filter).toContain('trim=end_frame=25[v1]')
    expect(c.filter).toContain('trim=end_frame=15,setpts=PTS-STARTPTS[v2]')
    expect(c.filter).toContain('scale=320:180:')
  })

  it('legt höhere Spuren durchsichtig über die unterste und lässt ausgeblendete weg', () => {
    const raw = rawDoc()
    const tracks = raw.tracks as Loose[]
    tracks.unshift({
      id: 'V2',
      kind: 'video',
      hidden: false,
      clips: [
        {
          id: 'top',
          kind: 'video',
          asset: 'b',
          start: s(1),
          duration: s(1),
          sourceIn: 0,
          speed: 1,
        },
      ],
    })
    const c = compileTimeline(parsed(raw), { sources })
    expect(c.filter).toContain('color=c=black@0:s=640x360:r=25,format=yuva420p,trim=end_frame=25')
    expect(c.filter).toContain('format=yuva420p,pad=640:360:(ow-iw)/2:(oh-ih)/2:color=black@0')
    expect(c.filter).toMatch(
      /\[layer\d+\]\[layer\d+\]overlay=format=auto:eof_action=pass\[mix\d+\]/,
    )
    expect(c.filter.match(/overlay=/g)).toHaveLength(1)

    tracks[0].hidden = true
    expect(compileTimeline(parsed(raw), { sources }).filter).not.toContain('overlay=')
  })

  it('mischt Ton-Spuren, beachtet Stumm/Solo/Lautstärke und Quellen ohne Ton', () => {
    const raw = rawDoc()
    const tracks = raw.tracks as Loose[]
    tracks.push({
      id: 'A2',
      kind: 'audio',
      muted: false,
      solo: false,
      volume: 0.5,
      clips: [
        {
          id: 'a2',
          kind: 'audio',
          asset: 'a',
          start: s(1),
          duration: s(1),
          sourceIn: 0,
          speed: 0.25,
          gain: 1,
        },
        {
          id: 'a3',
          kind: 'audio',
          asset: 'b',
          start: s(3),
          duration: s(1),
          sourceIn: 0,
          speed: 1,
          gain: 1,
        },
      ],
    })
    let c = compileTimeline(parsed(raw), { sources })
    expect(c.filter).toContain('amix=inputs=2:duration=longest:normalize=0[aout]')
    expect(c.filter).toContain('atempo=0.5,atempo=0.500000,aresample=48000')
    // b hat keine Tonspur: kein Eingang dafür, nur Stille.
    expect(c.inputs.filter((x) => x === '-vn')).toHaveLength(2)

    tracks[1].muted = true
    c = compileTimeline(parsed(raw), { sources })
    expect(c.filter).not.toContain('amix')
    expect(c.filter).toContain('volume=0.5')

    tracks[1].solo = true
    c = compileTimeline(parsed(raw), { sources })
    expect(c.inputs.filter((x) => x === '-vn')).toHaveLength(1)

    tracks[1].solo = false
    tracks[2].muted = true
    c = compileTimeline(parsed(raw), { sources })
    expect(c.filter).toContain('anullsrc=r=48000:cl=stereo,atrim=duration=4.000000[aout]')
  })

  it('gleicht auf Wunsch die Lautstärke des fertigen Tons an', () => {
    const doc = parsed(rawDoc())
    const plain = compileTimeline(doc, { sources })
    const c = compileTimeline(doc, { sources, normalizeAudio: true })
    expect(plain.filter).not.toContain('loudnorm')
    expect(
      c.filter.endsWith(
        '[amixed];[amixed]loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000,atrim=duration=4.000000[aout]',
      ),
    ).toBe(true)
    expect(c.filter.match(/\[aout\]/g)).toHaveLength(1)
    // Ohne Ton bleibt es bei Stille.
    const silent = compileTimeline(doc, {
      sources,
      range: { start: s(2), end: s(3) },
      normalizeAudio: true,
    })
    expect(silent.filter).not.toContain('loudnorm')
  })

  it('liefert für leere Bereiche Hintergrund und Stille, wirft bei leerem Abschnitt', () => {
    const doc = parsed(rawDoc())
    const c = compileTimeline(doc, { sources, range: { start: s(2), end: s(3) } })
    expect(c.inputs).toEqual([])
    expect(c.filter).toBe(
      'color=c=0x102030:s=640x360:r=25,format=yuv420p,trim=end_frame=25[vout];' +
        'anullsrc=r=48000:cl=stereo,atrim=duration=1.000000[aout]',
    )
    expect(() => compileTimeline(doc, { sources, range: { start: s(2), end: s(2) } })).toThrow(
      CompileError,
    )
    expect(() => compileTimeline(doc, { sources: { a: sources.a } })).toThrow(/Quelle/)
  })

  it('baut vollständige Encoder-Argumente', () => {
    const c = compileTimeline(parsed(rawDoc()), { sources })
    const args = buildRenderArgs(c, {
      output: '/o.mp4',
      preset: 'veryfast',
      crf: 28,
      gop: 25,
      threads: 2,
    })
    expect(args.slice(0, 6)).toEqual([
      '-hide_banner',
      '-nostdin',
      '-y',
      '-progress',
      'pipe:1',
      '-nostats',
    ])
    expect(args.slice(args.indexOf('-map'), args.indexOf('-map') + 4)).toEqual([
      '-map',
      '[vout]',
      '-map',
      '[aout]',
    ])
    expect(args.join(' ')).toContain('-g 25 -keyint_min 25 -sc_threshold 0')
    expect(args.join(' ')).toContain('-threads 2 -t 4.000000 -movflags +faststart -f mp4 /o.mp4')
  })

  it('legt für nahtlose Abschnitte das erste Bild auf Zeit 0 (keine B-Bilder, kein Verschieben)', () => {
    const c = compileTimeline(parsed(rawDoc()), { sources })
    const enc = { output: '/o.mp4', preset: 'veryfast', crf: 28, gop: 25, threads: 2 }
    expect(buildRenderArgs(c, enc).join(' ')).not.toContain('-bf 0')
    expect(buildRenderArgs(c, { ...enc, seamless: true }).join(' ')).toContain(
      '-pix_fmt yuv420p -bf 0 -avoid_negative_ts disabled',
    )
  })
})

describe('compileTimeline mit echtem FFmpeg', () => {
  let dir = ''
  const probe = (file: string, entries: string, stream: string) =>
    execFileSync('ffprobe', [
      ...['-v', 'error', '-select_streams', stream, '-count_frames'],
      ...['-show_entries', entries, '-of', 'default=nw=1:nk=1', file],
    ])
      .toString()
      .trim()
      .split('\n')
  /** Mittlere Farbe (R, G, B) eines Bildausschnitts zur Zeit `t`. */
  const pixel = (file: string, t: number, x: number, y: number) => {
    const raw = execFileSync('ffmpeg', [
      ...['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1'],
      ...['-vf', `crop=8:8:${x}:${y},scale=1:1`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
    ])
    return [raw[0], raw[1], raw[2]]
  }
  /** Mittlere Lautstärke in dB im Bereich [from, from+len). */
  const volume = (file: string, from: number, len: number) => {
    const r = spawnSync(
      'ffmpeg',
      [
        ...['-hide_banner', '-ss', String(from), '-t', String(len), '-i', file],
        ...['-af', 'volumedetect', '-vn', '-f', 'null', '-'],
      ],
      { encoding: 'utf8' },
    )
    return Number(/mean_volume: (-?[\d.]+) dB/.exec(r.stderr)?.[1] ?? Number.NaN)
  }

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'vc-render-'))
    // a: rot mit 440-Hz-Ton, 640×360; b: blau ohne Ton, hochkant 360×640.
    execFileSync('ffmpeg', [
      ...['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=640x360:r=25:d=4'],
      ...['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=4'],
      ...['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac'],
      path.join(dir, 'a.mp4'),
    ])
    execFileSync('ffmpeg', [
      ...['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=360x640:r=30:d=4'],
      ...['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'],
      path.join(dir, 'b.mp4'),
    ])
  }, 60_000)
  afterAll(() => rm(dir, { recursive: true, force: true }))

  it('rendert zwei Spuren bildgenau: Länge, Hintergrund, Überlagerung, Ton', () => {
    const raw = rawDoc()
    const tracks = raw.tracks as Loose[]
    // Obere Spur: blaues Hochkant-Video von 0,5 s bis 1,5 s über dem roten.
    tracks.unshift({
      id: 'V2',
      kind: 'video',
      hidden: false,
      clips: [
        {
          id: 'top',
          kind: 'video',
          asset: 'b',
          start: s(0.5),
          duration: s(1),
          sourceIn: 0,
          speed: 1,
        },
      ],
    })
    // Zuschnitt beim zweiten Clip weglassen: ganzes Hochkant-Bild, links/rechts Hintergrund.
    delete tracks[1].clips[1].crop
    const real = {
      a: { path: path.join(dir, 'a.mp4'), hasAudio: true },
      b: { path: path.join(dir, 'b.mp4'), hasAudio: false },
    }
    const out = path.join(dir, 'out.mp4')
    const c = compileTimeline(parsed(raw), { sources: real })
    execFileSync('ffmpeg', buildRenderArgs(c, { output: out, preset: 'ultrafast', crf: 20 }), {
      stdio: 'ignore',
    })

    expect(probe(out, 'stream=nb_read_frames', 'v:0')).toEqual(['100'])
    expect(Number(probe(out, 'stream=duration', 'a:0')[0])).toBeCloseTo(4, 1)

    const near = (rgb: number[], want: number[]) => rgb.every((v, i) => Math.abs(v - want[i]) <= 40)
    // 0,2 s: nur V1 (rot). 1,0 s: Mitte blau (V2), Rand weiter rot (V2 ist dort durchsichtig).
    expect(near(pixel(out, 0.2, 316, 176), [255, 0, 0])).toBe(true)
    expect(near(pixel(out, 1.0, 316, 176), [0, 0, 255])).toBe(true)
    expect(near(pixel(out, 1.0, 20, 176), [255, 0, 0])).toBe(true)
    // 1,8 s: V2 vorbei, wieder rot. 2,5 s: Lücke = Hintergrund #102030.
    expect(near(pixel(out, 1.8, 316, 176), [255, 0, 0])).toBe(true)
    expect(near(pixel(out, 2.5, 316, 176), [16, 32, 48])).toBe(true)
    // 3,5 s: blaues Hochkant-Video mittig, daneben Hintergrund.
    expect(near(pixel(out, 3.5, 316, 176), [0, 0, 255])).toBe(true)
    expect(near(pixel(out, 3.5, 20, 176), [16, 32, 48])).toBe(true)
    // Ton: 0–2 s Sinus mit halber Lautstärke, danach Stille.
    expect(volume(out, 0.2, 1.5)).toBeGreaterThan(-40)
    expect(volume(out, 2.3, 1.5)).toBeLessThan(-70)
  }, 120_000)
})
