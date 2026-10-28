/**
 * Hilfsfunktionen für die Token-Tests: CSS-Blöcke parsen, JSON-Tokens einsammeln,
 * WCAG-Kontrast berechnen. Keine Testdatei (kein .spec-Suffix).
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export type Declarations = Record<string, string>

export interface TokenLeaf {
  path: string
  value: string
  cssVar?: string
}

export const normalize = (value: string): string => value.replace(/\s+/g, ' ').trim()

export function resolveFrom(baseUrl: string, relative: string): string {
  return fileURLToPath(new URL(relative, baseUrl))
}

export function readRelative(baseUrl: string, relative: string): string {
  return readFileSync(resolveFrom(baseUrl, relative), 'utf8')
}

/** Liest alle Custom Properties eines Blocks mit exakt diesem Selektor (keine verschachtelten Blöcke). */
export function parseBlock(css: string, selector: string, fileName = 'CSS'): Declarations {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = withoutComments.match(new RegExp(`(^|\\n)${escaped}\\s*\\{([^}]*)\\}`))
  if (!match) throw new Error(`Block "${selector}" nicht in ${fileName} gefunden`)

  const declarations: Declarations = {}
  for (const [, name, value] of (match[2] ?? '').matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    if (name !== undefined && value !== undefined) declarations[name] = normalize(value)
  }
  return declarations
}

/** Sammelt alle Token-Blätter ($value) aus einem Token-JSON mit ihrem Pfad. */
export function collectTokens(node: unknown, path: string[] = []): TokenLeaf[] {
  if (typeof node !== 'object' || node === null) return []
  const record = node as Record<string, unknown>

  if ('$value' in record) {
    const extensions = record.$extensions as { css?: string } | undefined
    return [{ path: path.join('.'), value: String(record.$value), cssVar: extensions?.css }]
  }

  return Object.entries(record)
    .filter(([key]) => !key.startsWith('$'))
    .flatMap(([key, child]) => collectTokens(child, [...path, key]))
}

/** Relative Leuchtdichte nach WCAG 2.x für #rrggbb. */
export function relativeLuminance(hex: string): number {
  const digits = hex.trim().match(/^#([0-9a-f]{6})$/i)?.[1]
  if (digits === undefined) throw new Error(`Kein #rrggbb-Wert: ${hex}`)
  const channels = [0, 2, 4].map((offset) => {
    const value = parseInt(digits.slice(offset, offset + 2), 16) / 255
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  const [r = 0, g = 0, b = 0] = channels
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG-Kontrastverhältnis zweier #rrggbb-Farben (1 bis 21). */
export function contrastRatio(foreground: string, background: string): number {
  const a = relativeLuminance(foreground)
  const b = relativeLuminance(background)
  const [lighter, darker] = a > b ? [a, b] : [b, a]
  return (lighter + 0.05) / (darker + 0.05)
}
