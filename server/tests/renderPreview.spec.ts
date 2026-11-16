import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import type { RunHandle } from '../src/lib/ffmpeg'
import { parseTimelineDoc, type RenderDoc } from '../src/lib/render/doc'
import {
  PREVIEW_AHEAD,
  PreviewStore,
  isPreviewKey,
  planSegments,
  previewSize,
} from '../src/lib/render/preview'
import { previewRouter, resolvePreviewSources } from '../src/routes/preview'

const s = (seconds: number) => Math.round(seconds * 1_000_000)
const ID_A = '11111111-1111-4111-8111-111111111111'
const ID_B = '22222222-2222-4222-8222-222222222222'

function doc(seconds = 10, over: { fps?: number; start?: number } = {}): RenderDoc {
  const r = parseTimelineDoc({
    version: 2,
    settings: {
      width: 1920,
      height: 1080,
      fps: over.fps ?? 25,
      background: '#000000',
      sampleRate: 48000,
    },
    assets: { [ID_A]: { id: ID_A, kind: 'video', duration: s(600) } },
    tracks: [
      {
        id: 'V1',
        kind: 'video',
        hidden: false,
        clips: [
          {
            id: 'v',
            kind: 'video',
            asset: ID_A,
            start: 0,
            duration: s(seconds),
            sourceIn: s(over.start ?? 0),
            speed: 1,
          },
        ],
      },
    ],
  })
  if (!r.ok) throw new Error(JSON.stringify(r.errors))
  return r.doc
}

describe('previewSize / planSegments', () => {
  it('begrenzt die Höhe auf 540 px mit geraden Maßen und vergrößert nie', () => {
    expect(previewSize({ width: 1920, height: 1080 })).toEqual({ width: 960, height: 540 })
    expect(previewSize({ width: 1626, height: 914 })).toEqual({ width: 960, height: 540 })
    expect(previewSize({ width: 1080, height: 1920 })).toEqual({ width: 302, height: 540 })
    expect(previewSize({ width: 640, height: 360 })).toEqual({ width: 640, height: 360 })
  })

  it('teilt lückenlos in 4-s-Abschnitte auf dem Bildraster', () => {
    expect(planSegments(doc(10))).toEqual([
      { index: 0, start: 0, end: s(4) },
      { index: 1, start: s(4), end: s(8) },
      { index: 2, start: s(8), end: s(10) },
    ])
    const ntsc = planSegments(doc(10, { fps: 29.97 }))
    // 4 s ≈ 120 Bilder zu je 1001/30000 s.
    expect(ntsc[0].end).toBe(4_004_000)
    expect(ntsc.every((r, i) => i === 0 || r.start === ntsc[i - 1].end)).toBe(true)
    expect(planSegments(doc(4))).toHaveLength(1)
  })
})

describe('PreviewStore', () => {
  let dir = ''
  let store: PreviewStore
  /** Gestartete Läufe: von Hand beenden, um Reihenfolge und Abbruch zu prüfen. */
  let runs: Array<{ out: string; finish: (ok?: boolean) => Promise<void>; killed: boolean }>
  const sources = { [ID_A]: { path: '/m/a.mp4', hasAudio: false } }
  const tick = () => new Promise((r) => setTimeout(r, 10))

  const fakeRun = ((args: string[]): RunHandle => {
    let resolve!: () => void
    let reject!: (e: Error) => void
    const promise = new Promise<void>((res, rej) => {
      resolve = res
      reject = rej
    })
    const run = {
      out: args[args.length - 1],
      killed: false,
      finish: async (ok = true) => {
        if (ok) {
          await writeFile(run.out, Buffer.alloc(1000))
          resolve()
        } else reject(new Error('kaputt'))
        await tick()
      },
    }
    runs.push(run)
    return {
      promise,
      kill: () => {
        run.killed = true
        reject(new Error('abgebrochen'))
      },
    }
  }) as never

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'vc-preview-'))
    runs = []
    store = new PreviewStore({ dir, maxBytes: 100_000, concurrent: 1, threads: 2, run: fakeRun })
    await store.init()
  })
  afterEach(async () => {
    await store.shutdown()
    await rm(dir, { recursive: true, force: true })
  })

  it('plant, rendert ab dem Abspielkopf und liefert fertige Abschnitte aus dem Speicher', async () => {
    const plan = store.plan(doc(10), sources, s(5))
    expect(plan).toMatchObject({ width: 960, height: 540, fps: 25, duration: s(10) })
    expect(plan.segments.map((x) => [x.index, x.start, x.duration])).toEqual([
      [0, 0, s(4)],
      [1, s(4), s(4)],
      [2, s(8), s(2)],
    ])
    expect(plan.segments.every((x) => isPreviewKey(x.key))).toBe(true)
    expect(new Set(plan.segments.map((x) => x.key)).size).toBe(3)
    // Abspielkopf bei 5 s: Abschnitt 1 zuerst, Abschnitt 0 erst bei Abruf.
    expect(plan.segments.map((x) => x.state)).toEqual(['queued', 'rendering', 'queued'])
    expect(runs).toHaveLength(1)
    expect(store.file(plan.segments[1].key)).toBeNull()

    await runs[0].finish()
    expect(store.state(plan.segments[1].key)).toBe('ready')
    expect(store.file(plan.segments[1].key)).toBe(path.join(dir, `${plan.segments[1].key}.mp4`))
    expect(runs).toHaveLength(2)
    await runs[1].finish()
    // Abschnitt 0 liegt vor dem Abspielkopf: nicht von selbst gerendert.
    expect(runs).toHaveLength(2)
    expect(store.state(plan.segments[0].key)).toBe('queued')

    const waiting = store.wait(plan.segments[0].key, 5000)
    expect(runs).toHaveLength(3)
    await runs[2].finish()
    expect(await waiting).toBe('ready')

    const again = store.plan(doc(10), sources)
    expect(again.segments.map((x) => x.state)).toEqual(['ready', 'ready', 'ready'])
    expect(again.segments[0].renderMs).toBeGreaterThanOrEqual(0)
    expect(runs).toHaveLength(3)
    expect(store.stats()).toMatchObject({ rendered: 3, cacheFiles: 3, cacheBytes: 3000 })
  })

  it('verwendet unveränderte Abschnitte weiter und bricht überholte ab', async () => {
    const first = store.plan(doc(10), sources)
    await runs[0].finish()
    expect(runs).toHaveLength(2)
    const pending = store.wait(first.segments[2].key, 5000)

    // Clip am Ende gekürzt: Abschnitt 0 und 1 bleiben, Abschnitt 2 ändert sich.
    const second = store.plan(doc(9), sources)
    expect(second.segments[0].key).toBe(first.segments[0].key)
    expect(second.segments[1].key).toBe(first.segments[1].key)
    expect(second.segments[2].key).not.toBe(first.segments[2].key)
    expect(second.segments[0].state).toBe('ready')
    expect(await pending).toBe('gone')
    expect(store.state(first.segments[2].key)).toBeNull()

    // Anderer Quell-Beginn: alles neu, der laufende Abschnitt wird abgebrochen.
    const running = runs[1]
    const third = store.plan(doc(9, { start: 1 }), sources)
    expect(third.segments.map((x) => x.key)).not.toContain(second.segments[1].key)
    expect(running.killed).toBe(true)
    await tick()
    expect(await store.wait(second.segments[1].key, 100)).toBe('gone')
  })

  it('meldet Fehler, hält die Obergrenze des Speichers ein und räumt beim Start auf', async () => {
    store = new PreviewStore({ dir, maxBytes: 2500, concurrent: 1, run: fakeRun })
    await store.init()
    const plan = store.plan(doc(16), sources)
    const failing = store.wait(plan.segments[0].key, 5000)
    await runs[0].finish(false)
    expect(await failing).toBe('error')
    expect(store.plan(doc(16), sources).segments[0]).toMatchObject({ state: 'error' })
    expect((await readdir(dir)).filter((f) => f.endsWith('.part'))).toEqual([])

    // 3 × 1000 Bytes bei 2500 Bytes Obergrenze: der älteste fliegt.
    await runs[1].finish()
    await runs[2].finish()
    await runs[3].finish()
    expect(store.stats()).toMatchObject({ cacheFiles: 2, cacheBytes: 2000 })
    expect(store.state(plan.segments[1].key)).not.toBe('ready')
    expect((await readdir(dir)).sort()).toEqual(
      [`${plan.segments[2].key}.mp4`, `${plan.segments[3].key}.mp4`].sort(),
    )
    expect(await store.wait('0'.repeat(32), 50)).toBe('gone')

    // Neustart: fertige Abschnitte bleiben, Fremdes und Halbfertiges wird gelöscht.
    await store.shutdown()
    await writeFile(path.join(dir, 'x.part'), 'x')
    await writeFile(path.join(dir, 'fremd.txt'), 'x')
    const old = new Date(Date.now() - 60_000)
    await utimes(path.join(dir, `${plan.segments[2].key}.mp4`), old, old)
    store = new PreviewStore({ dir, maxBytes: 1500, concurrent: 1, run: fakeRun })
    await store.init()
    expect(await readdir(dir)).toEqual([`${plan.segments[3].key}.mp4`])
    expect(store.plan(doc(16), sources).segments[3].state).toBe('ready')
  })

  it('reiht höchstens ein Fenster ab dem Abspielkopf ein', () => {
    const long = doc(4 * (PREVIEW_AHEAD + 20))
    const plan = store.plan(long, sources)
    expect(plan.segments).toHaveLength(PREVIEW_AHEAD + 20)
    expect(plan.segments.filter((x) => x.state === 'rendering')).toHaveLength(1)
    expect(runs).toHaveLength(1)
    // Springt der Abspielkopf, rückt das Fenster mit: Der Abschnitt dort kommt als nächster.
    const moved = store.plan(long, sources, s(4 * 40))
    void runs[0].finish()
    return tick().then(() => {
      expect(path.basename(runs[1].out)).toBe(`${moved.segments[40].key}.part`)
    })
  })
})

describe('resolvePreviewSources', () => {
  const lookup = (proxy: string | null) => ({
    get: (id: string) => (id === ID_A ? { path: '/m/a.mp4', info: { hasAudio: true } } : undefined),
    proxy: async () => proxy,
  })

  it('nimmt die Vorschau-Kopie, wenn es sie gibt, sonst das Original', async () => {
    expect(await resolvePreviewSources(doc(), lookup('/d/proxy.mp4'))).toEqual({
      [ID_A]: { path: '/d/proxy.mp4', hasAudio: true },
    })
    expect(await resolvePreviewSources(doc(), lookup(null))).toEqual({
      [ID_A]: { path: '/m/a.mp4', hasAudio: true },
    })
  })

  it('lehnt Dokumente mit fehlenden Videos ab (409)', async () => {
    const d = doc()
    d.assets[ID_B] = { id: ID_B, kind: 'video', duration: s(5) }
    ;(d.tracks[0].clips[0] as { asset: string }).asset = ID_B
    await expect(resolvePreviewSources(d, lookup(null))).rejects.toMatchObject({ statusCode: 409 })
  })
})

describe('Vorschau-Endpunkte', () => {
  let server: Server
  let base = ''
  beforeEach(async () => {
    const app = express()
    app.use('/api', previewRouter)
    server = app.listen(0, '127.0.0.1')
    await new Promise((r) => server.once('listening', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/preview`
  })
  afterEach(() => new Promise((r) => server.close(r)))

  it('lehnt ungültige Dokumente mit Fehlerpfaden ab und kennt fremde Schlüssel nicht', async () => {
    const res = await fetch(`${base}/plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ doc: { version: 1 } }),
    })
    expect(res.status).toBe(422)
    const body = (await res.json()) as { details: Array<{ path: string }> }
    expect(body.details.map((d) => d.path)).toContain('version')

    expect((await fetch(`${base}/segment/${'a'.repeat(32)}`)).status).toBe(404)
    expect((await fetch(`${base}/segment/..%2Fetc`)).status).toBe(404)
    const stats = (await (await fetch(`${base}/stats`)).json()) as { rendered: number }
    expect(stats.rendered).toBe(0)
  })
})

describe('PreviewStore mit echtem FFmpeg', () => {
  let dir = ''
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'vc-preview-real-'))
  })
  afterEach(() => rm(dir, { recursive: true, force: true }))

  it('rendert Abschnitte als fragmentiertes MP4 in Vorschaugröße', async () => {
    const src = path.join(dir, 'a.mp4')
    execFileSync('ffmpeg', [
      ...['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=s=1280x720:r=25:d=6'],
      ...['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=6'],
      ...['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', src],
    ])
    const cache = path.join(dir, 'cache')
    const store = new PreviewStore({ dir: cache, concurrent: 2, threads: 2 })
    await store.init()
    const plan = store.plan(doc(6), { [ID_A]: { path: src, hasAudio: true } })
    expect(plan.segments).toHaveLength(2)
    expect(await store.wait(plan.segments[0].key, 60_000)).toBe('ready')
    expect(await store.wait(plan.segments[1].key, 60_000)).toBe('ready')

    const probe = (file: string, entries: string) =>
      execFileSync('ffprobe', [
        ...['-v', 'error', '-select_streams', 'v:0', '-count_frames'],
        ...['-show_entries', entries, '-of', 'csv=p=0', file],
      ])
        .toString()
        .trim()
    // 1920×1080-Projekt -> 960×540; 4 s und 2 s bei 25 fps.
    expect(probe(store.file(plan.segments[0].key)!, 'stream=width,height,nb_read_frames')).toBe(
      '960,540,100',
    )
    expect(probe(store.file(plan.segments[1].key)!, 'stream=nb_read_frames')).toBe('50')
    expect(store.stats()).toMatchObject({ rendered: 2, cacheFiles: 2 })
    expect(store.stats().speed).toBeGreaterThan(0)
    await store.shutdown()
  }, 120_000)
})
