import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { config } from '../src/config'
import {
  buildVideoRequest,
  clampVideoDuration,
  extractVideo,
  fileIdOf,
  generateVideo,
  videoAspectFor,
  videoHttpError,
} from '../src/lib/geminiVideo'
import { AiJobManager } from '../src/lib/aiJobs'
import { aiVideoName } from '../src/routes/ai'

const MP4 = Buffer.from('fake-mp4-data')
const cfg = config as unknown as Record<string, unknown>

describe('Hilfsfunktionen', () => {
  it('Seitenverhältnis und Dauer', () => {
    expect(videoAspectFor(1920, 1080)).toBe('16:9')
    expect(videoAspectFor(1080, 1920)).toBe('9:16')
    expect(videoAspectFor(1080, 1080)).toBe('16:9')
    expect(clampVideoDuration(8)).toBe(8)
    expect(clampVideoDuration(1)).toBe(3)
    expect(clampVideoDuration(99)).toBe(15)
    expect(clampVideoDuration('x')).toBe(8)
    expect(aiVideoName(7.96)).toBe('KI-Video_8s.mp4')
  })

  it('Request: Video als Datei-Verweis, Dauer als „Ns“', () => {
    expect(buildVideoRequest('Berg', '9:16', 6)).toEqual({
      model: config.geminiVideoModel,
      input: 'Berg',
      response_format: { type: 'video', aspect_ratio: '9:16', delivery: 'uri', duration: '6s' },
    })
  })

  it('fileIdOf: Kurzform und volle URL', () => {
    expect(fileIdOf('files/abc-123')).toBe('abc-123')
    expect(
      fileIdOf('https://generativelanguage.googleapis.com/v1beta/files/xyz_9:download?alt=media'),
    ).toBe('xyz_9')
    expect(fileIdOf('https://example.com/video.mp4')).toBeNull()
  })

  it('extractVideo: inline, Verweis (steps und output_video), Fehler', () => {
    const inline = {
      status: 'completed',
      steps: [
        { type: 'thought' },
        {
          type: 'model_output',
          content: [{ type: 'video', mime_type: 'video/mp4', data: MP4.toString('base64') }],
        },
      ],
    }
    expect(extractVideo(inline)).toEqual({ kind: 'inline', data: MP4 })
    expect(
      extractVideo({
        steps: [{ type: 'model_output', content: [{ type: 'video', uri: 'files/a1' }] }],
      }),
    ).toEqual({ kind: 'uri', uri: 'files/a1' })
    expect(extractVideo({ output_video: { uri: 'files/b2' } })).toEqual({
      kind: 'uri',
      uri: 'files/b2',
    })
    expect(() => extractVideo({ status: 'failed', error: { message: 'quota' } })).toThrow(/quota/)
    expect(() => extractVideo({ status: 'in_progress' })).toThrow(/in_progress/)
    expect(() => extractVideo({ status: 'completed', steps: [] })).toThrow(/kein Video/)
  })

  it('videoHttpError übersetzt typische Fehler', () => {
    expect(videoHttpError(404, {}).message).toMatch(/GEMINI_VIDEO_MODEL/)
    expect(videoHttpError(429, {}).message).toMatch(/429/)
    expect(videoHttpError(400, { error: { message: 'API key not valid' } }).message).toMatch(
      /GEMINI_API_KEY/,
    )
    expect(videoHttpError(400, { error: { message: 'bad duration' } }).message).toMatch(
      /400.*bad duration/,
    )
  })

  it('höchstens ein Video-Job gleichzeitig', () => {
    const m = new AiJobManager()
    m.start('video', () => new Promise<never>(() => {}))
    expect(m.hasCapacity('video')).toBe(false)
    expect(m.hasCapacity('image')).toBe(true)
    m.shutdown()
  })
})

describe('generateVideo gegen einen Test-Server', () => {
  let server: http.Server
  let mode: 'uri' | 'inline' | 'error' = 'uri'
  let polls = 0
  const seen: { url: string; key: string; body: unknown }[] = []
  const oldBase = config.geminiBaseUrl

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let raw = ''
      req.on('data', (c) => (raw += c))
      req.on('end', () => {
        seen.push({
          url: req.url ?? '',
          key: String(req.headers['x-goog-api-key']),
          body: raw ? JSON.parse(raw) : null,
        })
        const json = (code: number, body: unknown) => {
          res.writeHead(code, { 'content-type': 'application/json' })
          res.end(JSON.stringify(body))
        }
        if (req.method === 'POST' && req.url === '/v1beta/interactions') {
          if (mode === 'error') return json(429, { error: { message: 'quota' } })
          const content =
            mode === 'uri'
              ? { type: 'video', mime_type: 'video/mp4', uri: 'files/vid1' }
              : { type: 'video', mime_type: 'video/mp4', data: MP4.toString('base64') }
          return json(200, {
            status: 'completed',
            steps: [{ type: 'model_output', content: [content] }],
          })
        }
        if (req.url === '/v1beta/files/vid1') {
          return json(200, { state: polls++ === 0 ? 'PROCESSING' : 'ACTIVE' })
        }
        if (req.url === '/v1beta/files/vid1:download?alt=media') {
          res.writeHead(200, { 'content-type': 'video/mp4' })
          return res.end(MP4)
        }
        json(404, {})
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    cfg.geminiBaseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1beta`
    process.env.GEMINI_API_KEY = 'test-key'
  })
  afterAll(async () => {
    cfg.geminiBaseUrl = oldBase
    delete process.env.GEMINI_API_KEY
    await new Promise((r) => server.close(r))
  })
  afterEach(() => {
    seen.length = 0
    polls = 0
  })

  it('Datei-Verweis: wartet auf ACTIVE und lädt herunter; Schlüssel nur im Header', async () => {
    mode = 'uri'
    const data = await generateVideo('Berg', '16:9', 8, new AbortController().signal, () => {}, 10)
    expect(data.equals(MP4)).toBe(true)
    expect(seen.map((s) => s.url)).toEqual([
      '/v1beta/interactions',
      '/v1beta/files/vid1',
      '/v1beta/files/vid1',
      '/v1beta/files/vid1:download?alt=media',
    ])
    expect(seen.every((s) => s.key === 'test-key')).toBe(true)
    expect((seen[0].body as { response_format: unknown }).response_format).toMatchObject({
      type: 'video',
      duration: '8s',
    })
  })

  it('inline-Antwort wird direkt verwendet', async () => {
    mode = 'inline'
    const data = await generateVideo('Berg', '16:9', 8, new AbortController().signal, () => {}, 10)
    expect(data.equals(MP4)).toBe(true)
    expect(seen).toHaveLength(1)
  })

  it('HTTP-Fehler und Abbruch ergeben verständliche Meldungen', async () => {
    mode = 'error'
    await expect(
      generateVideo('Berg', '16:9', 8, new AbortController().signal, () => {}, 10),
    ).rejects.toThrow(/429/)
    const c = new AbortController()
    c.abort()
    await expect(generateVideo('Berg', '16:9', 8, c.signal, () => {}, 10)).rejects.toThrow(
      /Abgebrochen/,
    )
  })
})
