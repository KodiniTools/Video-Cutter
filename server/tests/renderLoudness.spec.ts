import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import path from 'node:path'
import express from 'express'
import { config } from '../src/config'
import { mediaStore } from '../src/lib/media'
import { probeMedia } from '../src/lib/probe'
import {
  DBFS_FLOOR,
  LUFS_FLOOR,
  LoudnessCache,
  audioOnlyDoc,
  parseEbur128,
  type LoudnessResult,
} from '../src/lib/render/loudness'
import { parseTimelineDoc } from '../src/lib/render/doc'
import { qualityRouter } from '../src/routes/quality'

const s = (seconds: number) => Math.round(seconds * 1_000_000)

const SAMPLE_LOG = `
[Parsed_ebur128_4 @ 0x1] t: 0.0999773  TARGET:-23 LUFS    M:-120.7 S:-120.7     I: -70.0 LUFS       LRA:   0.0 LU  FTPK:  -inf  -inf dBFS  TPK:  -inf  -inf dBFS
[Parsed_ebur128_4 @ 0x1] t: 0.199977   TARGET:-23 LUFS    M: -18.4 S:-120.7     I: -18.4 LUFS       LRA:   0.0 LU  FTPK:  -3.1  -0.2 dBFS  TPK:  -3.1  -0.2 dBFS
[Parsed_ebur128_4 @ 0x1] t: 0.3        TARGET:-23 LUFS    M: -17.9 S:-120.7     I: -18.1 LUFS       LRA:   0.0 LU  FTPK:   1.4 dBFS  TPK:   1.4 dBFS
[Parsed_ebur128_4 @ 0x1] Summary:

  Integrated loudness:
    I:         -18.1 LUFS
    Threshold: -28.1 LUFS

  Loudness range:
    LRA:         2.5 LU
    Threshold:   0.0 LUFS

  True peak:
    Peak:        1.4 dBFS
`

describe('parseEbur128', () => {
  it('liest Schritte, größte Kanal-Spitze und Zusammenfassung', () => {
    const r = parseEbur128(SAMPLE_LOG, 0.4)
    expect(r).toEqual({
      integrated: -18.1,
      range: 2.5,
      truePeak: 1.4,
      step: 0.1,
      momentary: [LUFS_FLOOR, -18.4, -17.9, LUFS_FLOOR],
      peak: [DBFS_FLOOR, -0.2, 1.4, DBFS_FLOOR],
    })
  })

  it('ohne Zusammenfassung kein Ergebnis', () => {
    expect(parseEbur128('nichts', 1)).toBeNull()
  })
})

describe('LoudnessCache', () => {
  it('behält die zuletzt benutzten Ergebnisse', () => {
    const c = new LoudnessCache(2)
    const r = { integrated: -20 } as LoudnessResult
    c.set('a', r)
    c.set('b', r)
    c.get('a')
    c.set('c', r)
    expect(c.get('a')).toBe(r)
    expect(c.get('b')).toBeUndefined()
    expect(c.get('c')).toBe(r)
  })
})

describe('POST /api/quality/loudness', () => {
  let server: Server
  let base = ''
  let mediaId = ''
  const source = path.join(config.tmpDir, 'quality-loudness-source.mp4')

  beforeAll(async () => {
    await mkdir(config.tmpDir, { recursive: true })
    // 2 s Ton (laut), danach 2 s Stille; Bild 4 s.
    execFileSync('ffmpeg', [
      ...['-hide_banner', '-loglevel', 'error', '-y'],
      ...['-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=25:duration=4'],
      ...['-f', 'lavfi', '-i', 'sine=frequency=440:duration=2,apad=whole_dur=4'],
      ...['-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', source],
    ])
    mediaId = (await mediaStore.add(source, 'quelle.mp4', await probeMedia(source))).id
    const app = express()
    app.use('/api', qualityRouter)
    server = app.listen(0, '127.0.0.1')
    await new Promise((r) => server.once('listening', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`
  })

  afterAll(async () => {
    await new Promise((r) => server.close(r))
    await mediaStore.remove(mediaId).catch(() => undefined)
    await rm(source, { force: true })
  })

  const doc = (videoLength: number, audioGain: number) => ({
    version: 2,
    settings: { width: 160, height: 90, fps: 25, background: '#000000', sampleRate: 48000 },
    assets: { [mediaId]: { id: mediaId, kind: 'video', duration: s(4) } },
    tracks: [
      {
        id: 'V1',
        kind: 'video',
        hidden: false,
        clips: [
          {
            id: 'v',
            kind: 'video',
            asset: mediaId,
            start: 0,
            duration: s(videoLength),
            sourceIn: 0,
            speed: 1,
          },
        ],
      },
      {
        id: 'A1',
        kind: 'audio',
        muted: false,
        volume: audioGain,
        clips: [
          {
            id: 'a',
            kind: 'audio',
            asset: mediaId,
            start: 0,
            duration: s(3),
            sourceIn: 0,
            speed: 1,
            gain: audioGain,
          },
        ],
      },
    ],
    markers: [{ id: 'm', at: s(1), label: 'Kapitel' }],
  })
  const post = (body: unknown) =>
    fetch(`${base}/quality/loudness`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

  it('audioOnlyDoc lässt nur die Ton-Spuren übrig', () => {
    const parsed = parseTimelineDoc(doc(4, 1))
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors))
    const only = audioOnlyDoc(parsed.doc)
    expect(only.tracks.map((t) => t.kind)).toEqual(['audio'])
    expect(only.markers).toEqual([])
  })

  it('lehnt ungültige Dokumente ab', async () => {
    expect((await post({ doc: { version: 1 } })).status).toBe(422)
  })

  it('misst die Mischung über die ganze Länge (Bild zählt für die Länge)', async () => {
    const res = await post({ doc: doc(4, 1) })
    expect(res.status).toBe(200)
    const r = (await res.json()) as LoudnessResult
    expect(r.step).toBe(0.1)
    expect(r.momentary).toHaveLength(40)
    expect(r.peak).toHaveLength(40)
    // Ton bis 2 s, danach Stille (Quelle) bzw. kein Clip mehr (ab 3 s).
    expect(r.momentary[15]).toBeGreaterThan(-25)
    expect(r.momentary[30]).toBe(LUFS_FLOOR)
    expect(r.momentary[39]).toBe(LUFS_FLOOR)
    expect(r.integrated).toBeGreaterThan(-25)
    expect(r.integrated).toBeLessThan(-10)

    // Verstärkt (Clip × Spur = 16×, Sinus bei -18 dBFS): Spitzen über 0 dBFS.
    const loud = (await (await post({ doc: doc(4, 4) })).json()) as LoudnessResult
    expect(loud.truePeak).toBeGreaterThan(0)
    expect(Math.max(...loud.peak)).toBeGreaterThan(0)

    // Längerer Film (z. B. Text nach dem letzten Clip): Messung reicht bis dahin.
    const longer = (await (await post({ doc: doc(4, 1), duration: s(5) })).json()) as LoudnessResult
    expect(longer.momentary).toHaveLength(50)
  }, 30_000)
})
