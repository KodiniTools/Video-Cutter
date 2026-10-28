/**
 * Regressionsschutz für die Übernahme des Collage-Maker-Design-Systems:
 * Komponenten nutzen nur definierte --ds-* Tokens (keine alte --vc-Palette),
 * und index.html bindet Nav/Footer/Cookie-Banner wie der Collage Maker per SSI ein.
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { parseBlock } from './helpers/tokenTestUtils'

const ROOT = join(__dirname, '..')
const SRC = join(ROOT, 'src')

function collect(dir: string, ext: string[], out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) collect(full, ext, out)
    else if (ext.some((e) => entry.name.endsWith(e))) out.push(full)
  }
  return out
}

const tokensCss = readFileSync(join(SRC, 'design-system/tokens-v2.css'), 'utf8')
const defined = new Set(Object.keys(parseBlock(tokensCss, ':root', 'tokens-v2.css')))
const styleFiles = collect(SRC, ['.vue', '.css']).filter((f) => !f.endsWith('tokens-v2.css'))

describe('Design-Tokens in App-Styles', () => {
  it('referenzieren nur definierte --ds-* Variablen', () => {
    const unknown = styleFiles.flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(/var\((--ds-[a-z0-9-]+)/g)]
        .map((m) => m[1] as string)
        .filter((name) => !defined.has(name))
        .map((name) => `${relative(SRC, file)}: ${name}`),
    )
    expect(unknown).toEqual([])
  })

  it('nutzen die alte --vc-Palette nicht mehr (nur der App-Token --vc-playhead bleibt)', () => {
    const legacy = styleFiles.flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(/--vc-[a-z0-9-]+/g)]
        .map((m) => m[0])
        .filter((name) => name !== '--vc-playhead')
        .map((name) => `${relative(SRC, file)}: ${name}`),
    )
    expect(legacy).toEqual([])
  })

  it('setzen keine festen Systemschriften mehr (Supreme/JetBrains Mono über Tokens)', () => {
    const hits = styleFiles.filter((file) =>
      /font-family:\s*(?:system-ui|ui-monospace)/.test(readFileSync(file, 'utf8')),
    )
    expect(hits.map((f) => relative(SRC, f))).toEqual([])
  })
})

describe('index.html', () => {
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8')

  it('bindet die globalen Partials per SSI ein (Reihenfolge wie im Collage Maker)', () => {
    const nav = html.indexOf('<!--#include virtual="/partials/nav.html" -->')
    const app = html.indexOf('<div id="app"></div>')
    const footer = html.indexOf('<!--#include virtual="/partials/footer.html" -->')
    const cookie = html.indexOf('<!--#include virtual="/partials/cookie-banner.html" -->')
    expect(nav).toBeGreaterThan(-1)
    expect(app).toBeGreaterThan(nav)
    expect(footer).toBeGreaterThan(app)
    expect(cookie).toBeGreaterThan(footer)
  })

  it('enthält keine eingebetteten Kopien von Nav, Footer oder Cookie-Banner mehr', () => {
    expect(html).not.toMatch(/<nav\b/)
    expect(html).not.toMatch(/<footer\b/)
    expect(html).not.toContain('id="cookieBanner"')
  })

  it('setzt data-theme vor dem ersten Paint mit Light als Standard', () => {
    expect(html).toContain("storedTheme === 'dark' ? 'dark' : 'light'")
  })
})

describe('NGINX-Konfiguration', () => {
  it('aktiviert SSI für den Video Cutter', () => {
    const conf = readFileSync(join(ROOT, 'deploy/nginx-video-cutter.conf'), 'utf8')
    expect(conf).toMatch(/^\s*ssi on;/m)
  })
})
