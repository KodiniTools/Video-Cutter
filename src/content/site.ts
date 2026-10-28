// Content-Schicht für den Kodini Designer.
//
// src/content/site.json enthält die im Designer editierbaren Werte (Texte je
// Sprache, Titel/Meta, Farben). Leerer String = Standard aus i18n.ts bzw. den
// Design-Tokens (src/design-system). Der Designer schreibt nur diese Datei; der
// Build (vite.config.ts, i18n.ts, main.ts) liest sie – im Code selbst muss
// nichts angepasst werden.
import siteJson from './site.json'

export interface SiteTheme {
  accent?: string
  playhead?: string
  light?: { bg?: string; surface?: string; text?: string }
  dark?: { bg?: string; surface?: string; text?: string }
  // Hintergrundbild der App (URL unter /uploads/… oder https://…), fixiert
  // hinter dem Inhalt; Deckkraft 0–100 %, Abdunkelung 0–100 %, Weichzeichner px.
  bgImage?: string
  bgImageOpacity?: number
  bgImageDarken?: number
  bgImageBlur?: number
}
/** Design eines Text-Slots (Designer, Tab „Felder“); ''/0 = Standard der App. */
export interface SlotStyle {
  font?: string // Dateiname unter /fonts (z. B. Supreme-Bold.woff2)
  size?: number // px, 0 = Standard
  weight?: string // '', '300' … '800'
  spacing?: number // Buchstabenabstand in px
  transform?: string // '', 'uppercase', 'lowercase', 'capitalize'
  colorLight?: string // Hex, Hellmodus
  colorDark?: string // Hex, Dunkelmodus
}
export interface SiteContent {
  meta?: { title?: string; description?: string }
  texts?: Record<string, unknown>
  theme?: SiteTheme
  // Verschachtelt wie die Slot-Schlüssel (styles.app.title …); der Designer
  // schreibt Pfade wie styles.app.title.size.
  styles?: Record<string, unknown>
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

// Designer-Farben überschreiben die Design-Tokens (src/design-system/tokens-v2.css).
// Globale Werte (Akzent, Abspielkopf) müssen auch die Theme-Blöcke der Tokens
// (:root[data-theme='…'], gleiche Spezifität, früher im Dokument) überstimmen.
const ALL_THEMES = ":root,:root[data-theme='light'],:root[data-theme='dark']"
const MODE_VARS = { bg: '--ds-surface-0', surface: '--ds-surface-1', text: '--ds-text' } as const

/** CSS-Regeln für die im Designer gesetzten Farben ('' wenn nichts gesetzt). */
export function themeCss(theme: SiteTheme | undefined): string {
  if (!theme) return ''
  const rules: string[] = []
  const root: string[] = []
  if (theme.accent && HEX.test(theme.accent)) {
    root.push(`--ds-accent:${theme.accent}`)
    root.push(`--ds-accent-hover:${theme.accent}`)
    root.push(`--ds-accent-soft:${hexToRgba(theme.accent, 0.16)}`)
    root.push(`--ds-on-accent:${onColor(theme.accent)}`)
  }
  if (theme.playhead && HEX.test(theme.playhead)) root.push(`--vc-playhead:${theme.playhead}`)
  if (root.length) rules.push(`${ALL_THEMES}{${root.join(';')}}`)
  for (const mode of ['light', 'dark'] as const) {
    const side = theme[mode]
    if (!side) continue
    const vars: string[] = []
    for (const key of ['bg', 'surface', 'text'] as const) {
      const value = side[key]
      if (value && HEX.test(value)) vars.push(`${MODE_VARS[key]}:${value}`)
    }
    if (vars.length) rules.push(`:root[data-theme='${mode}']{${vars.join(';')}}`)
  }
  const bg = bgImageCss(theme)
  if (bg) rules.push(bg)
  return rules.join('\n')
}

const IMAGE_URL = /^(\/[^\s"'()\\]*|https?:\/\/[^\s"'()\\]+)$/
const clamp = (v: unknown, min: number, max: number, def: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : def

/**
 * Hintergrundbild als fixierte Ebene hinter dem Inhalt (body::before): Deckkraft,
 * Abdunkelung (brightness) und Weichzeichner; '' ohne gültiges Bild.
 */
export function bgImageCss(theme: SiteTheme | undefined): string {
  const url = theme?.bgImage
  if (!url || !IMAGE_URL.test(url)) return ''
  const opacity = clamp(theme?.bgImageOpacity, 0, 100, 100) / 100
  const darken = clamp(theme?.bgImageDarken, 0, 100, 0) / 100
  const blur = clamp(theme?.bgImageBlur, 0, 40, 0)
  const filters: string[] = []
  if (blur > 0) filters.push(`blur(${blur}px)`)
  if (darken > 0) filters.push(`brightness(${(1 - darken).toFixed(3)})`)
  // Weichzeichner franst am Rand aus -> Ebene etwas über den Rand hinaus vergrößern.
  const grow = blur > 0 ? blur * 2 : 0
  return (
    `body::before{content:'';position:fixed;inset:-${grow}px;z-index:-1;pointer-events:none;` +
    `background:url("${url}") center/cover no-repeat;opacity:${opacity.toFixed(3)};` +
    `filter:${filters.join(' ') || 'none'}}`
  )
}

const FONT_FILE = /^[a-zA-Z0-9][a-zA-Z0-9._ -]*\.(woff2|woff|ttf|otf)$/i
const WEIGHTS = new Set(['300', '400', '500', '600', '700', '800'])
const TRANSFORMS = new Set(['uppercase', 'lowercase', 'capitalize'])
const SLOT_KEY = /^[a-zA-Z0-9_.-]+$/

function fontFamilyId(file: string): string {
  return 'kodini-font-' + file.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9]+/g, '-')
}
function fontFaceCss(file: string): string {
  const ext = (file.split('.').pop() || '').toLowerCase()
  const fmt = (
    { woff2: 'woff2', woff: 'woff', ttf: 'truetype', otf: 'opentype' } as Record<string, string>
  )[ext]
  const src = `url("/fonts/${encodeURIComponent(file)}")${fmt ? ` format("${fmt}")` : ''}`
  return `@font-face{font-family:"${fontFamilyId(file)}";src:${src};font-display:swap;}`
}

const STYLE_KEYS = new Set([
  'font',
  'size',
  'weight',
  'spacing',
  'transform',
  'colorLight',
  'colorDark',
])
/** Verschachteltes styles-Objekt in { 'app.title': SlotStyle, … } auflösen. */
export function flattenSlotStyles(styles: unknown, prefix = ''): Record<string, SlotStyle> {
  const out: Record<string, SlotStyle> = {}
  if (!isTree(styles)) return out
  const isLeaf =
    Object.keys(styles).some((k) => STYLE_KEYS.has(k)) && !Object.values(styles).some(isTree)
  if (isLeaf) {
    if (prefix) out[prefix] = styles as SlotStyle
    return out
  }
  for (const [k, v] of Object.entries(styles)) {
    if (!isTree(v)) continue
    Object.assign(out, flattenSlotStyles(v, prefix ? `${prefix}.${k}` : k))
  }
  return out
}

/**
 * CSS für die Text-Slots ([data-slot="…"] in den Komponenten): Schrift, Größe,
 * Gewicht, Abstand, Schreibweise sowie Farbe je Hell/Dunkel. '' wenn nichts gesetzt.
 * Die Deklarationen tragen !important, damit sie die scoped Komponenten-Styles
 * (z. B. `.brand h1[data-v-…]`) sicher überstimmen – es sind bewusste Vorgaben
 * aus dem Designer.
 */
export function slotCss(styles: unknown): string {
  const flat = flattenSlotStyles(styles)
  const faces = new Set<string>()
  const rules: string[] = []
  for (const [key, st] of Object.entries(flat)) {
    if (!SLOT_KEY.test(key) || !st || typeof st !== 'object') continue
    const sel = `[data-slot="${key}"]`
    const decl: string[] = []
    if (st.font && FONT_FILE.test(st.font)) {
      faces.add(fontFaceCss(st.font))
      decl.push(`font-family:"${fontFamilyId(st.font)}",system-ui,sans-serif !important`)
    }
    if (typeof st.size === 'number' && st.size > 0) decl.push(`font-size:${st.size}px !important`)
    if (st.weight && WEIGHTS.has(String(st.weight)))
      decl.push(`font-weight:${st.weight} !important`)
    if (typeof st.spacing === 'number' && st.spacing !== 0)
      decl.push(`letter-spacing:${st.spacing}px !important`)
    if (st.transform && TRANSFORMS.has(st.transform))
      decl.push(`text-transform:${st.transform} !important`)
    if (decl.length) rules.push(`${sel}{${decl.join(';')}}`)
    if (st.colorLight && HEX.test(st.colorLight))
      rules.push(`:root[data-theme='light'] ${sel}{color:${st.colorLight} !important}`)
    if (st.colorDark && HEX.test(st.colorDark))
      rules.push(`:root[data-theme='dark'] ${sel}{color:${st.colorDark} !important}`)
  }
  return [...faces, ...rules].join('\n')
}

function hexRgb(hex: string): [number, number, number] {
  let h = hex.slice(1)
  if (h.length === 3)
    h = h
      .split('')
      .map((c) => c + c)
      .join('')
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}

function hexToRgba(hex: string, alpha: number): string {
  const [r, g, b] = hexRgb(hex)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

/**
 * Textfarbe auf einer Akzentfläche: dunkles Navy der Tokens oder Weiß, je
 * nachdem, was nach WCAG mehr Kontrast ergibt.
 */
export function onColor(hex: string): string {
  const lum = (c: number) => {
    const v = c / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  const rel = ([r, g, b]: [number, number, number]) =>
    0.2126 * lum(r) + 0.7152 * lum(g) + 0.0722 * lum(b)
  const bg = rel(hexRgb(hex))
  const dark = rel(hexRgb('#0a1324'))
  const vsDark = (bg + 0.05) / (dark + 0.05)
  const vsWhite = 1.05 / (bg + 0.05)
  return vsDark >= vsWhite ? '#0a1324' : '#ffffff'
}

/** Hängt Designer-Farben und Slot-Design als <style id="site-theme"> in den Kopf ein. */
export function applySiteTheme(doc: Document, content: SiteContent = site): void {
  const css = [themeCss(content.theme), slotCss(content.styles)].filter(Boolean).join('\n')
  if (!css) return
  let el = doc.getElementById('site-theme') as HTMLStyleElement | null
  if (!el) {
    el = doc.createElement('style')
    el.id = 'site-theme'
    doc.head.appendChild(el)
  }
  el.textContent = css
}
