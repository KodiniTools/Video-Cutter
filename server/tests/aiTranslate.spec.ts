import { describe, it, expect } from 'vitest'
import { buildTranslations } from '../src/lib/claude'
import { parseTranslateTexts } from '../src/routes/ai'
import { SERVER_FEATURES } from '../src/routes/cut'
import { ValidationError } from '../src/lib/validate'

describe('Texte übersetzen', () => {
  it('ordnet Übersetzungen per Index zu, fehlende behalten das Original', () => {
    const r = buildTranslations(['Hallo', 'Zwei\nZeilen', 'Drei'], {
      translations: [
        { i: 1, text: 'Two\\nlines' },
        { i: 0, text: '  Hello ' },
        { i: 7, text: 'außerhalb' },
        { i: 2, text: '   ' },
      ],
    })
    expect(r).toEqual({ texts: ['Hello', 'Two\nlines', 'Drei'], missing: 1 })
  })

  it('kaputte Antwort -> alles bleibt, alles fehlt', () => {
    expect(buildTranslations(['a', 'b'], null)).toEqual({ texts: ['a', 'b'], missing: 2 })
  })

  it('begrenzt Länge und Zeilen, entfernt Steuerzeichen', () => {
    const r = buildTranslations(
      ['x'],
      { translations: [{ i: 0, text: `a\u0007\n${'b\n'.repeat(8)}` }] },
      300,
      3,
    )
    expect(r.texts[0]).toBe('a\nb\nb b b b b b b')
    const long = buildTranslations(['x'], { translations: [{ i: 0, text: 'y'.repeat(400) }] })
    expect(long.texts[0]).toHaveLength(300)
  })

  it('prüft die Eingabe', () => {
    expect(parseTranslateTexts(['a', 'b'])).toEqual(['a', 'b'])
    expect(() => parseTranslateTexts([])).toThrow(ValidationError)
    expect(() => parseTranslateTexts('a')).toThrow(ValidationError)
    expect(() => parseTranslateTexts([' '])).toThrow(/leer/)
    expect(() => parseTranslateTexts(['x'.repeat(301)])).toThrow(/zu lang/)
    expect(() => parseTranslateTexts(Array(501).fill('a'))).toThrow(/Maximal/)
  })

  it('Feature-Flag', () => {
    expect(SERVER_FEATURES).toContain('aiTranslate')
  })
})
