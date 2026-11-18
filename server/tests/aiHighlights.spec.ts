import { describe, it, expect } from 'vitest'
import { buildHighlights } from '../src/lib/claude'
import { parseHighlightRequest } from '../src/routes/ai'
import { SERVER_FEATURES } from '../src/routes/cut'
import { ValidationError } from '../src/lib/validate'

/** Zehn Wörter, je 0,5 s mit 0,5 s Pause: Wort i liegt bei [i, i+0,5]. */
const words = Array.from({ length: 10 }, (_, i) => ({ start: i, end: i + 0.5, text: `w${i}` }))

describe('Highlights', () => {
  it('rechnet Wort-Indizes in Zeiten mit Luft um, höchstens bis zur Mitte der Lücke', () => {
    const r = buildHighlights(
      words,
      {
        highlights: [
          { from: 6, to: 8, title: '  Zweite  Stelle ', reason: 'stark', score: 7 },
          { from: 1, to: 3, title: 'Erste', reason: 'gut', score: 9 },
        ],
      },
      0,
      10,
    )
    expect(r).toEqual([
      { start: 0.8, end: 3.75, title: 'Erste', reason: 'gut', score: 9 },
      { start: 5.8, end: 8.75, title: 'Zweite Stelle', reason: 'stark', score: 7 },
    ])
  })

  it('bleibt im Bereich, verwirft Ungültiges und behält bei Überlappung die bessere', () => {
    const r = buildHighlights(
      words,
      {
        highlights: [
          { from: 0, to: 2, title: 'a', reason: '', score: 3 },
          { from: 2, to: 4, title: 'b', reason: '', score: 8 },
          { from: 5, to: 99, title: 'außerhalb', reason: '', score: 9 },
          { from: 9, to: 9, title: 'Ende', reason: '', score: 42 },
          'kaputt',
        ],
      },
      0,
      9.6,
    )
    expect(r.map((h) => h.title)).toEqual(['b', 'Ende'])
    expect(r[1]).toMatchObject({ start: 8.8, end: 9.6, score: 10 })
  })

  it('kürzt auf die besten Stellen, chronologisch', () => {
    const raw = {
      highlights: words.map((_, i) => ({ from: i, to: i, title: `t${i}`, reason: '', score: i })),
    }
    const r = buildHighlights(words, raw, 0, 10, 3)
    expect(r.map((h) => h.title)).toEqual(['t7', 't8', 't9'])
    expect(buildHighlights(words, null, 0, 10)).toEqual([])
  })

  it('prüft Ziel-Länge und Bereich', () => {
    expect(parseHighlightRequest({}, 120)).toEqual({ target: 45, from: 0, to: 120 })
    expect(parseHighlightRequest({ target: 500, from: 10, to: 999 }, 120)).toEqual({
      target: 90,
      from: 10,
      to: 120,
    })
    expect(parseHighlightRequest({ target: 3, from: -5, to: '30' }, 120)).toEqual({
      target: 15,
      from: 0,
      to: 30,
    })
    expect(() => parseHighlightRequest({ from: 50, to: 50.5 }, 120)).toThrow(ValidationError)
  })

  it('Feature-Flag', () => {
    expect(SERVER_FEATURES).toContain('aiHighlights')
  })
})
