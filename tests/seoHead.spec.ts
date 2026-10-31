import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cwd } from 'node:process'

const html = readFileSync(resolve(cwd(), 'index.html'), 'utf-8')
const head = new DOMParser().parseFromString(html, 'text/html').head

describe('index.html SEO-Kopf', () => {
  it('Canonical zeigt auf die Tool-URL', () => {
    const links = head.querySelectorAll('link[rel="canonical"]')
    expect(links).toHaveLength(1)
    expect(links[0]?.getAttribute('href')).toBe('https://kodinitools.com/video-cutter/')
  })

  it('Titel und Beschreibung nennen das Haupt-Keyword und halten die Länge ein', () => {
    const title = head.querySelector('title')?.textContent ?? ''
    const description =
      head.querySelector('meta[name="description"]')?.getAttribute('content') ?? ''
    expect(title).toMatch(/^Video schneiden/)
    expect(title.length).toBeLessThanOrEqual(70)
    expect(description.length).toBeGreaterThanOrEqual(120)
    expect(description.length).toBeLessThanOrEqual(160)
  })
})
