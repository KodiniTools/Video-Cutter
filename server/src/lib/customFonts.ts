import { readdir, readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { readFontMetrics, previewShift, winRatio } from './fontMetrics'

/**
 * Eigene Schriften (z. B. aus src/assets/fonts): Beim Serverstart werden alle
 * Dateien des Ordners eingelesen. Jede statische Schriftdatei wird zu einer
 * wählbaren Schrift; variable Schriften werden übersprungen.
 *
 * Viele Webfonts haben unbrauchbare interne Namen (z. B. „false"). libass
 * findet Schriften aber nur über den Namen. Deshalb vergibt eine eigene
 * fontconfig-Konfiguration beim Einlesen jeder Datei einen eindeutigen Namen
 * („VCF <Dateiname>") – die Dateien selbst bleiben unverändert.
 */

export interface CustomFont {
  /** Schlüssel für Client/Server, z. B. `f:Zodiak-Bold`. */
  key: string
  /** Dateiname im Schriftordner. */
  file: string
  /** Absoluter Pfad. */
  path: string
  /** Eindeutiger Familienname für libass/fontconfig. */
  family: string
  /** Gruppe (Familie) für die Auswahl, z. B. „General Sans". */
  group: string
  /** Schnitt, z. B. „Bold Italic". */
  label: string
  weight: number
  italic: boolean
  winRatio: number
  /** Zeilenhöhe der Vorschau (= libass-Zeilenabstand), in em. */
  lineRatio: number
  /** Vertikaler Versatz der Vorschau, in em. */
  shift: number
}

/** Öffentliche Sicht (ohne Pfad) für GET /api/fonts. */
export type CustomFontView = Omit<CustomFont, 'path' | 'family' | 'winRatio'>

const FONT_EXT = /\.(woff2|woff|ttf|otf)$/i
/** Nur unkritische Dateinamen (landen in ASS-Datei und fontconfig-XML). */
const STEM_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

/** „GeneralSans" -> „General Sans", „BoldItalic" -> „Bold Italic". */
export function splitWords(s: string): string {
  return s
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Gruppe und Schnitt aus dem Dateinamen („Zodiak-BoldItalic.woff2"). */
export function describeFile(stem: string): { group: string; label: string } {
  const dash = stem.indexOf('-')
  const fam = dash > 0 ? stem.slice(0, dash) : stem
  const style = dash > 0 ? stem.slice(dash + 1) : 'Regular'
  return { group: splitWords(fam), label: splitWords(style) || 'Regular' }
}

let registry = new Map<string, CustomFont>()

export function getCustomFont(key: string): CustomFont | undefined {
  return registry.get(key)
}

export function listCustomFonts(): CustomFont[] {
  return [...registry.values()]
}

/** Nur für Tests: Registry direkt setzen. */
export function setCustomFonts(fonts: CustomFont[]): void {
  registry = new Map(fonts.map((f) => [f.key, f]))
}

export function customFontView(f: CustomFont): CustomFontView {
  return {
    key: f.key,
    file: f.file,
    group: f.group,
    label: f.label,
    weight: f.weight,
    italic: f.italic,
    lineRatio: f.lineRatio,
    shift: f.shift,
  }
}

/** Liest alle Schriften eines Ordners ein. Fehlender Ordner = keine Schriften. */
export async function scanCustomFonts(dir: string): Promise<CustomFont[]> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const fonts: CustomFont[] = []
  const seen = new Set<string>()
  for (const name of names.sort()) {
    if (!FONT_EXT.test(name)) continue
    const stem = name.replace(FONT_EXT, '')
    // Gleicher Name in mehreren Formaten: erstes (alphabetisch) gewinnt.
    if (!STEM_RE.test(stem) || seen.has(stem.toLowerCase())) continue
    try {
      const m = readFontMetrics(await readFile(path.join(dir, name)))
      if (m.variable) continue
      seen.add(stem.toLowerCase())
      const ratio = winRatio(m)
      const round = (v: number) => Math.round(v * 10000) / 10000
      fonts.push({
        key: `f:${stem}`,
        file: name,
        path: path.resolve(dir, name),
        family: `VCF ${stem.replace(/[_-]+/g, ' ')}`,
        ...describeFile(stem),
        weight: m.weight,
        italic: m.italic,
        winRatio: round(ratio),
        lineRatio: round(ratio),
        shift: round(previewShift(m)),
      })
    } catch (err) {
      console.warn(`Schrift übersprungen (${name}):`, err instanceof Error ? err.message : err)
    }
  }
  return fonts
}

function xml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * fontconfig-Konfiguration: nur der Schriftordner (eigener Cache), und je Datei
 * eine Scan-Regel, die Familie/Vollname/PostScript-Namen eindeutig setzt.
 */
export function buildFontconfig(fonts: CustomFont[], dirs: string[], cacheDir: string): string {
  const rules = fonts.map((f) => {
    const fam = xml(f.family)
    return (
      `  <match target="scan"><test name="file"><string>${xml(f.path)}</string></test>` +
      `<edit name="family" mode="assign_replace" binding="strong"><string>${fam}</string></edit>` +
      `<edit name="fullname" mode="assign_replace"><string>${fam}</string></edit>` +
      `<edit name="postscriptname" mode="assign_replace"><string>${xml(f.family.replace(/ /g, '-'))}</string></edit>` +
      `</match>`
    )
  })
  return [
    '<?xml version="1.0"?>',
    '<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">',
    '<fontconfig>',
    // Bewusst OHNE /etc/fonts/fonts.conf: dessen System-Caches könnten einen
    // fremden Cache dieses Ordners (ohne unsere Umbenennung) liefern. Fehlende
    // Zeichen ersetzt libass aus den mitgelieferten Schriften (fontsdir).
    `  <cachedir>${xml(path.resolve(cacheDir))}</cachedir>`,
    ...dirs.map((d) => `  <dir>${xml(path.resolve(d))}</dir>`),
    ...rules,
    '</fontconfig>',
    '',
  ].join('\n')
}

/** Pfad der erzeugten fontconfig-Datei (null = keine eigenen Schriften). */
let fontconfigFile: string | null = null

export function customFontsEnv(): NodeJS.ProcessEnv | undefined {
  return fontconfigFile ? { ...process.env, FONTCONFIG_FILE: fontconfigFile } : undefined
}

/** Beim Serverstart: Schriften einlesen und fontconfig-Datei schreiben. */
export async function initCustomFonts(dir: string, workDir: string): Promise<CustomFont[]> {
  const fonts = await scanCustomFonts(dir)
  setCustomFonts(fonts)
  if (!fonts.length) {
    fontconfigFile = null
    return fonts
  }
  // Cache bei jedem Start neu aufbauen, damit geänderte Regeln sicher greifen.
  const cacheDir = path.join(workDir, 'fontconfig-cache')
  await rm(cacheDir, { recursive: true, force: true })
  await mkdir(cacheDir, { recursive: true })
  const file = path.join(workDir, 'fonts.conf')
  await writeFile(file, buildFontconfig(fonts, [dir], cacheDir), 'utf8')
  fontconfigFile = file
  return fonts
}
