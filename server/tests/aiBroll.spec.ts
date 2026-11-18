import { describe, it, expect } from 'vitest'
import { buildBrollSuggestions, MAX_BROLL_DURATION } from '../src/lib/claude'
import { parseBrollRequest } from '../src/routes/ai'
import { SERVER_FEATURES } from '../src/routes/cut'
import { ValidationError } from '../src/lib/validate'

const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

/** Wort i liegt bei [i, i+0.8] Sekunden. */
const words = Array.from({ length: 60 }, (_, i) => ({ start: i, end: i + 0.8, text: `w${i}` }))
const s = (from: number, to: number, extra: Record<string, unknown> = {}) => ({
  from,
  to,
  kind: 'image',
  title: ' Ein  Titel ',
  reason: 'passt',
  prompt: ' Ein Berg im Nebel. ',
  ...extra,
})

describe('Zwischenbilder (B-Roll)', () => {
  it('rechnet Zeiten aus Wort-Indizes und bringt sie auf 2–10 s', () => {
    const r = buildBrollSuggestions(
      words,
      { suggestions: [s(20, 21), s(5, 9, { kind: 'video' }), s(30, 55)] },
      60,
      'auto',
    )
    expect(r).toEqual([
      {
        at: 5,
        end: 9.8,
        kind: 'video',
        title: 'Ein Titel',
        reason: 'passt',
        prompt: 'Ein Berg im Nebel.',
      },
      expect.objectContaining({ at: 20, end: 22, kind: 'image' }),
      expect.objectContaining({ at: 30, end: 30 + MAX_BROLL_DURATION }),
    ])
  })

  it('verwirft Überlappung, zu nahe Stellen, kaputte Indizes und leere Prompts', () => {
    const r = buildBrollSuggestions(
      words,
      {
        suggestions: [
          s(10, 14),
          s(12, 16),
          s(15, 17),
          s(16, 18),
          s(-1, 3),
          s(40, 99),
          s(42, 44, { prompt: '  ' }),
          s(45, 46, { kind: 'quatsch' }),
        ],
      },
      60,
      'auto',
    )
    expect(r.map((x) => [x.at, x.kind])).toEqual([
      [10, 'image'],
      [16, 'image'],
      [45, 'image'],
    ])
  })

  it('erzwingt die gewählte Art, begrenzt die Anzahl und bleibt im Video', () => {
    const r = buildBrollSuggestions(
      words,
      { suggestions: [s(2, 3), s(10, 11), s(20, 21), s(58, 59)] },
      59.5,
      'video',
      3,
    )
    expect(r).toHaveLength(3)
    expect(r.every((x) => x.kind === 'video')).toBe(true)
    const last = buildBrollSuggestions(words, { suggestions: [s(58, 59)] }, 59.5, 'image')
    expect(last[0].end).toBe(59.5)
    expect(last[0].end - last[0].at).toBeGreaterThanOrEqual(2)
    expect(buildBrollSuggestions(words, null, 60, 'auto')).toEqual([])
  })

  it('prüft die Anfrage', () => {
    const seg = { mediaId: ID, from: 0, to: 30, at: 0, speed: 1 }
    const r = parseBrollRequest({
      segments: [seg],
      duration: 30,
      mode: 'video',
      style: 'photo',
      language: 'en',
      count: 99,
      width: 1080,
      height: 1920,
    })
    expect(r.request).toEqual({
      mode: 'video',
      style: 'photo',
      aspect: '9:16',
      language: 'en',
      count: 12,
    })
    const d = parseBrollRequest({ segments: [seg], width: 1920, height: 1080, mode: 'x' })
    expect(d.request).toMatchObject({ mode: 'auto', style: 'auto', language: 'de', count: 5 })
    expect(() => parseBrollRequest({ segments: [seg] })).toThrow(ValidationError)
    expect(() => parseBrollRequest({ segments: [], width: 100, height: 100 })).toThrow(
      ValidationError,
    )
  })

  it('Feature-Flag', () => {
    expect(SERVER_FEATURES).toContain('aiBroll')
  })
})
