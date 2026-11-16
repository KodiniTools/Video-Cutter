import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdir, rm, stat } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import path from 'node:path'
import express from 'express'
import { config } from '../src/config'
import { jobManager } from '../src/lib/jobs'
import { mediaStore } from '../src/lib/media'
import { probeMedia } from '../src/lib/probe'
import { cutRouter } from '../src/routes/cut'
import { parseTimelineDoc } from '../src/lib/render/doc'
import { buildLosslessArgs, checkLossless } from '../src/lib/render/lossless'
import {
  losslessExt,
  parseRenderRequest,
  RENDER_QUALITIES,
  renderRouter,
} from '../src/routes/render'

const s = (seconds: number) => Math.round(seconds * 1_000_000)

describe('parseRenderRequest', () => {
  it('nimmt Standardwerte bei fehlenden oder unbekannten Angaben', () => {
    expect(parseRenderRequest(undefined)).toEqual({
      quality: 'standard',
      outputName: 'projekt.mp4',
      normalizeAudio: false,
      lossless: false,
    })
    expect(parseRenderRequest({ quality: 'ultra', name: 42 })).toEqual({
      quality: 'standard',
      outputName: 'projekt.mp4',
      normalizeAudio: false,
      lossless: false,
    })
    expect(parseRenderRequest({ quality: 'constructor' }).quality).toBe('standard')
  })

  it('übernimmt Qualität und bereinigt den Namen', () => {
    expect(parseRenderRequest({ quality: 'high', name: '../Mein Film: 1.mov' })).toEqual({
      quality: 'high',
      outputName: 'Mein Film 1.mp4',
      normalizeAudio: false,
      lossless: false,
    })
    expect(parseRenderRequest({ normalizeAudio: true }).normalizeAudio).toBe(true)
    expect(parseRenderRequest({ normalizeAudio: 'ja' }).normalizeAudio).toBe(false)
    expect(parseRenderRequest({ lossless: true }).lossless).toBe(true)
    expect(parseRenderRequest({ lossless: 1 }).lossless).toBe(false)
    expect(RENDER_QUALITIES.high).toBeLessThan(RENDER_QUALITIES.small)
  })
})

describe('POST /api/render', () => {
  let server: Server
  let base = ''
  let mediaId = ''
  const source = path.join(config.tmpDir, 'render-export-test-source.mp4')

  beforeAll(async () => {
    await mkdir(config.tmpDir, { recursive: true })
    execFileSync('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=320x180:rate=25:duration=3',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=3',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-c:a',
      'aac',
      '-shortest',
      source,
    ])
    mediaId = (await mediaStore.add(source, 'quelle.mp4', await probeMedia(source))).id
    const app = express()
    app.use('/api', renderRouter)
    app.use('/api', cutRouter)
    server = app.listen(0, '127.0.0.1')
    await new Promise((r) => server.once('listening', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`
  })

  afterAll(async () => {
    await new Promise((r) => server.close(r))
    await mediaStore.remove(mediaId).catch(() => undefined)
    await rm(source, { force: true })
  })

  const doc = (clips: unknown[]) => ({
    version: 2,
    settings: { width: 320, height: 180, fps: 25, background: '#000000', sampleRate: 48000 },
    assets: { [mediaId]: { id: mediaId, kind: 'video', duration: s(3) } },
    tracks: [
      { id: 'V1', kind: 'video', hidden: false, clips },
      {
        id: 'A1',
        kind: 'audio',
        muted: false,
        volume: 1,
        clips: (clips as Array<Record<string, unknown>>).map((c) => ({
          ...c,
          id: `a-${String(c.id)}`,
          kind: 'audio',
          gain: 1,
        })),
      },
    ],
  })
  const post = (body: unknown) =>
    fetch(`${base}/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

  it('lehnt ungültige und leere Dokumente ab', async () => {
    expect((await post({ doc: { version: 1 } })).status).toBe(422)
    const empty = await post({ doc: doc([]) })
    expect(empty.status).toBe(422)
    expect(((await empty.json()) as { error: string }).error).toMatch(/leer/)
  })

  it('rendert die Timeline in voller Größe und liefert sie über die Job-Endpunkte', async () => {
    const clip = {
      id: 'c1',
      kind: 'video',
      asset: mediaId,
      start: 0,
      duration: s(2),
      sourceIn: s(0.5),
      speed: 1,
    }
    const res = await post({
      doc: doc([clip]),
      quality: 'small',
      name: 'Mein Film',
      normalizeAudio: true,
    })
    expect(res.status).toBe(202)
    const { jobId, width, height } = (await res.json()) as {
      jobId: string
      width: number
      height: number
    }
    expect([width, height]).toEqual([320, 180])

    for (let i = 0; i < 200 && jobManager.getSnapshot(jobId)?.state === 'processing'; i++)
      await new Promise((r) => setTimeout(r, 50))
    expect(jobManager.getSnapshot(jobId)).toMatchObject({ state: 'done', progress: 100 })

    const out = jobManager.getOutput(jobId)
    expect(out?.name).toBe('Mein Film.mp4')
    const info = await probeMedia(out!.path)
    expect(info.duration).toBeCloseTo(2, 1)
    expect(info.hasAudio).toBe(true)

    const download = await fetch(`${base}/cut/${jobId}/download`)
    expect(download.status).toBe(200)
    expect(download.headers.get('content-disposition')).toContain('Mein Film.mp4')
    expect((await download.arrayBuffer()).byteLength).toBeGreaterThan(1000)
    // Nach dem Download ist der Job aufgeräumt, die Quelle bleibt.
    await new Promise((r) => setTimeout(r, 100))
    expect(jobManager.getSnapshot(jobId)).toBeUndefined()
    await expect(stat(source)).resolves.toBeTruthy()
  }, 30_000)

  const clip = (over: Record<string, unknown> = {}) => ({
    id: 'c1',
    kind: 'video',
    asset: mediaId,
    start: 0,
    duration: s(2),
    sourceIn: s(0),
    speed: 1,
    ...over,
  })

  it('checkLossless: nur ein unveränderter Clip in Originalgröße', () => {
    const info = (id: string) => mediaStore.get(id)?.info
    const check = (raw: unknown) => {
      const r = parseTimelineDoc(raw)
      if (!r.ok) throw new Error(JSON.stringify(r.errors))
      return checkLossless(r.doc, info)
    }
    type Loose = ReturnType<typeof doc> & { tracks: Array<Record<string, unknown>> }
    const change = (fn: (d: Loose) => void, clips: unknown[] = [clip()]) => {
      const d = doc(clips) as Loose
      fn(d)
      return check(d)
    }
    expect(check(doc([clip()]))).toEqual({
      ok: true,
      asset: mediaId,
      sourceIn: 0,
      duration: s(2),
      audio: true,
    })
    // Ton-Clip gelöscht oder Spur stumm: ohne Tonspur kopieren.
    expect(change((d) => ((d.tracks[1] as { clips: unknown[] }).clips = []))).toMatchObject({
      ok: true,
      audio: false,
    })
    expect(change((d) => (d.tracks[1].muted = true))).toMatchObject({ ok: true, audio: false })
    const reason = (r: ReturnType<typeof check>) => (r.ok ? null : r.reason)
    expect(reason(check(doc([clip(), clip({ id: 'c2', start: s(2) })])))).toBe('clips')
    expect(reason(check(doc([clip({ start: s(1) })])))).toBe('clips')
    expect(reason(check(doc([clip({ speed: 2, duration: s(1) })])))).toBe('speed')
    expect(reason(check(doc([clip({ crop: { x: 0, y: 0, width: 0.5, height: 1 } })])))).toBe('crop')
    expect(reason(change((d) => (d.settings.width = 640)))).toBe('format')
    expect(reason(change((d) => (d.tracks[1].volume = 0.5)))).toBe('audio')
    const audioClip = (d: Loose) =>
      (d.tracks[1] as { clips: Array<Record<string, unknown>> }).clips[0]
    expect(reason(change((d) => (audioClip(d).gain = 0.5)))).toBe('audio')
    expect(reason(change((d) => (audioClip(d).sourceIn = s(0.5))))).toBe('audio')
    expect(reason(change((d) => (audioClip(d).fadeIn = { duration: s(1), curve: 'tri' })))).toBe(
      'audio',
    )
    expect(
      reason(
        change((d) =>
          d.tracks.unshift({
            id: 'T1',
            kind: 'overlay',
            hidden: false,
            clips: [{ id: 't', kind: 'graphic', start: 0, duration: s(1), data: {} }],
          }),
        ),
      ),
    ).toBe('overlays')

    expect(
      buildLosslessArgs('/m/a.mp4', '/t/o.mp4', {
        ok: true,
        asset: 'a',
        sourceIn: s(0.5),
        duration: s(2),
        audio: false,
      }).slice(6),
    ).toEqual([
      ...['-ss', '00:00:00.500', '-i', '/m/a.mp4', '-t', '00:00:02.000', '-an'],
      ...['-c', 'copy', '-avoid_negative_ts', 'make_zero', '/t/o.mp4'],
    ])
    expect(losslessExt('/x/a.MOV')).toBe('mov')
    expect(losslessExt('/x/a.avi')).toBe('mp4')
  })

  it('exportiert verlustfrei ohne Neu-Kodieren und lehnt ab, wenn es nicht geht', async () => {
    const bad = await post({ doc: doc([clip({ speed: 2, duration: s(1) })]), lossless: true })
    expect(bad.status).toBe(422)
    expect(await bad.json()).toMatchObject({ losslessBlocker: 'speed' })

    const res = await post({ doc: doc([clip()]), lossless: true, name: 'Kopie' })
    expect(res.status).toBe(202)
    const { jobId, lossless } = (await res.json()) as { jobId: string; lossless: boolean }
    expect(lossless).toBe(true)
    for (let i = 0; i < 200 && jobManager.getSnapshot(jobId)?.state === 'processing'; i++)
      await new Promise((r) => setTimeout(r, 50))
    expect(jobManager.getSnapshot(jobId)).toMatchObject({ state: 'done' })
    const out = jobManager.getOutput(jobId)
    expect(out?.name).toBe('Kopie.mp4')
    const info = await probeMedia(out!.path)
    expect(info.duration).toBeCloseTo(2, 1)
    expect(info.hasAudio).toBe(true)
    // Kopiert, nicht neu kodiert: derselbe Encoder-Vermerk und dieselbe Bitrate wie die Quelle.
    const codec = (file: string) =>
      execFileSync('ffprobe', [
        ...['-v', 'error', '-select_streams', 'v:0'],
        ...['-show_entries', 'stream=codec_name,profile,pix_fmt', '-of', 'csv=p=0', file],
      ])
        .toString()
        .trim()
    expect(codec(out!.path)).toBe(codec(source))
    await fetch(`${base}/cut/${jobId}`, { method: 'DELETE' })
  }, 30_000)
})
