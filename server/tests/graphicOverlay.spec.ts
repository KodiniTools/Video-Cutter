import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { deflateSync } from 'node:zlib'
import {
  buildGraphicsFilterComplex,
  graphicFilter,
  graphicFps,
  graphicInputArgs,
  graphicTopLeft,
  rotationBox,
  GRAPHIC_LOOPS,
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
    expect(bad({ animation: 'typewriter' })).toThrow(/Animation/)
    expect(bad({ loop: 'jump' })).toThrow(/Dauer-Animation/)
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
        "[0:v][g1]overlay=x=300:y=170:enable='gte(t,0.999)*lt(t,2.999)':shortest=1[v1]",
    )
  })

  it('slide: y gleitet linear von +6 % Bildhöhe zur Zielposition', () => {
    const f = graphicFilter({ ...g!, animation: 'slide' }, 2, '[v1]', '[v2]', 640, 360)
    expect(f).toContain("y='170+22*max(0,1-(t-1)/0.5)'")
    expect(f).toContain('fade=t=in:st=1:d=0.5:alpha=1')
  })

  it('nur ein-/ausblenden', () => {
    const fin = graphicFilter({ ...g!, animation: 'fadeIn' }, 1, '[0:v]', '[v1]', 640, 360)
    expect(fin).toContain('fade=t=in:st=1:d=0.4:alpha=1')
    expect(fin).not.toContain('fade=t=out')
    const fout = graphicFilter({ ...g!, animation: 'fadeOut' }, 1, '[0:v]', '[v1]', 640, 360)
    expect(fout).not.toContain('fade=t=in')
    expect(fout).toContain('fade=t=out:st=2.6:d=0.4:alpha=1')
  })

  it('hereingleiten von oben, links und rechts; heranzoomen', () => {
    const f = (animation: 'slideTop' | 'slideLeft' | 'slideRight' | 'zoom') =>
      graphicFilter({ ...g!, animation }, 2, '[v1]', '[v2]', 640, 360)
    expect(f('slideTop')).toContain("x=300:y='170-22*max(0,1-(t-1)/0.5)'")
    expect(f('slideLeft')).toContain("x='300-22*max(0,1-(t-1)/0.5)':y=170")
    expect(f('slideRight')).toContain("x='300+22*max(0,1-(t-1)/0.5)':y=170")
    const zoom = f('zoom')
    expect(zoom).toContain('fade=t=in:st=1:d=0.25:alpha=1')
    expect(zoom).toContain('(1+0.6*max(0,1-(t-1)/0.5))')
    expect(zoom).toContain('overlay_w/2')
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
    expect(SERVER_FEATURES).toContain('graphicMotion')
  })

  it('ohne loop-Feld (alter Client): keine Dauer-Animation, Filter wie bisher', () => {
    expect(g!.loop).toBe('none')
    const [withNone] = parseGraphicOverlays([{ ...base, loop: 'none' }], 10)
    expect(graphicFilter(withNone!, 1, '[0:v]', '[v1]', 640, 360)).toBe(
      graphicFilter(g!, 1, '[0:v]', '[v1]', 640, 360),
    )
  })

  it('pop: Größe 0,4 -> 1,12 -> 1, zentriert über die aktuelle Größe', () => {
    const f = graphicFilter({ ...g!, animation: 'pop' }, 1, '[0:v]', '[v1]', 640, 360)
    expect(f).toContain('fade=t=in:st=1:d=0.25:alpha=1')
    expect(f).toContain(
      "scale=w='max(1,trunc(iw*if(between(t,0.9,3.1),if(lt((t-1),0.3),0.4+0.72*min(1,max(0,(t-1)/0.3)),1.12-0.12*min(1,max(0,((t-1)-0.3)/0.2))),1)))'",
    )
    expect(f).toContain(':eval=frame')
    expect(f).toContain("overlay=x='320-overlay_w/2':y='180-overlay_h/2'")
  })

  it('pulse: Größe pulsiert, kombinierbar mit fade', () => {
    const f = graphicFilter({ ...g!, loop: 'pulse' }, 1, '[0:v]', '[v1]', 640, 360)
    expect(f).toContain('fade=t=in')
    expect(f).toContain('trunc(iw*if(between(t,0.9,3.1),(1+0.06*(1-cos(2*PI*(t-1)/1))),1))')
  })

  it('wobble/spin: drehen in festem Quadrat (Diagonale), transparent gefüllt', () => {
    expect(rotationBox(41, 21)).toBe(47)
    const w = graphicFilter({ ...g!, loop: 'wobble' }, 1, '[0:v]', '[v1]', 640, 360)
    expect(w).toContain(
      "rotate=a='0.1745*sin(2*PI*(t-1)/0.8)':ow=47:oh=47:c=black@0:enable='between(t,0.9,3.1)'",
    )
    // Fester Mittelpunkt: (320-23.5, 180-23.5) gerundet.
    expect(w).toContain('overlay=x=297:y=157')
    const s = graphicFilter({ ...g!, loop: 'spin' }, 1, '[0:v]', '[v1]', 640, 360)
    expect(s).toContain("rotate=a='2*PI*(t-1)/3'")
    // spin + pop: erst drehen, dann skalieren
    const sp = graphicFilter(
      { ...g!, loop: 'spin', animation: 'pop' },
      1,
      '[0:v]',
      '[v1]',
      640,
      360,
    )
    expect(sp.indexOf('rotate=')).toBeLessThan(sp.indexOf('scale='))
  })

  it('float: y schwebt auf und ab, slide kombiniert', () => {
    const f = graphicFilter({ ...g!, loop: 'float' }, 1, '[0:v]', '[v1]', 640, 360)
    expect(f).toContain("y='170-5.4*sin(2*PI*(t-1)/2)'")
    const s = graphicFilter(
      { ...g!, loop: 'float', animation: 'slide' },
      1,
      '[0:v]',
      '[v1]',
      640,
      360,
    )
    expect(s).toContain("y='170+22*max(0,1-(t-1)/0.5)-5.4*sin(2*PI*(t-1)/2)'")
  })

  it('Tempo: Perioden und Ein-/Ausblendzeit geteilt durch den Faktor', () => {
    const f = graphicFilter({ ...g!, loop: 'spin', animSpeed: 2 }, 1, '[0:v]', '[v1]', 640, 360)
    expect(f).toContain("rotate=a='2*PI*(t-1)/1.5'")
    expect(f).toContain('fade=t=in:st=1:d=0.2:alpha=1')
    const b = graphicFilter({ ...g!, loop: 'blink', animSpeed: 0.5 }, 1, '[0:v]', '[v1]', 640, 360)
    expect(b).toContain('lt(mod((t-1),2),1.2)')
    expect(g!.animSpeed).toBe(1)
    expect(SERVER_FEATURES).toContain('animSpeed')
  })

  it('blink: zusätzlich im enable-Ausdruck', () => {
    const f = graphicFilter({ ...g!, loop: 'blink' }, 1, '[0:v]', '[v1]', 640, 360)
    expect(f).toContain("enable='gte(t,0.999)*lt(t,2.999)*lt(mod((t-1),1),0.6)'")
  })

  it('Takt der Standbilder = Bildrate des Videos (sonst 30)', () => {
    expect(graphicFps(25)).toBe('25')
    expect(graphicFps(30000 / 1001)).toBe(String(30000 / 1001))
    expect(graphicFps(0)).toBe('30')
    expect(graphicFps(500)).toBe('30')
    expect(graphicInputArgs(['/a.png'], 10, 25)).toContain('25')
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

  it.skipIf(!hasFfmpeg)('alle Dauer-Animationen (mit pop) laufen durch FFmpeg', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vc-graphic-loop-'))
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
      const loops = GRAPHIC_LOOPS.filter((l) => l !== 'none')
      const paths = loops.map((_, i) => path.join(dir, `g${i}.png`))
      paths.forEach((p) => writeFileSync(p, png))
      const graphics = parseGraphicOverlays(
        loops.map((loop) => ({ ...base, start: 0.2, end: 1.8, animation: 'pop', loop })),
        2,
      )
      const out = path.join(dir, 'out.mp4')
      const args = buildOverlayArgs({
        inputPath: input,
        assPath: null,
        fontsDir: dir,
        graphics,
        graphicPaths: paths,
        width: 320,
        height: 180,
        duration: 2,
        fps: 25,
        outputPath: out,
      }).filter((a, i, all) => a !== '-progress' && all[i - 1] !== '-progress')
      execFileSync('ffmpeg', ['-y', '-v', 'error', ...args], { timeout: 60_000 })
      expect(existsSync(out)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
