import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { access, mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  buildProxyArgs,
  buildStripArgs,
  DerivedStore,
  partAvailable,
  PeakReducer,
  PEAKS_PER_SECOND,
  proxySize,
  stripLayout,
  type DerivedStatus,
} from '../src/lib/derived'
import { MediaStore } from '../src/lib/media'
import { probeMedia } from '../src/lib/probe'

const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  )

const info = (over = {}) => ({ width: 1920, height: 1080, hasAudio: true, duration: 60, ...over })

describe('stripLayout', () => {
  it('ein Bild je Sekunde bis 200 s, danach größere Abstände', () => {
    expect(stripLayout(info({ duration: 4 }))).toEqual({
      interval: 1,
      count: 4,
      columns: 4,
      tileWidth: 160,
      tileHeight: 90,
    })
    expect(stripLayout(info({ duration: 200 }))).toMatchObject({ interval: 1, count: 200 })
    expect(stripLayout(info({ duration: 201 }))).toMatchObject({ interval: 2, count: 101 })
    expect(stripLayout(info({ duration: 4 * 3600 }))).toMatchObject({
      interval: 72,
      count: 200,
      columns: 10,
    })
    expect(stripLayout(info({ duration: 0.3 }))).toMatchObject({
      interval: 1,
      count: 1,
      columns: 1,
    })
  })

  it('Kachelhöhe folgt dem Seitenverhältnis (gerade, begrenzt)', () => {
    expect(stripLayout(info({ width: 1080, height: 1920 })).tileHeight).toBe(284)
    expect(stripLayout(info({ width: 1000, height: 1000 })).tileHeight).toBe(160)
    expect(stripLayout(info({ width: 4000, height: 400 })).tileHeight).toBe(40)
    expect(stripLayout(info({ width: 0, height: 0 })).tileHeight).toBe(90)
  })
})

describe('FFmpeg-Argumente', () => {
  it('Filmstreifen: Kachelraster passt zur Aufteilung; lange Videos nur Schlüsselbilder', () => {
    const short = buildStripArgs('in.mp4', 'out.jpg', info({ duration: 25 }))
    expect(short).toContain('fps=1/1,scale=160:90,tile=10x3')
    expect(short).not.toContain('-skip_frame')
    const long = buildStripArgs('in.mp4', 'out.jpg', info({ duration: 3600 }))
    expect(long).toContain('fps=1/18,scale=160:90,tile=10x20')
    expect(long.indexOf('-skip_frame')).toBeLessThan(long.indexOf('-i'))
  })

  it('Vorschau-Kopie: höchstens 540 Zeilen, gerade Maße, nie vergrößert', () => {
    expect(proxySize(info())).toEqual({ width: 960, height: 540 })
    expect(proxySize(info({ width: 1080, height: 1920 }))).toEqual({ width: 304, height: 540 })
    expect(proxySize(info({ width: 641, height: 361 }))).toEqual({ width: 640, height: 360 })
    const args = buildProxyArgs('in.mp4', 'out.mp4', info(), 3)
    expect(args).toContain('scale=960:540,format=yuv420p')
    expect(args[args.indexOf('-threads') + 1]).toBe('3')
    // Tonspur ist optional (Videos ohne Ton).
    expect(args).toContain('0:a:0?')
  })

  it('partAvailable: Wellenform nur mit Ton, Bilder nur mit Bild', () => {
    expect(partAvailable('peaks', info({ hasAudio: false }))).toBe(false)
    expect(partAvailable('peaks', info())).toBe(true)
    expect(partAvailable('strip', info({ width: 0, height: 0 }))).toBe(false)
    expect(partAvailable('proxy', info({ duration: 0 }))).toBe(false)
  })
})

describe('PeakReducer', () => {
  const samples = (values: number[]) => {
    const buf = Buffer.alloc(values.length * 2)
    values.forEach((v, i) => buf.writeInt16LE(v, i * 2))
    return buf
  }

  it('nimmt je Abschnitt (160 Werte) den lautesten Wert, auch negativ', () => {
    const r = new PeakReducer()
    r.push(samples([...Array(159).fill(0), 16384, ...Array(159).fill(100), -32768, 8192]))
    expect([...r.finish()]).toEqual([128, 255, 64])
  })

  it('liefert dasselbe, egal wie die Daten zerstückelt ankommen', () => {
    const data = samples(
      Array.from({ length: 1000 }, (_, i) => Math.round(Math.sin(i / 7) * 20000)),
    )
    const whole = new PeakReducer()
    whole.push(data)
    const pieces = new PeakReducer()
    for (let i = 0; i < data.length; i += 3) pieces.push(data.subarray(i, i + 3))
    pieces.push(new Uint8Array(0))
    expect([...pieces.finish()]).toEqual([...whole.finish()])
  })

  it('leere Eingabe ergibt keine Abschnitte', () => {
    expect(new PeakReducer().finish()).toHaveLength(0)
  })
})

describe('DerivedStore mit echtem FFmpeg', () => {
  let dir: string
  let media: MediaStore
  let derived: DerivedStore

  /** 3 s Testbild 320x180; Ton: 1 s laut, dann still. */
  async function addVideo(name: string, audio = true): Promise<string> {
    const file = path.join(dir, name)
    execFileSync('ffmpeg', [
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=3:size=320x180:rate=25',
      ...(audio
        ? ['-f', 'lavfi', '-i', "aevalsrc='if(lt(t,1),0.8*sin(2*PI*440*t),0)':d=3:s=44100"]
        : []),
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      ...(audio ? ['-c:a', 'aac'] : []),
      file,
    ])
    return (await media.add(file, name, await probeMedia(file))).id
  }

  async function waitDone(id: string): Promise<DerivedStatus> {
    for (let i = 0; i < 300; i++) {
      const s = await derived.status(id)
      if (!s) throw new Error('Video weg')
      const states = [s.peaks.state, s.strip.state, s.proxy.state]
      if (!states.some((x) => x === 'queued' || x === 'running')) return s
      await new Promise((r) => setTimeout(r, 50))
    }
    throw new Error('Zeitüberschreitung')
  }

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'derived-spec-'))
    media = new MediaStore(60_000, 1e9)
    derived = new DerivedStore(path.join(dir, 'derived'), media, 60_000)
    await derived.init()
  })
  afterEach(async () => {
    derived.shutdown()
    await media.shutdown()
    await rm(dir, { recursive: true, force: true })
  })

  it('erzeugt Wellenform, Filmstreifen und Vorschau-Kopie auf Abruf', async () => {
    const id = await addVideo('a.mp4')
    expect(await derived.status(id)).toEqual({
      peaks: { state: 'missing' },
      strip: { state: 'missing' },
      proxy: { state: 'missing' },
    })
    expect(await derived.file(id, 'peaks')).toBeNull()

    const started = await derived.ensure(id)
    expect(started?.peaks.state).toBe('queued')
    const done = await waitDone(id)
    expect(done.strip).toEqual({
      state: 'ready',
      interval: 1,
      count: 3,
      columns: 3,
      tileWidth: 160,
      tileHeight: 90,
    })
    expect(done.proxy).toEqual({ state: 'ready', width: 320, height: 180 })
    expect(done.peaks.state).toBe('ready')
    expect(done.peaks.rate).toBe(PEAKS_PER_SECOND)
    // 3 s Ton -> rund 150 Abschnitte (AAC hängt wenige Millisekunden an).
    expect(done.peaks.count).toBeGreaterThanOrEqual(148)
    expect(done.peaks.count).toBeLessThanOrEqual(156)

    const peaks = await readFile((await derived.file(id, 'peaks'))!)
    expect(peaks.length).toBe(done.peaks.count)
    // Erste Sekunde laut (0,8 -> ~204), danach still.
    expect(Math.min(...peaks.subarray(5, 45))).toBeGreaterThan(180)
    expect(Math.max(...peaks.subarray(60, 140))).toBeLessThan(5)

    const strip = await probeMedia((await derived.file(id, 'strip'))!)
    expect([strip.width, strip.height]).toEqual([480, 90])
    const proxy = await probeMedia((await derived.file(id, 'proxy'))!)
    expect(proxy).toMatchObject({ width: 320, height: 180, hasAudio: true })
    expect(proxy.duration).toBeGreaterThan(2.9)
  }, 30_000)

  it('Video ohne Ton: Wellenform nicht verfügbar, Rest entsteht', async () => {
    const id = await addVideo('stumm.mp4', false)
    await derived.ensure(id)
    const done = await waitDone(id)
    expect(done.peaks).toEqual({ state: 'unavailable' })
    expect(done.strip.state).toBe('ready')
    expect(done.proxy.state).toBe('ready')
    expect((await probeMedia((await derived.file(id, 'proxy'))!)).hasAudio).toBe(false)
  }, 30_000)

  it('rechnet nicht doppelt und kennt Fertiges nach einem Neustart', async () => {
    const id = await addVideo('a.mp4')
    await Promise.all([derived.ensure(id), derived.ensure(id)])
    await waitDone(id)
    const proxyFile = (await derived.file(id, 'proxy'))!
    const before = (await readFile(proxyFile)).length

    // „Neustart“: neuer Speicher über demselben Ordner.
    derived.shutdown()
    derived = new DerivedStore(path.join(dir, 'derived'), media, 60_000)
    await derived.init()
    const again = await derived.ensure(id)
    expect([again?.peaks.state, again?.strip.state, again?.proxy.state]).toEqual([
      'ready',
      'ready',
      'ready',
    ])
    expect((await readFile(proxyFile)).length).toBe(before)
  }, 30_000)

  it('löscht Abgeleitetes mit dem Video und räumt beim Start Verwaistes auf', async () => {
    const id = await addVideo('a.mp4')
    await derived.ensure(id)
    await waitDone(id)
    const folder = derived.dir(id)
    expect(await exists(folder)).toBe(true)

    const orphan = path.join(dir, 'derived', '11111111-1111-4111-8111-111111111111')
    await mkdir(orphan, { recursive: true })
    await writeFile(path.join(orphan, 'proxy.mp4'), 'x')
    await derived.init()
    expect(await exists(orphan)).toBe(false)
    expect(await exists(folder)).toBe(true)

    await media.remove(id)
    await new Promise((r) => setTimeout(r, 100))
    expect(await exists(folder)).toBe(false)
    expect(await derived.status(id)).toBeNull()
    expect(await derived.ensure(id)).toBeNull()
    expect(await derived.file(id, 'proxy')).toBeNull()
    expect(await readdir(path.join(dir, 'derived'))).toEqual([])
  }, 30_000)

  it('Löschen während der Berechnung bricht ab und hinterlässt nichts', async () => {
    const id = await addVideo('a.mp4')
    await derived.ensure(id)
    expect(await media.remove(id)).toBe(true)
    for (let i = 0; i < 100 && (await exists(derived.dir(id))); i++)
      await new Promise((r) => setTimeout(r, 50))
    // Sperre freigegeben -> Video und Ordner sind weg.
    for (let i = 0; i < 100 && media.count > 0; i++) await new Promise((r) => setTimeout(r, 50))
    expect(media.count).toBe(0)
    await new Promise((r) => setTimeout(r, 100))
    expect(await exists(derived.dir(id))).toBe(false)
  }, 30_000)

  it('kaputte Datei: Teile melden Fehler, ein neuer Abruf versucht es erneut', async () => {
    const file = path.join(dir, 'kaputt.mp4')
    await writeFile(file, 'kein video')
    const id = (await media.add(file, 'kaputt.mp4', info({ duration: 3 }))).id
    await derived.ensure(id)
    const done = await waitDone(id)
    expect([done.peaks.state, done.strip.state, done.proxy.state]).toEqual([
      'error',
      'error',
      'error',
    ])
    const retry = await derived.ensure(id)
    expect(retry?.peaks.state).toBe('queued')
    await waitDone(id)
  }, 30_000)

  it('unbekannte oder ungültige IDs', async () => {
    expect(await derived.status('nope')).toBeNull()
    expect(await derived.ensure('../../etc')).toBeNull()
    expect(await derived.file('../../etc', 'proxy')).toBeNull()
  })
})
