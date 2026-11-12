import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { readFontMetrics, previewShift, winRatio, FontParseError } from '../src/lib/fontMetrics'
import {
  buildFontconfig,
  describeFile,
  getCustomFont,
  scanCustomFonts,
  setCustomFonts,
  splitWords,
  type CustomFont,
} from '../src/lib/customFonts'
import { buildAssEvent, fontMeta, parseTextOverlays } from '../src/lib/textOverlay'
import { ValidationError } from '../src/lib/validate'

const BUNDLED = path.join(__dirname, '../fonts')
const ASSETS = path.join(__dirname, '../../src/assets/fonts')

describe('readFontMetrics', () => {
  it('TTF: Werte wie libass-Messung (Lora)', () => {
    const m = readFontMetrics(readFileSync(path.join(BUNDLED, 'Lora-Bold.ttf')))
    expect(m).toMatchObject({ unitsPerEm: 1000, winAscent: 1206, winDescent: 294 })
    expect(winRatio(m)).toBeCloseTo(1.5)
    // gemessen: libass setzt Lora 0.09 em tiefer als der Browser
    expect(previewShift(m)).toBeCloseTo(0.09, 3)
  })

  it('WOFF2: Tabellen werden entpackt (Supreme Regular)', () => {
    const m = readFontMetrics(readFileSync(path.join(ASSETS, 'Supreme-Regular.woff2')))
    expect(m.unitsPerEm).toBeGreaterThan(0)
    expect(m.weight).toBe(400)
    expect(m.variable).toBe(false)
    expect(m.useTypoMetrics).toBe(true)
  })

  it('erkennt variable Schriften und lehnt Unsinn ab', () => {
    const v = readFontMetrics(readFileSync(path.join(ASSETS, 'Supreme-Variable.woff2')))
    expect(v.variable).toBe(true)
    expect(() => readFontMetrics(Buffer.from('keine schrift'))).toThrow(FontParseError)
  })
})

describe('Dateinamen', () => {
  it('Gruppe und Schnitt', () => {
    expect(splitWords('GeneralSans')).toBe('General Sans')
    expect(describeFile('GeneralSans-BoldItalic')).toEqual({
      group: 'General Sans',
      label: 'Bold Italic',
    })
    expect(describeFile('Tanker')).toEqual({ group: 'Tanker', label: 'Regular' })
  })
})

describe('scanCustomFonts', () => {
  it('liest statische Schriften, überspringt variable, fehlender Ordner = leer', async () => {
    const fonts = await scanCustomFonts(ASSETS)
    expect(fonts.length).toBeGreaterThan(0)
    expect(fonts.some((f) => f.file.includes('Variable'))).toBe(false)
    const sup = fonts.find((f) => f.key === 'f:Supreme-Regular')
    expect(sup).toMatchObject({ group: 'Supreme', label: 'Regular', family: 'VCF Supreme Regular' })
    expect(await scanCustomFonts('/gibt/es/nicht')).toEqual([])
  })
})

const fake: CustomFont = {
  key: 'f:Demo-Bold',
  file: 'Demo-Bold.woff2',
  path: '/fonts/Demo-Bold.woff2',
  family: 'VCF Demo Bold',
  group: 'Demo',
  label: 'Bold',
  weight: 700,
  italic: false,
  winRatio: 1.25,
  lineRatio: 1.25,
  shift: 0.02,
}

describe('eigene Schriften im Text', () => {
  afterEach(() => setCustomFonts([]))

  it('fontconfig-Regel setzt eindeutigen Namen je Datei (XML maskiert)', () => {
    const xml = buildFontconfig([{ ...fake, path: '/a&b/Demo-Bold.woff2' }], ['/a&b'], '/tmp/c')
    expect(xml).toContain('<dir>/a&amp;b</dir>')
    expect(xml).toContain('<string>/a&amp;b/Demo-Bold.woff2</string>')
    expect(xml).toContain('<string>VCF Demo Bold</string>')
    expect(xml).not.toContain('/etc/fonts/fonts.conf')
    expect(xml).toContain('<cachedir>/tmp/c</cachedir>')
  })

  it('nur vorhandene eigene Schriften sind erlaubt; ASS nutzt den eindeutigen Namen', () => {
    const base = {
      text: 'Hi',
      start: 0,
      end: 2,
      x: 0.5,
      y: 0.5,
      size: 0.1,
      color: '#ffffff',
      style: 'none',
      accent: '#000000',
      animation: 'none',
    }
    expect(() => parseTextOverlays([{ ...base, font: 'f:Demo-Bold' }], 5)).toThrow(ValidationError)
    setCustomFonts([fake])
    expect(getCustomFont('f:Demo-Bold')).toBeDefined()
    const [o] = parseTextOverlays([{ ...base, font: 'f:Demo-Bold' }], 5)
    expect(fontMeta(o.font)).toEqual({ family: 'VCF Demo Bold', winRatio: 1.25, bold: false })
    // 0.1 * 1000 px * 1.25
    expect(buildAssEvent(o, 1000, 1000)).toContain('\\fnVCF Demo Bold\\b0\\fs125')
  })
})
