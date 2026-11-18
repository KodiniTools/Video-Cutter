import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { config } from '../src/config'
import {
  buildSpeechRequest,
  clearVoiceCache,
  elevenlabsHttpError,
  listVoices,
  parseVoiceList,
  parseVoiceSettings,
  synthesizeSpeech,
} from '../src/lib/elevenlabs'
import { cleanScript } from '../src/lib/claude'
import { parseScriptRequest, parseVoiceOverRequest, voiceOverName } from '../src/routes/ai'
import { SERVER_FEATURES } from '../src/routes/cut'
import { ValidationError } from '../src/lib/validate'

const cfg = config as unknown as Record<string, unknown>

describe('Hilfsfunktionen KI-Sprecher', () => {
  it('Stimmenliste: gültige Einträge, Beschreibung aus Labels, nächste Seite', () => {
    const r = parseVoiceList({
      voices: [
        {
          voice_id: 'abc123',
          name: ' Rachel ',
          category: 'premade',
          labels: { gender: 'female', accent: 'american', use_case: 'narration' },
          preview_url: 'https://storage.example/rachel.mp3',
        },
        { voice_id: 'bad id!', name: 'x' },
        { voice_id: 'def456', description: 'Ruhig', preview_url: 'http://unsicher' },
      ],
      has_more: true,
      next_page_token: 'p2',
    })
    expect(r.voices).toEqual([
      {
        id: 'abc123',
        name: 'Rachel',
        category: 'premade',
        description: 'female, american, narration',
        previewUrl: 'https://storage.example/rachel.mp3',
      },
      { id: 'def456', name: 'def456', category: '', description: 'Ruhig', previewUrl: '' },
    ])
    expect(r.next).toBe('p2')
    expect(parseVoiceList(null)).toEqual({ voices: [], next: null })
  })

  it('Einstellungen werden begrenzt', () => {
    expect(parseVoiceSettings({})).toEqual({ speed: 1, stability: 0.5 })
    expect(parseVoiceSettings({ speed: 3, stability: -1 })).toEqual({ speed: 1.2, stability: 0 })
    expect(parseVoiceSettings({ speed: 0.85, stability: 0.333 })).toEqual({
      speed: 0.85,
      stability: 0.33,
    })
  })

  it('Request-Body', () => {
    expect(buildSpeechRequest('Hallo', { speed: 1.1, stability: 0.4 }, 'm1')).toEqual({
      text: 'Hallo',
      model_id: 'm1',
      voice_settings: { stability: 0.4, similarity_boost: 0.75, speed: 1.1 },
    })
  })

  it('Fehlermeldungen', () => {
    expect(elevenlabsHttpError(401, { detail: { status: 'invalid_api_key' } }).message).toMatch(
      /ELEVENLABS_API_KEY/,
    )
    expect(
      elevenlabsHttpError(401, { detail: { status: 'quota_exceeded', message: 'x' } }).message,
    ).toMatch(/Kontingent/)
    expect(
      elevenlabsHttpError(401, { detail: { status: 'missing_permissions', message: 'y' } }).message,
    ).toMatch(/Berechtigung/)
    expect(elevenlabsHttpError(404, {}).message).toMatch(/Stimme/)
    expect(elevenlabsHttpError(429, {}).message).toMatch(/429/)
    expect(elevenlabsHttpError(422, { detail: [{ msg: 'text too long' }] }).message).toMatch(
      /422.*text too long/,
    )
  })

  it('Sprechertext bereinigen', () => {
    expect(cleanScript({ text: 'Erster Satz.\nweiter\\n\\nZweiter  Absatz.\u0007' })).toBe(
      'Erster Satz. weiter\n\nZweiter Absatz.',
    )
    expect(() => cleanScript({ text: '  ' })).toThrow(/keinen Text/)
    expect(cleanScript({ text: 'Eins. Zwei. Drei drei drei.' }, 18)).toBe('Eins. Zwei.')
  })

  it('Anfragen prüfen', () => {
    expect(
      parseScriptRequest({ mode: 'write', idea: ' Intro ', language: 'hr', seconds: 999 }),
    ).toEqual({ mode: 'write', idea: 'Intro', language: 'hr', seconds: 300 })
    expect(parseScriptRequest({ mode: 'translate', text: 'Hallo', language: 'en' })).toEqual({
      mode: 'translate',
      text: 'Hallo',
      language: 'en',
    })
    expect(() => parseScriptRequest({ mode: 'write', idea: 'x', language: 'auto' })).toThrow(
      /Sprache/,
    )
    expect(() => parseScriptRequest({ mode: 'translate', text: ' ', language: 'en' })).toThrow(
      ValidationError,
    )
    expect(() => parseScriptRequest({ mode: 'x', language: 'en' })).toThrow(/Aktion/)

    expect(parseVoiceOverRequest({ text: ' Hallo ', voiceId: 'abc', speed: 1.1 })).toEqual({
      text: 'Hallo',
      voiceId: 'abc',
      settings: { speed: 1.1, stability: 0.5 },
    })
    expect(() => parseVoiceOverRequest({ text: 'a', voiceId: '../x' })).toThrow(/Stimme/)
    expect(() => parseVoiceOverRequest({ text: 'a'.repeat(5001), voiceId: 'a' })).toThrow(/zu lang/)
  })

  it('Dateiname', () => {
    const d = new Date(2026, 10, 18, 9, 5, 7)
    expect(voiceOverName('Rachel / Erzähler', d)).toBe('KI-Sprecher Rachel  Erzähler 09-05-07.mp3')
    expect(voiceOverName(undefined, d)).toBe('KI-Sprecher 09-05-07.mp3')
  })

  it('Feature-Flag', () => {
    expect(SERVER_FEATURES).toContain('aiVoice')
  })
})

describe('ElevenLabs gegen einen Mock-Server', () => {
  let server: http.Server
  const seen: { method: string; url: string; key: string; body: string }[] = []
  const oldBase = cfg.elevenlabsBaseUrl
  const oldKey = process.env.ELEVENLABS_API_KEY

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c: Buffer) => (body += c.toString()))
      req.on('end', () => {
        seen.push({
          method: req.method ?? '',
          url: req.url ?? '',
          key: String(req.headers['xi-api-key'] ?? ''),
          body,
        })
        if (req.url?.startsWith('/v2/voices')) {
          const page2 = req.url.includes('next_page_token=p2')
          res.setHeader('Content-Type', 'application/json')
          res.end(
            JSON.stringify(
              page2
                ? { voices: [{ voice_id: 'a1', name: 'Anna' }], has_more: false }
                : {
                    voices: [{ voice_id: 'z9', name: 'Zoe' }],
                    has_more: true,
                    next_page_token: 'p2',
                  },
            ),
          )
          return
        }
        if (req.url?.startsWith('/v1/text-to-speech/missing')) {
          res.statusCode = 404
          res.end(JSON.stringify({ detail: { status: 'voice_not_found', message: 'nope' } }))
          return
        }
        if (req.url?.startsWith('/v1/text-to-speech/')) {
          res.setHeader('Content-Type', 'audio/mpeg')
          res.end(Buffer.alloc(1000, 7))
          return
        }
        res.statusCode = 404
        res.end('{}')
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    cfg.elevenlabsBaseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
    process.env.ELEVENLABS_API_KEY = 'test-key'
  })

  afterEach(() => {
    seen.length = 0
    clearVoiceCache()
  })

  afterAll(async () => {
    cfg.elevenlabsBaseUrl = oldBase
    if (oldKey === undefined) delete process.env.ELEVENLABS_API_KEY
    else process.env.ELEVENLABS_API_KEY = oldKey
    await new Promise<void>((r) => server.close(() => r()))
  })

  it('listet alle Seiten, sortiert und merkt sich das Ergebnis', async () => {
    const voices = await listVoices(1000)
    expect(voices.map((v) => v.name)).toEqual(['Anna', 'Zoe'])
    expect(seen).toHaveLength(2)
    expect(seen[0].key).toBe('test-key')
    expect(seen[0].url).toContain('page_size=100')
    await listVoices(2000)
    expect(seen).toHaveLength(2)
  })

  it('vertont mit Stimme, Modell und Format', async () => {
    const data = await synthesizeSpeech(
      'Hallo Welt',
      'abc',
      { speed: 1, stability: 0.5 },
      new AbortController().signal,
    )
    expect(data.length).toBe(1000)
    expect(seen[0].method).toBe('POST')
    expect(seen[0].url).toBe('/v1/text-to-speech/abc?output_format=mp3_44100_128')
    expect(JSON.parse(seen[0].body)).toMatchObject({
      text: 'Hallo Welt',
      model_id: config.elevenlabsModel,
    })
  })

  it('unbekannte Stimme -> verständlicher Fehler', async () => {
    await expect(
      synthesizeSpeech('x', 'missing', { speed: 1, stability: 0.5 }, new AbortController().signal),
    ).rejects.toThrow(/Stimme/)
  })
})
