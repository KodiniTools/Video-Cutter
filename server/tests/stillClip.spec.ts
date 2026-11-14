import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { buildStillArgs, parseStillParams, stillClipName, STILL_LIMITS } from '../src/lib/stillClip'
import { runFfmpeg } from '../src/lib/ffmpeg'
import { probeMedia } from '../src/lib/probe'
import { ValidationError } from '../src/lib/validate'

describe('parseStillParams', () => {
  it('liest Formularwerte, rundet auf gerade Pixel, Standard-fps 30', () => {
    expect(parseStillParams({ duration: '5', width: '1921', height: '1081' })).toEqual({
      duration: 5,
      width: 1920,
      height: 1080,
      fps: 30,
    })
    expect(parseStillParams({ duration: 2.5, width: 720, height: 1280, fps: '24.4' }).fps).toBe(24)
  })

  it('lehnt ungültige Werte ab', () => {
    const ok = { duration: '3', width: '640', height: '360' }
    for (const bad of [
      { ...ok, duration: '0.1' },
      { ...ok, duration: String(STILL_LIMITS.maxDuration + 1) },
      { ...ok, duration: 'abc' },
      { ...ok, width: '8' },
      { ...ok, height: '5000' },
      { ...ok, fps: '0' },
      { ...ok, fps: '120' },
      { width: '640', height: '360' },
    ]) {
      expect(() => parseStillParams(bad)).toThrow(ValidationError)
    }
  })
})

describe('buildStillArgs', () => {
  it('Schleife + stille Tonspur, Dauer, Zielgröße', () => {
    const args = buildStillArgs('/tmp/a.png', '/tmp/o.mp4', {
      duration: 4,
      width: 1280,
      height: 720,
      fps: 25,
    })
    expect(args.slice(args.indexOf('-loop'), args.indexOf('-loop') + 2)).toEqual(['-loop', '1'])
    expect(args).toContain('anullsrc=r=48000:cl=stereo')
    expect(args[args.indexOf('-t') + 1]).toBe('4.000')
    expect(args[args.indexOf('-vf') + 1]).toContain('pad=1280:720')
    expect(args[args.length - 1]).toBe('/tmp/o.mp4')
  })

  it('Dateiname', () => {
    expect(stillClipName(5)).toBe('Bild-Clip_5s.mp4')
    expect(stillClipName(2.5)).toBe('Bild-Clip_2,5s.mp4')
  })
})

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0

describe.skipIf(!hasFfmpeg)('Bild-Clip mit echtem ffmpeg', () => {
  it('erzeugt Video mit Dauer, Größe und Tonspur', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'still-spec-'))
    try {
      const img = path.join(dir, 'in.png')
      const out = path.join(dir, 'out.mp4')
      spawnSync('ffmpeg', [
        '-y',
        '-f',
        'lavfi',
        '-i',
        'color=c=red:s=320x200',
        '-frames:v',
        '1',
        img,
      ])
      const p = { duration: 1.5, width: 640, height: 360, fps: 30 }
      await runFfmpeg(buildStillArgs(img, out, p), p.duration, () => {}).promise
      const info = await probeMedia(out)
      expect(info.width).toBe(640)
      expect(info.height).toBe(360)
      expect(info.hasAudio).toBe(true)
      expect(Math.abs(info.duration - 1.5)).toBeLessThan(0.1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 30_000)
})
