import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { config } from '../src/config'
import { probeImage } from '../src/routes/media'
import { resolvePreviewSources } from '../src/routes/preview'
import { parseTimelineDoc, type RenderDoc } from '../src/lib/render/doc'
import { ValidationError } from '../src/lib/validate'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'

/** Eigene Bilder in der Medienliste (POST /api/media mit image/*). */
describe('Bilder in der Bibliothek', () => {
  let dir: string
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'media-images-'))
  })
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const make = (name: string) => {
    const out = path.join(dir, name)
    execFileSync(config.ffmpegPath, [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=red:s=64x48',
      '-frames:v',
      '1',
      out,
    ])
    return out
  }

  it('liest Maße von PNG, JPEG und WebP; Bild ohne Dauer und Ton', async () => {
    for (const name of ['a.png', 'a.jpg', 'a.webp']) {
      expect(await probeImage(make(name), 100)).toEqual({
        width: 64,
        height: 48,
        hasAudio: false,
        duration: 0,
        fps: 0,
        hasVideo: true,
        image: true,
      })
    }
  })

  it('lehnt kaputte und zu große Bilder ab', async () => {
    const broken = path.join(dir, 'kaputt.png')
    await writeFile(broken, 'kein bild')
    await expect(probeImage(broken, 9)).rejects.toThrow(ValidationError)
    await expect(probeImage(make('b.png'), 31 * 1024 * 1024)).rejects.toThrow('zu groß')
  })

  it('ein Bild auf einer Video-Spur wird abgelehnt (nur Bild-Clips verweisen darauf)', async () => {
    const r = parseTimelineDoc({
      version: 2,
      settings: { width: 640, height: 360, fps: 25, background: '#000000', sampleRate: 48000 },
      assets: {
        [A]: { id: A, kind: 'video', duration: 4_000_000 },
        [B]: { id: B, kind: 'image', duration: null },
      },
      tracks: [
        {
          id: 'V1',
          kind: 'video',
          hidden: false,
          clips: [
            {
              id: 'v',
              kind: 'video',
              asset: A,
              start: 0,
              duration: 1_000_000,
              sourceIn: 0,
              speed: 1,
            },
          ],
        },
      ],
    })
    expect(r.ok).toBe(true)
    const doc = (r as { doc: RenderDoc }).doc
    const item = (image: boolean) => ({
      path: '/m/a',
      info: { hasAudio: true, hasVideo: true, ...(image ? { image: true } : {}) },
    })
    // Ein ungenutztes Bild-Medium im Dokument stört nicht.
    const ok = await resolvePreviewSources(doc, { get: () => item(false), proxy: async () => null })
    expect(Object.keys(ok)).toEqual([A])
    await expect(
      resolvePreviewSources(doc, { get: () => item(true), proxy: async () => null }),
    ).rejects.toThrow('Bild')
  })
})
