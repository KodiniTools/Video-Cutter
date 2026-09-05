// Content-Schicht für den Kodini Designer.
//
// src/content/site.json enthält die im Designer editierbaren Werte (Texte je
// Sprache, Titel/Meta, Farben). Leerer String = Standard aus i18n.ts bzw.
// style.css. Der Designer schreibt nur diese Datei; der Build (vite.config.ts,
// i18n.ts, main.ts) liest sie – im Code selbst muss nichts angepasst werden.
import siteJson from './site.json'

export interface SiteTheme {
  accent?: string
  playhead?: string
  light?: { bg?: string; surface?: string; text?: string }
  dark?: { bg?: string; surface?: string; text?: string }
}
export interface SiteContent {
  meta?: { title?: string; description?: string }
  texts?: Record<string, unknown>
  theme?: SiteTheme
}

export const site: SiteContent = siteJson as SiteContent

type Tree = Record<string, unknown>
function isTree(v: unknown): v is Tree {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Legt nicht-leere Strings aus `overrides` über `base` (tief, ohne `base` zu
 * verändern). Leere Strings und unbekannte Typen werden ignoriert, damit ein
 * gelöschter Designer-Wert wieder den eingebauten Standard ergibt.
 */
export function mergeMessages<T>(base: T, overrides: unknown): T {
  if (!isTree(base) || !isTree(overrides)) return base
  const out: Tree = { ...base }
  for (const [key, value] of Object.entries(overrides)) {
    if (typeof value === 'string') {
      if (value.trim() !== '' && typeof out[key] === 'string') out[key] = value
    } else if (isTree(value) && isTree(out[key])) {
      out[key] = mergeMessages(out[key], value)
    }
  }
  return out as T
}

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/

/** CSS-Regeln für die im Designer gesetzten Farben ('' wenn nichts gesetzt). */
export function themeCss(theme: SiteTheme | undefined): string {
  if (!theme) return ''
  const rules: string[] = []
  const root: string[] = []
  if (theme.accent && HEX.test(theme.accent)) {
    root.push(`--vc-accent:${theme.accent}`)
    root.push(`--vc-accent-soft:${hexToRgba(theme.accent, 0.16)}`)
    root.push(`--vc-focus:${hexToRgba(theme.accent, 0.6)}`)
  }
  if (theme.playhead && HEX.test(theme.playhead)) root.push(`--vc-playhead:${theme.playhead}`)
  if (root.length) rules.push(`:root{${root.join(';')}}`)
  for (const mode of ['light', 'dark'] as const) {
    const side = theme[mode]
    if (!side) continue
    const vars: string[] = []
    if (side.bg && HEX.test(side.bg)) vars.push(`--vc-bg:${side.bg}`)
    if (side.surface && HEX.test(side.surface)) vars.push(`--vc-surface:${side.surface}`)
    if (side.text && HEX.test(side.text)) vars.push(`--vc-text:${side.text}`)
    if (vars.length) rules.push(`:root[data-theme='${mode}']{${vars.join(';')}}`)
  }
  return rules.join('\n')
}

function hexToRgba(hex: string, alpha: number): string {
  let h = hex.slice(1)
  if (h.length === 3)
    h = h
      .split('')
      .map((c) => c + c)
      .join('')
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

/** Hängt die Designer-Farben als <style id="site-theme"> in den Kopf ein. */
export function applySiteTheme(doc: Document, content: SiteContent = site): void {
  const css = themeCss(content.theme)
  if (!css) return
  let el = doc.getElementById('site-theme') as HTMLStyleElement | null
  if (!el) {
    el = doc.createElement('style')
    el.id = 'site-theme'
    doc.head.appendChild(el)
  }
  el.textContent = css
}
