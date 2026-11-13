import { describe, it, expect } from 'vitest'
import {
  buildAudioExtractArgs,
  buildWhisperArgs,
  parseWhisperJson,
  type Word,
} from '../src/lib/whisper'
import {
  buildCutSuggestions,
  buildSubtitleCues,
  findPauses,
  formatWords,
  wrapSubtitle,
} from '../src/lib/claude'
import { AiJobManager } from '../src/lib/aiJobs'

const w = (start: number, end: number, text: string): Word => ({ start, end, text })

describe('parseWhisperJson', () => {
  it('liest Wörter in Sekunden, überspringt Steuer-Token, hängt Satzzeichen an', () => {
    const json = JSON.stringify({
      result: { language: 'de' },
      transcription: [
        { offsets: { from: 0, to: 0 }, text: '[_BEG_]' },
        { offsets: { from: 100, to: 400 }, text: ' Hallo' },
        { offsets: { from: 400, to: 450 }, text: ',' },
        { offsets: { from: 500, to: 900 }, text: ' Welt' },
        { offsets: { from: 900, to: 950 }, text: ' ' },
      ],
    })
    expect(parseWhisperJson(json)).toEqual({
      language: 'de',
      words: [w(0.1, 0.45, 'Hallo,'), w(0.5, 0.9, 'Welt')],
    })
  })

  it('wirft bei kaputtem JSON, leeres Ergebnis ohne Einträge', () => {
    expect(() => parseWhisperJson('{')).toThrow(/ungültige/)
    expect(parseWhisperJson('{}')).toEqual({ language: 'auto', words: [] })
  })
})

describe('Prozess-Argumente', () => {
  it('Tonspur als 16-kHz-Mono-WAV', () => {
    const a = buildAudioExtractArgs('/in.mp4', '/x.wav')
    expect(a.join(' ')).toContain('-map 0:a:0 -vn -ac 1 -ar 16000 -c:a pcm_s16le /x.wav')
  })
  it('whisper: Wort-Zeitstempel, JSON-Datei, Sprache', () => {
    const a = buildWhisperArgs('/x.wav', '/out', 'de')
    expect(a).toEqual(expect.arrayContaining(['-ml', '1', '-sow', '-oj', '-pp']))
    expect(a[a.indexOf('-l') + 1]).toBe('de')
    expect(a[a.indexOf('-of') + 1]).toBe('/out')
  })
})

describe('Untertitel aus Claudes Antwort', () => {
  const words = [w(0, 0.4, 'hallo'), w(0.5, 0.9, 'welt'), w(3, 3.5, 'zweiter'), w(3.6, 4, 'satz')]

  it('Zeiten aus Wort-Indizes, Mindestdauer ohne Überlappung', () => {
    const raw = {
      cues: [
        { from: 2, to: 3, text: 'Zweiter Satz.' },
        { from: 0, to: 1, text: 'Hallo Welt!' },
      ],
    }
    const { cues, truncated } = buildSubtitleCues(words, raw, 5, 100)
    expect(truncated).toBe(false)
    expect(cues).toEqual([
      { start: 0, end: 1, text: 'Hallo Welt!' },
      { start: 3, end: 4, text: 'Zweiter Satz.' },
    ])
  })

  it('verwirft ungültige Indizes, begrenzt Anzahl und Videoende', () => {
    const raw = {
      cues: [
        { from: 9, to: 10, text: 'x' },
        { from: 0, to: 0, text: '' },
        { from: 0, to: 1, text: 'A' },
        { from: 2, to: 99, text: 'B' },
      ],
    }
    const r = buildSubtitleCues(words, raw, 3.8, 1)
    expect(r.cues).toEqual([{ start: 0, end: 1, text: 'A' }])
    expect(r.truncated).toBe(true)
    expect(buildSubtitleCues(words, raw, 3.8, 10).cues[1]).toEqual({
      start: 3,
      end: 3.8,
      text: 'B',
    })
    expect(buildSubtitleCues(words, null, 5, 10).cues).toEqual([])
  })

  it('bricht lange Zeilen um, höchstens zwei Zeilen', () => {
    expect(wrapSubtitle('kurz')).toBe('kurz')
    expect(wrapSubtitle('eins zwei drei vier fünf sechs sieben acht neun zehn')).toBe(
      'eins zwei drei vier fünf\nsechs sieben acht neun zehn',
    )
    expect(wrapSubtitle('a\\nb')).toBe('a\nb')
    expect(wrapSubtitle('a\nb\nc').split('\n').length).toBeLessThanOrEqual(2)
  })

  it('Prompt-Format: Index, Zeiten, Wort', () => {
    expect(formatWords([w(1, 1.5, 'Hi')])).toBe('0 1.00-1.50 Hi')
  })
})

describe('Schnittvorschläge', () => {
  const words = [
    w(0.5, 0.8, 'Also'),
    w(0.9, 1.2, 'äh'),
    w(1.3, 1.8, 'heute'),
    w(4.0, 4.5, 'zeige'),
    w(4.6, 5.0, 'ich'),
  ]

  it('Pausen am Anfang, zwischen Wörtern und am Ende', () => {
    const p = findPauses(words, 8, 1)
    expect(p.map((s) => [s.start, s.end])).toEqual([
      [2.05, 3.75],
      [5.25, 8],
    ])
    // Anfang: ab 0 ohne Luft davor; zu kurze Rest-Schnitte entfallen.
    expect(findPauses([w(2, 2.5, 'x')], 0, 1)).toEqual([
      { start: 0, end: 1.75, kind: 'pause', text: '', reason: '' },
    ])
    expect(findPauses(words, 8, 0.4)[0].start).toBe(2.05)
  })

  it('Wort-Indizes -> Zeiten, sortiert, ohne Überlappung, ungültige verworfen', () => {
    const raw = {
      suggestions: [
        { from: 1, to: 1, kind: 'filler', reason: 'Füllwort' },
        { from: 1, to: 2, kind: 'slip', reason: 'überlappt' },
        { from: 4, to: 2, kind: 'filler', reason: 'kaputt' },
        { from: 0, to: 9, kind: 'filler', reason: 'kaputt' },
      ],
    }
    const s = buildCutSuggestions(words, raw, 8, 1)
    expect(s[0]).toEqual({ start: 0.82, end: 1.28, kind: 'filler', text: 'äh', reason: 'Füllwort' })
    expect(s.map((x) => x.kind)).toEqual(['filler', 'pause', 'pause'])
  })
})

describe('AiJobManager', () => {
  it('liefert Ergebnis, Fehler und Abbruch', async () => {
    const m = new AiJobManager()
    const ok = m.start('claude', async (_s, p) => {
      p(50)
      return { x: 1 }
    })
    const bad = m.start('claude', async () => {
      throw new Error('kaputt')
    })
    let abortSeen = false
    const slow = m.start(
      'transcribe',
      (signal) =>
        new Promise((_res, rej) => {
          signal.addEventListener('abort', () => {
            abortSeen = true
            rej(new Error('Abgebrochen.'))
          })
        }),
    )
    expect(m.hasCapacity('transcribe')).toBe(false)
    await new Promise((r) => setTimeout(r, 10))
    expect(m.get(ok.id)).toMatchObject({ state: 'done', progress: 100, result: { x: 1 } })
    expect(m.get(bad.id)).toMatchObject({ state: 'error', error: 'kaputt' })
    expect(m.cancel(slow.id)).toBe(true)
    expect(abortSeen).toBe(true)
    expect(m.get(slow.id)).toMatchObject({ state: 'error', error: 'Abgebrochen.' })
    expect(m.hasCapacity('transcribe')).toBe(true)
    m.shutdown()
  })
})
