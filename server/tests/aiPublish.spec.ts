import { describe, it, expect } from 'vitest'
import { buildPublishTexts, cleanHashtag } from '../src/lib/claude'
import { parsePublishRequest, timelineWords } from '../src/routes/ai'
import { SERVER_FEATURES } from '../src/routes/cut'
import { ValidationError } from '../src/lib/validate'

const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ID2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

/** Wort i liegt bei [5i, 5i+1] Sekunden. */
const words = Array.from({ length: 20 }, (_, i) => ({
  start: i * 5,
  end: i * 5 + 1,
  text: `w${i}`,
}))

describe('Titel, Beschreibung, Hashtags, Kapitel', () => {
  it('rechnet Kapitel aus Wort-Indizes, erstes ab 0, zu nahe Kapitel fallen weg', () => {
    const r = buildPublishTexts(
      words,
      {
        titles: ['  Ein   Titel ', 'Ein Titel', '', 'Zweiter'],
        description: 'Absatz eins.\r\n\r\n\r\n  Absatz   zwei. ',
        hashtags: ['#Video Schnitt', 'tipps', 'Tipps', '###', 42],
        chapters: [
          { from: 4, title: 'Teil zwei' },
          { from: 1, title: 'Einstieg' },
          { from: 5, title: 'zu nah' },
          { from: 99, title: 'außerhalb' },
          { from: 19, title: 'zu nah am Ende' },
          { from: 10, title: 'Teil drei' },
        ],
      },
      100,
    )
    expect(r.titles).toEqual(['Ein Titel', 'Zweiter'])
    expect(r.description).toBe('Absatz eins.\n\nAbsatz zwei.')
    expect(r.hashtags).toEqual(['#VideoSchnitt', '#tipps'])
    expect(r.chapters).toEqual([
      { at: 0, title: 'Einstieg' },
      { at: 20, title: 'Teil zwei' },
      { at: 50, title: 'Teil drei' },
    ])
  })

  it('liefert Leeres bei kaputter Antwort', () => {
    expect(buildPublishTexts(words, null, 100)).toEqual({
      titles: [],
      description: '',
      hashtags: [],
      chapters: [],
    })
    expect(cleanHashtag('  #a b ')).toBe('#ab')
    expect(cleanHashtag('#')).toBe('')
  })

  it('prüft die Abschnitte', () => {
    const seg = { mediaId: ID, from: 2, to: 12, at: 0, speed: 2 }
    expect(parsePublishRequest({ segments: [seg], target: 'en', duration: 3 })).toEqual({
      segments: [seg],
      target: 'en',
      duration: 5,
    })
    expect(parsePublishRequest({ segments: [seg], target: 'xx' }).target).toBe('original')
    expect(() => parsePublishRequest({ segments: [] })).toThrow(ValidationError)
    expect(() => parsePublishRequest({ segments: [{ ...seg, mediaId: '../x' }] })).toThrow(
      ValidationError,
    )
    expect(() => parsePublishRequest({ segments: [{ ...seg, to: 1 }] })).toThrow(ValidationError)
    expect(() => parsePublishRequest({ segments: [{ ...seg, speed: 0 }] })).toThrow(ValidationError)
  })

  it('legt die Wörter der Abschnitte in Timeline-Zeit, sortiert', () => {
    const t = (list: [number, number, string][]) => ({
      language: 'de',
      words: list.map(([start, end, text]) => ({ start, end, text })),
    })
    const transcripts: Record<string, ReturnType<typeof t>> = {
      [ID]: t([
        [1, 2, 'vorher'],
        [10, 11, 'eins'],
        [12, 13, 'zwei'],
      ]),
      [ID2]: t([[0, 1, 'drei']]),
    }
    const r = timelineWords(
      [
        { mediaId: ID2, from: 0, to: 4, at: 30, speed: 1 },
        { mediaId: ID, from: 10, to: 14, at: 5, speed: 2 },
      ],
      (id) => transcripts[id],
    )
    expect(r).toEqual([
      { start: 5, end: 5.5, text: 'eins' },
      { start: 6, end: 6.5, text: 'zwei' },
      { start: 30, end: 31, text: 'drei' },
    ])
  })

  it('Feature-Flag', () => {
    expect(SERVER_FEATURES).toContain('aiPublish')
  })
})
