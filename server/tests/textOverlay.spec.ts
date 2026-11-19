import { describe, it, expect } from 'vitest'
import {
  assColor,
  assTime,
  buildAss,
  buildAssEvent,
  buildAssEvents,
  buildAssLines,
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
    // Tempo: 0,5 = doppelt so lang, fehlendes Feld = 1
    expect(buildAssEvent(overlay({ animation: 'fade', animSpeed: 0.5 }), 100, 100)).toContain(
      '\\fad(800,800)',
    )
    const [p] = parseTextOverlays([{ ...base, animSpeed: 9 }], 10)
    expect(p!.animSpeed).toBe(4)
    expect(parseTextOverlays([base], 10)[0]!.animSpeed).toBe(1)
    expect(() => parseTextOverlays([{ ...base, animSpeed: 'x' }], 10)).toThrow(/Tempo/)
    expect(buildAssEvent(overlay({ animation: 'slide' }), 1000, 1000)).toContain(
      '\\move(500,960,500,900,0,500)',
    )
    expect(buildAssEvent(overlay({ animation: 'pop' }), 100, 100)).toContain('\\fscx40')
    // Neue Animationen
    expect(buildAssEvent(overlay({ animation: 'fadeIn' }), 100, 100)).toContain('\\fad(400,0)')
    expect(buildAssEvent(overlay({ animation: 'fadeOut' }), 100, 100)).toContain('\\fad(0,400)')
    expect(buildAssEvent(overlay({ animation: 'slideTop' }), 1000, 1000)).toContain(
      '\\move(500,840,500,900,0,500)',
    )
    expect(buildAssEvent(overlay({ animation: 'slideLeft' }), 1000, 1000)).toContain(
      '\\move(440,900,500,900,0,500)',
    )
    expect(buildAssEvent(overlay({ animation: 'slideRight' }), 1000, 1000)).toContain(
      '\\move(560,900,500,900,0,500)',
    )
    expect(buildAssEvent(overlay({ animation: 'zoom' }), 100, 100)).toContain(
      '\\fad(250,400)\\fscx160\\fscy160\\t(0,500,\\fscx100\\fscy100)',
    )
    // Tempo unter 0,25×: bis zur Hälfte der Dauer, Untergrenze 0,05
    expect(parseTextOverlays([{ ...base, animSpeed: 0.01 }], 10)[0]!.animSpeed).toBe(0.05)
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

describe('Deckkraft und Buchstabenabstand', () => {
  it('fehlende Felder bleiben weg (ältere Projekte, bisheriger Editor)', () => {
    const [o] = parseTextOverlays([base], 10)
    expect(o).not.toHaveProperty('opacity')
    expect(o).not.toHaveProperty('letterSpacing')
    const [d] = parseTextOverlays([{ ...base, opacity: 1, letterSpacing: 0 }], 10)
    expect(d).not.toHaveProperty('opacity')
    expect(d).not.toHaveProperty('letterSpacing')
  })

  it('übernimmt abweichende Werte begrenzt und lehnt Unsinn ab', () => {
    const [o] = parseTextOverlays([{ ...base, opacity: 0.5, letterSpacing: 0.25 }], 10)
    expect(o.opacity).toBe(0.5)
    expect(o.letterSpacing).toBe(0.25)
    const [c] = parseTextOverlays([{ ...base, opacity: -3, letterSpacing: 9 }], 10)
    expect(c.opacity).toBe(0)
    expect(c.letterSpacing).toBe(1)
    expect(parseTextOverlays([{ ...base, letterSpacing: -9 }], 10)[0].letterSpacing).toBe(-0.2)
    expect(() => parseTextOverlays([{ ...base, opacity: 'x' }], 10)).toThrow(ValidationError)
    expect(() => parseTextOverlays([{ ...base, letterSpacing: 'x' }], 10)).toThrow(ValidationError)
  })

  it('ohne die Felder bleibt die ASS-Datei Zeichen für Zeichen gleich', () => {
    const plain = buildAss([overlay({ style: 'box', text: 'A\nB' })], 1920, 1080)
    const same = buildAss(
      [overlay({ style: 'box', text: 'A\nB', opacity: 1, letterSpacing: 0 })],
      1920,
      1080,
    )
    expect(same).toBe(plain)
    expect(plain).not.toContain('BoxA')
    expect(plain).not.toContain('\\fsp')
  })

  it('Deckkraft schwächt Füllung, Kontur und Schatten ab', () => {
    const outline = buildAssEvent(overlay({ opacity: 0.5 }), 1920, 1080)
    expect(outline).toContain('\\1a&H80&\\3a&H80&')
    const shadow = buildAssEvent(overlay({ style: 'shadow', opacity: 0.5 }), 1920, 1080)
    // Schatten war schon zu 25 % durchsichtig: 0x40 -> 255 - 191 * 0,5.
    expect(shadow).toContain('\\1a&H80&\\4a&HA0&')
    const none = buildAssEvent(overlay({ style: 'none', opacity: 0 }), 1920, 1080)
    expect(none).toContain('\\1a&HFF&')
  })

  it('halbtransparente Box: eine Box um den ganzen Text (BorderStyle 4)', () => {
    const o = overlay({ style: 'box', opacity: 0.5, text: 'Zeile 1\nZeile 2' })
    const ass = buildAss([o], 1920, 1080)
    expect(ass).toMatch(/^Style: BoxA,.*,4,0,0,5,0,0,0,1$/m)
    const [line] = buildAssLines(o, 1920, 1080)
    expect(line).toContain(',BoxA,,')
    expect(line).toContain('\\4c&H000000&')
    expect(line).toContain('\\1a&H80&\\3a&HFF&\\4a&H80&')
    // Deckende Box wie bisher.
    expect(buildAssEvent(overlay({ style: 'box' }), 1920, 1080)).toContain(',Box,,')
  })

  it('Buchstabenabstand in px der Schriftgröße, ohne Abstand hinter dem letzten Zeichen', () => {
    // 0,06 × 1080 = 64,8 px; 25 % = 16,2 px.
    const line = buildAssEvent(overlay({ letterSpacing: 0.25, text: 'AB\nCD' }), 1920, 1080)
    expect(line).toContain('\\fsp16.2')
    expect(line).toMatch(/A\{\\fsp0\}B\\N\{\\fsp16\.2\}C\{\\fsp0\}D$/)
  })

  it('Buchstabenabstand mit Schreibmaschine und Keyframes', () => {
    const typed = buildAssEvent(
      overlay({ animation: 'typewriter', letterSpacing: -0.1, text: 'ABC' }),
      1920,
      1080,
    )
    expect(typed).toContain('\\fsp-6.5')
    expect(typed).toMatch(/\{\\fsp0\}\{[^}]*\}C$/)
    const keyed = buildAssEvents(
      overlay({
        letterSpacing: 0.5,
        opacity: 0.4,
        motion: {
          keys: [
            { at: 0, x: 0.2, y: 0.5, scale: 1 },
            { at: 2, x: 0.8, y: 0.5, scale: 2 },
          ],
          smooth: false,
        },
      }),
      1920,
      1080,
    )
    expect(keyed.length).toBeGreaterThan(0)
    for (const l of keyed) {
      expect(l).toContain('\\fsp32.4')
      expect(l).toContain('\\1a&H99&')
    }
  })
})
