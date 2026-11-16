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
import { parseRenderRequest, RENDER_QUALITIES, renderRouter } from '../src/routes/render'

const s = (seconds: number) => Math.round(seconds * 1_000_000)

describe('parseRenderRequest', () => {
  it('nimmt Standardwerte bei fehlenden oder unbekannten Angaben', () => {
    expect(parseRenderRequest(undefined)).toEqual({
      quality: 'standard',
      outputName: 'projekt.mp4',
      normalizeAudio: false,
    })
    expect(parseRenderRequest({ quality: 'ultra', name: 42 })).toEqual({
      quality: 'standard',
      outputName: 'projekt.mp4',
      normalizeAudio: false,
    })
    expect(parseRenderRequest({ quality: 'constructor' }).quality).toBe('standard')
  })

  it('übernimmt Qualität und bereinigt den Namen', () => {
    expect(parseRenderRequest({ quality: 'high', name: '../Mein Film: 1.mov' })).toEqual({
      quality: 'high',
      outputName: 'Mein Film 1.mp4',
      normalizeAudio: false,
    })
    expect(parseRenderRequest({ normalizeAudio: true }).normalizeAudio).toBe(true)
    expect(parseRenderRequest({ normalizeAudio: 'ja' }).normalizeAudio).toBe(false)
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
})
