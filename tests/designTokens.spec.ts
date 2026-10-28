/**
 * Design-Tokens v2 (Kopie aus dem Collage Maker): JSON ↔ CSS konsistent,
 * Light-Spiegelung, Namespace, Einbindung, Kontrast (WCAG AA), TS-Zugriff.
 */
import { describe, expect, it } from 'vitest'
import tokens from '@/design-system/tokens-v2.json'
import {
  breakpointsV2,
  colorCssVarV2,
  colorTokenV2,
  controlSizesV2,
  cssVarV2,
  themeColorsV2,
} from '@/design-system/tokens-v2'
import {
  collectTokens,
  contrastRatio,
  normalize,
  parseBlock,
  readRelative,
  type TokenLeaf,
} from './helpers/tokenTestUtils'

const base = import.meta.url
const v2Css = readRelative(base, '../src/design-system/tokens-v2.css')
const styleCss = readRelative(base, '../src/style.css')

const rootBlock = parseBlock(v2Css, ':root', 'tokens-v2.css')
const lightBlock = parseBlock(v2Css, '.light-theme', 'tokens-v2.css')
const dataThemeLightBlock = parseBlock(v2Css, ":root[data-theme='light']", 'tokens-v2.css')
const allTokens = collectTokens(tokens)
const withCss = allTokens.filter(
  (token): token is TokenLeaf & { cssVar: string } => token.cssVar !== undefined,
)

const THEMES = ['dark', 'light'] as const
const TEXT_TOKENS = ['text', 'text2', 'text3'] as const
const SURFACE_TOKENS = ['surface0', 'surface1', 'surface2'] as const
const STATUS_TOKENS = ['success', 'warning', 'danger', 'info', 'link'] as const
const AA = 4.5

describe('tokens-v2.json ↔ tokens-v2.css', () => {
  it('definiert jedes Token mit CSS-Variable im passenden Block mit identischem Wert', () => {
    expect(withCss.length).toBeGreaterThan(80)
    const mismatches = withCss.flatMap((token) => {
      const block = token.path.includes('light') ? lightBlock : rootBlock
      const actual = block[token.cssVar]
      const expected = normalize(token.value)
      return actual === expected
        ? []
        : [`${token.path} (${token.cssVar}): css=${actual} json=${expected}`]
    })
    expect(mismatches).toEqual([])
  })

  it('hat in :root keine Variable ohne JSON-Eintrag', () => {
    const declared = new Set(withCss.map((token) => token.cssVar))
    expect(Object.keys(rootBlock).filter((variable) => !declared.has(variable))).toEqual([])
  })

  it('hat für Dark und Light dieselben Farb- und Effekt-Tokens', () => {
    expect(Object.keys(tokens.color.light).sort()).toEqual(Object.keys(tokens.color.dark).sort())
    expect(Object.keys(tokens.effect.light).sort()).toEqual(Object.keys(tokens.effect.dark).sort())
  })

  it('spiegelt html[data-theme=light] vollständig aus .light-theme', () => {
    expect(dataThemeLightBlock).toEqual(lightBlock)
  })

  it('deklariert Composite-Tokens mit var(--ds-…) auch in .light-theme', () => {
    const composites = Object.entries(rootBlock).filter(([, value]) => value.includes('var(--ds-'))
    expect(composites.length).toBeGreaterThan(0)
    const missingInLight = composites
      .filter(([variable]) => lightBlock[variable] === undefined)
      .map(([variable]) => variable)
    expect(missingInLight).toEqual([])
  })
})

describe('Namespace und Einbindung', () => {
  it('nutzt ausschließlich --ds-* Variablen', () => {
    const variables = [...Object.keys(rootBlock), ...Object.keys(lightBlock)]
    expect(variables.filter((variable) => !variable.startsWith('--ds-'))).toEqual([])
  })

  it('wird in style.css als erste Regel importiert', () => {
    const withoutComments = styleCss.replace(/\/\*[\s\S]*?\*\//g, '').trim()
    expect(withoutComments.startsWith("@import './design-system/tokens-v2.css';")).toBe(true)
  })
})

describe('Kontrast (WCAG AA, mindestens 4.5:1)', () => {
  it.each(THEMES)('%s: Text 1–3 auf Fläche 0–2', (theme) => {
    const colors = themeColorsV2(theme)
    const failures = TEXT_TOKENS.flatMap((text) =>
      SURFACE_TOKENS.flatMap((surface) => {
        const ratio = contrastRatio(colors[text], colors[surface])
        return ratio >= AA ? [] : [`${text} auf ${surface}: ${ratio.toFixed(2)}`]
      }),
    )
    expect(failures).toEqual([])
  })

  it.each(THEMES)('%s: Text auf Akzent und Akzent-Hover', (theme) => {
    const colors = themeColorsV2(theme)
    expect(contrastRatio(colors.onAccent, colors.accent)).toBeGreaterThanOrEqual(AA)
    expect(contrastRatio(colors.onAccent, colors.accentHover)).toBeGreaterThanOrEqual(AA)
  })

  it.each(THEMES)('%s: Status- und Linkfarben als Text auf Panel', (theme) => {
    const colors = themeColorsV2(theme)
    const failures = STATUS_TOKENS.flatMap((status) => {
      const ratio = contrastRatio(colors[status], colors.surface1)
      return ratio >= AA ? [] : [`${status} auf surface1: ${ratio.toFixed(2)}`]
    })
    expect(failures).toEqual([])
  })
})

describe('tokens-v2.ts', () => {
  it('liefert Farbwerte, Variablennamen und var()-Ausdrücke', () => {
    expect(colorTokenV2('dark', 'accent')).toBe('#d4a257')
    expect(colorTokenV2('light', 'accent')).toBe('#c9984d')
    expect(colorCssVarV2('text2')).toBe('--ds-text-2')
    expect(cssVarV2('text2')).toBe('var(--ds-text-2)')
    expect(cssVarV2('surface1', '#111d33')).toBe('var(--ds-surface-1, #111d33)')
  })

  it('liefert eine flache Farbkarte je Theme', () => {
    expect(Object.keys(themeColorsV2('dark'))).toEqual(Object.keys(tokens.color.dark))
    expect(themeColorsV2('light').surface0).toBe('#f6f5f1')
  })

  it('liefert Größen und Breakpoints als Zahlen', () => {
    expect(controlSizesV2).toEqual({ sm: 28, md: 36, lg: 40, row: 44 })
    expect(breakpointsV2).toEqual({ phone: 480, tablet: 768, desktop: 1024 })
  })
})
