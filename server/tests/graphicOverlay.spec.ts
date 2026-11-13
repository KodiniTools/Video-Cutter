import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { deflateSync } from 'node:zlib'
import {
  buildGraphicsFilterComplex,
  graphicFilter,
  graphicInputArgs,
  graphicTopLeft,
  parseGraphicOverlays,
  pngSize,
  MAX_GRAPHICS,
} from '../src/lib/graphicOverlay'
import { buildOverlayArgs, buildTextArgs } from '../src/routes/text'
import { buildTextFilter } from '../src/lib/textOverlay'
import { SERVER_FEATURES } from '../src/routes/cut'
import { ValidationError } from '../src/lib/validate'

/** Minimales gültiges RGBA-PNG (w×h, halbtransparentes Rot). */
function makePng(w: number, h: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (b: Buffer) => {
    let c = 0xffffffff
    for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const c = Buffer.alloc(4)
    c.writeUInt32BE(crc(td))
    return Buffer.concat([len, td, c])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 4)])
  for (let i = 0; i < w; i++) row.set([255, 0, 0, 160], 1 + i * 4)
  const raw = Buffer.concat(Array.from({ length: h }, () => row))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const png = makePng(41, 21)
const base = {
  png: `data:image/png;base64,${png.toString('base64')}`,
  x: 0.5,
  y: 0.5,
  start: 1,
  end: 3,
  animation: 'fade',
}

describe('pngSize', () => {
  it('liest Breite/Höhe aus dem IHDR-Block', () => {
    expect(pngSize(png)).toEqual({ width: 41, height: 21 })
  })
  it('lehnt Nicht-PNGs ab', () => {
    expect(pngSize(Buffer.from('GIF89a........................................'))).toBeNull()
    expect(pngSize(Buffer.alloc(10))).toBeNull()
  })
})

describe('parseGraphicOverlays', () => {
  it('fehlende Liste = keine Grafiken', () => {
    expect(parseGraphicOverlays(undefined, 10)).toEqual([])
    expect(parseGraphicOverlays(null, 10)).toEqual([])
  })

  it('akzeptiert Data-URL und reines Base64, begrenzt Zeiten auf das Video', () => {
    const [a, b] = parseGraphicOverlays(
      [base, { ...base, png: png.toString('base64'), end: 99, x: 2, y: -1 }],
      5,
    )
    expect(a).toMatchObject({ width: 41, height: 21, start: 1, end: 3, animation: 'fade' })
    expect(b).toMatchObject({ end: 5, x: 1, y: 0 })
  })

  it('lehnt ungültige Einträge ab', () => {
    const bad = (g: Record<string, unknown>) => () => parseGraphicOverlays([{ ...base, ...g }], 10)
    expect(() => parseGraphicOverlays('x', 10)).toThrow(ValidationError)
    expect(bad({ png: 'Zm9v' })).toThrow(/kein PNG/)
    expect(bad({ png: 'not base64!' })).toThrow(ValidationError)
    expect(bad({ png: 42 })).toThrow(ValidationError)
    expect(bad({ animation: 'pop' })).toThrow(/Animation/)
    expect(bad({ start: 4, end: 4.1 })).toThrow(/Ende/)
    expect(bad({ x: 'a' })).toThrow(ValidationError)
    expect(() => parseGraphicOverlays(Array(MAX_GRAPHICS + 1).fill(base), 10)).toThrow(/Maximal/)
  })

  it('lehnt zu große Bilder ab', () => {
    const huge = makePng(1, 1)
    huge.writeUInt32BE(9000, 16)
    expect(() => parseGraphicOverlays([{ ...base, png: huge.toString('base64') }], 10)).toThrow(
      /zu groß/,
    )
  })
})

describe('Grafik-Filter', () => {
  const [g] = parseGraphicOverlays([base], 10)

  it('Mittelpunkt -> linke obere Ecke wie in der Vorschau', () => {
    expect(graphicTopLeft({ x: 0.5, y: 0.5, width: 41, height: 21 }, 640, 360)).toEqual({
      left: 300,
      top: 170,
    })
  })

  it('fade: Alpha ein-/ausblenden, sichtbar nur im Zeitbereich', () => {
    const f = graphicFilter(g!, 1, '[0:v]', '[v1]', 640, 360)
    expect(f).toBe(
      '[1:v]format=rgba,fade=t=in:st=1:d=0.4:alpha=1,fade=t=out:st=2.6:d=0.4:alpha=1[g1];' +
        "[0:v][g1]overlay=x=300:y=170:enable='gte(t,1)*lt(t,3)':shortest=1[v1]",
    )
  })

  it('slide: y gleitet linear von +6 % Bildhöhe zur Zielposition', () => {
    const f = graphicFilter({ ...g!, animation: 'slide' }, 2, '[v1]', '[v2]', 640, 360)
    expect(f).toContain("y='170+22*max(0,1-(t-1)/0.5)'")
    expect(f).toContain('fade=t=in:st=1:d=0.5:alpha=1')
  })

  it('none: kein fade', () => {
    expect(graphicFilter({ ...g!, animation: 'none' }, 1, '[0:v]', '[v1]', 640, 360)).not.toContain(
      'fade',
    )
  })

  it('Kette: Grafiken nacheinander, Texte zuletzt darüber', () => {
    const fc = buildGraphicsFilterComplex([g!, g!], 640, 360, buildTextFilter('/t.ass', '/f'))
    expect(fc).toMatch(/\[0:v\]\[g1\]overlay.*\[v1\];.*\[v1\]\[g2\]overlay.*\[v2\];\[v2\]ass=/)
    expect(fc.endsWith('format=yuv420p[vout]')).toBe(true)
    expect(buildGraphicsFilterComplex([g!], 640, 360)).toMatch(/\[v1\]format=yuv420p\[vout\]$/)
    expect(() => buildGraphicsFilterComplex([g!], 0, 0)).toThrow(ValidationError)
  })

  it('Eingaben: Standbild wiederholt, auf Videodauer begrenzt', () => {
    expect(graphicInputArgs(['/a.png'], 10)).toEqual([
      '-loop',
      '1',
      '-framerate',
      '30',
      '-t',
      '11',
      '-i',
      '/a.png',
    ])
    expect(graphicInputArgs(['/a.png'], 0)).not.toContain('-t')
  })

  it('ohne Grafiken unverändert wie bisher (nur Texte)', () => {
    const p = {
      inputPath: '/in.mp4',
      assPath: '/t.ass',
      fontsDir: '/fonts',
      graphics: [],
      graphicPaths: [],
      width: 640,
      height: 360,
      duration: 10,
      outputPath: '/out.mp4',
    }
    expect(buildOverlayArgs(p)).toEqual(buildTextArgs('/in.mp4', '/t.ass', '/fonts', '/out.mp4'))
    expect(() => buildOverlayArgs({ ...p, assPath: null })).toThrow(ValidationError)
  })

  it('Feature-Flag in /api/health', () => {
    expect(SERVER_FEATURES).toContain('graphics')
  })
})

describe('Grafiken mit echtem FFmpeg einbrennen', () => {
  let hasFfmpeg = true
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' })
  } catch {
    hasFfmpeg = false
  }

  it.skipIf(!hasFfmpeg)('erzeugt ein Video mit Grafik', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vc-graphic-'))
    try {
      const input = path.join(dir, 'in.mp4')
      execFileSync('ffmpeg', [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc=size=320x180:rate=25:duration=2',
        '-pix_fmt',
        'yuv420p',
        input,
      ])
      const pngPath = path.join(dir, 'g.png')
      writeFileSync(pngPath, png)
      const graphics = parseGraphicOverlays(
        [{ ...base, start: 0.2, end: 1.5, animation: 'slide' }],
        2,
      )
      const out = path.join(dir, 'out.mp4')
      const args = buildOverlayArgs({
        inputPath: input,
        assPath: null,
        fontsDir: dir,
        graphics,
        graphicPaths: [pngPath],
        width: 320,
        height: 180,
        duration: 2,
        outputPath: out,
      }).filter((a, i, all) => a !== '-progress' && all[i - 1] !== '-progress')
      execFileSync('ffmpeg', ['-y', '-v', 'error', ...args], { timeout: 60_000 })
      expect(existsSync(out)).toBe(true)
      const dur = Number(
        execFileSync('ffprobe', [
          '-v',
          'error',
          '-show_entries',
          'format=duration',
          '-of',
          'csv=p=0',
          out,
        ]).toString(),
      )
      expect(dur).toBeGreaterThan(1.8)
      expect(dur).toBeLessThan(2.5)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
