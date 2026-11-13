import { describe, it, expect } from 'vitest'
import {
  assColor,
  assTime,
  buildAss,
  buildAssEvent,
  buildTextFilter,
  cleanText,
  escapeAssText,
  escapeFilterPath,
  fadeMs,
  parseTextOverlays,
  typeStepMs,
  MAX_TEXT_OVERLAYS,
  type TextOverlay,
} from '../src/lib/textOverlay'
import { buildTextArgs } from '../src/routes/text'
import { ValidationError } from '../src/lib/validate'

const base = {
  text: 'Hallo',
  start: 1,
  end: 4,
  x: 0.5,
  y: 0.9,
  font: 'roboto',
  size: 0.06,
  color: '#FFFFFF',
  style: 'outline',
  accent: '#000000',
  animation: 'none',
}

const overlay = (o: Partial<TextOverlay> = {}): TextOverlay =>
  ({ ...parseTextOverlays([base], 10)[0], ...o }) as TextOverlay

describe('parseTextOverlays', () => {
  it('akzeptiert gültige Einträge (auch als JSON-String) und normalisiert Farben', () => {
    const [o] = parseTextOverlays(JSON.stringify([base]), 10)
    expect(o).toMatchObject({ text: 'Hallo', start: 1, end: 4, color: '#ffffff' })
  })

  it('begrenzt Ende auf die Videodauer und Position/Größe auf gültige Bereiche', () => {
    const [o] = parseTextOverlays([{ ...base, end: 99, x: 2, y: -1, size: 5 }], 10)
    expect(o.end).toBe(10)
    expect(o.x).toBe(1)
    expect(o.y).toBe(0)
    expect(o.size).toBe(0.3)
  })

  it('lehnt leere, zu viele und fehlerhafte Einträge ab', () => {
    expect(() => parseTextOverlays([], 10)).toThrow(ValidationError)
    expect(() => parseTextOverlays('kein json', 10)).toThrow(ValidationError)
    expect(() => parseTextOverlays([{ ...base, text: '   ' }], 10)).toThrow(/leer/)
    expect(() => parseTextOverlays([{ ...base, start: 5, end: 5 }], 10)).toThrow(ValidationError)
    expect(() => parseTextOverlays([{ ...base, start: 12, end: 15 }], 10)).toThrow(ValidationError)
    expect(() => parseTextOverlays([{ ...base, font: 'comic' }], 10)).toThrow(ValidationError)
    expect(() => parseTextOverlays([{ ...base, color: 'red' }], 10)).toThrow(ValidationError)
    expect(() => parseTextOverlays([{ ...base, animation: 'spin' }], 10)).toThrow(ValidationError)
    expect(() => parseTextOverlays([{ ...base, x: 'NaN' }], 10)).toThrow(ValidationError)
    expect(() => parseTextOverlays(Array(MAX_TEXT_OVERLAYS + 1).fill(base), 10)).toThrow(/Maximal/)
    expect(() => parseTextOverlays([{ ...base, text: 'a\nb\nc\nd\ne\nf\ng' }], 10)).toThrow(
      /Zeilen/,
    )
  })
})

describe('Text-Hilfsfunktionen', () => {
  it('cleanText entfernt Steuerzeichen und Randzeilen', () => {
    expect(cleanText('\r\nA\u0007b  \r\nc\n\n')).toBe('Ab\nc')
  })

  it('escapeAssText maskiert Override-Blöcke, Backslash und Umbrüche', () => {
    expect(escapeAssText('{x}')).toBe('\\{x\\}')
    expect(escapeAssText('a\\Nb')).toBe('a\\⁠Nb')
    expect(escapeAssText('a\nb')).toBe('a\\Nb')
  })

  it('assColor/assTime', () => {
    expect(assColor('#e11d48')).toBe('&H481DE1&')
    expect(assTime(0)).toBe('0:00:00.00')
    expect(assTime(3661.234)).toBe('1:01:01.23')
  })

  it('assTime trifft bildgenau dieselben Bilder wie die Vorschau (start <= t < end)', () => {
    // libass vergleicht in ms mit dem (abgeschnittenen) Bild-Zeitstempel.
    const ms = (ass: string) => {
      const [h, m, s] = ass.split(':').map(Number)
      return Math.round(((h * 60 + m) * 60 + s) * 1000)
    }
    for (const fps of [24, 25, 30000 / 1001, 30, 50, 60]) {
      for (let k = 1; k < 2000; k++) {
        const startPts = k / fps
        const startClient = Math.round(startPts * 1000) / 1000 // wie snapToFrame
        const a = ms(assTime(startClient))
        // Bild k (Zeitstempel startPts) sichtbar, Bild k-1 nicht.
        expect(a).toBeLessThanOrEqual(Math.floor(startPts * 1000))
        expect(a).toBeGreaterThan(Math.floor(((k - 1) / fps) * 1000))
      }
    }
  })

  it('Animationszeiten sind begrenzt', () => {
    expect(fadeMs(10)).toBe(400)
    expect(fadeMs(0.6)).toBe(200)
    expect(typeStepMs(10, 5)).toBe(60)
    expect(typeStepMs(1, 11)).toBe(60)
    expect(typeStepMs(1, 21)).toBe(30)
    expect(typeStepMs(1, 1)).toBe(0)
  })
})

describe('buildAssEvent', () => {
  it('setzt Position, Schrift (libass-Größe) und Zeiten', () => {
    const line = buildAssEvent(overlay(), 1920, 1080)
    expect(line.startsWith('Dialogue: 0,0:00:00.99,0:00:03.99,Text,,0,0,0,,{')).toBe(true)
    expect(line).toContain('\\an5')
    expect(line).toContain('\\pos(960,972)')
    expect(line).toContain('\\fnRoboto\\b1')
    // 0.06 * 1080 = 64.8 px (CSS) * 1.2002 = 77.8
    expect(line).toContain('\\fs77.8')
    expect(line.endsWith('}Hallo')).toBe(true)
  })

  it('Box nutzt den Box-Stil, Kontur/Akzentfarbe werden gesetzt', () => {
    const line = buildAssEvent(overlay({ style: 'box', accent: '#ff0000' }), 1000, 1000)
    expect(line).toContain(',Box,,')
    expect(line).toContain('\\3c&H0000FF&')
  })

  it('Animationen erzeugen passende Tags', () => {
    expect(buildAssEvent(overlay({ animation: 'fade' }), 100, 100)).toContain('\\fad(400,400)')
    expect(buildAssEvent(overlay({ animation: 'slide' }), 1000, 1000)).toContain(
      '\\move(500,960,500,900,0,500)',
    )
    expect(buildAssEvent(overlay({ animation: 'pop' }), 100, 100)).toContain('\\fscx40')
    const tw = buildAssEvent(overlay({ text: 'ab\nc', animation: 'typewriter' }), 100, 100)
    // erstes Zeichen sofort, dann je 60 ms; Umbruch ohne Tag
    expect(tw).toMatch(/}a\{[^}]*\\t\(60,61,[^}]*\}b\\N\{[^}]*\\t\(120,121,/)
  })
})

describe('buildAss / Filter / Argumente', () => {
  it('erzeugt Kopf mit PlayRes und je Text eine Zeile', () => {
    const ass = buildAss([overlay(), overlay({ text: 'Zwei' })], 1280, 720)
    expect(ass).toContain('PlayResX: 1280')
    expect(ass).toContain('PlayResY: 720')
    expect(ass).toContain('WrapStyle: 2')
    expect(ass.match(/^Dialogue:/gm)).toHaveLength(2)
  })

  it('verlangt eine bekannte Auflösung', () => {
    expect(() => buildAss([overlay()], 0, 0)).toThrow(ValidationError)
  })

  it('maskiert Pfade in der Filterkette', () => {
    expect(escapeFilterPath('/tmp/a.ass')).toBe('/tmp/a.ass')
    expect(escapeFilterPath("/t:m'p")).toBe("/t\\\\:m\\\\\\'p")
    expect(buildTextFilter('/tmp/x.ass', '/srv/fonts')).toBe(
      'ass=filename=/tmp/x.ass:fontsdir=/srv/fonts,format=yuv420p',
    )
  })

  it('buildTextArgs: Video + optionale Tonspur, Re-Encode passend zum Container', () => {
    const args = buildTextArgs('/in.mp4', '/t.ass', '/fonts', '/out.mp4')
    expect(args).toContain('-progress')
    expect(args.slice(args.indexOf('-i'), args.indexOf('-i') + 2)).toEqual(['-i', '/in.mp4'])
    expect(args).toContain('0:a:0?')
    expect(args).toContain('libx264')
    expect(args[args.length - 1]).toBe('/out.mp4')
    expect(buildTextArgs('/in.webm', '/t.ass', '/fonts', '/out.webm')).toContain('libvpx-vp9')
  })
})
