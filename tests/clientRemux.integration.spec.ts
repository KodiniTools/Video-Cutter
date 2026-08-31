// @vitest-environment node
//
// Integrationstest für den client-seitigen Remux: erzeugt eine echte
// (progressive) MP4 mit Video- UND Audiospur, schickt sie durch `remux()` und
// prüft, dass eine gültige, kürzere MP4 herauskommt. Läuft in Node (kein DOM
// nötig) – deckt die MP4Box-Anbindung ab, die die reinen Unit-Tests nicht
// erreichen. `mp4-muxer` dient nur der Fixture-Erzeugung.
import { describe, it, expect } from 'vitest'
import { Muxer, ArrayBufferTarget } from 'mp4-muxer'
import { createFile } from 'mp4box'
import { useClientRemux } from '@/composables/useClientRemux'

/** Baut eine progressive Test-MP4 (H.264 + AAC), Keyframe alle `gop` Frames. */
function buildSampleMp4(nframes = 30, fps = 10, gop = 5): ArrayBuffer {
  const sps = new Uint8Array([
    0x67, 0x42, 0xc0, 0x1e, 0xd9, 0x00, 0x50, 0x05, 0xbb, 0x01, 0x6c, 0x80,
  ])
  const pps = new Uint8Array([0x68, 0xce, 0x3c, 0x80])
  const avcC = new Uint8Array([
    1,
    sps[1],
    sps[2],
    sps[3],
    0xff,
    0xe1,
    (sps.length >> 8) & 0xff,
    sps.length & 0xff,
    ...sps,
    0x01,
    (pps.length >> 8) & 0xff,
    pps.length & 0xff,
    ...pps,
  ])
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: 'avc', width: 320, height: 240 },
    audio: { codec: 'aac', numberOfChannels: 2, sampleRate: 44100 },
    fastStart: 'in-memory',
  })
  const TS = 1_000_000
  for (let i = 0; i < nframes; i++) {
    const data = new Uint8Array(200 + i)
    data.fill(i & 0xff)
    muxer.addVideoChunkRaw(
      data,
      i % gop === 0 ? 'key' : 'delta',
      Math.round((i / fps) * TS),
      Math.round((1 / fps) * TS),
      i === 0
        ? {
            decoderConfig: {
              codec: 'avc1.42c01e',
              codedWidth: 320,
              codedHeight: 240,
              description: avcC,
            },
          }
        : undefined,
    )
  }
  const aDur = 1024 / 44100
  const aFrames = Math.round(nframes / fps / aDur)
  const aac = new Uint8Array([0x12, 0x10])
  for (let i = 0; i < aFrames; i++) {
    const data = new Uint8Array(64)
    data.fill(0x55)
    muxer.addAudioChunkRaw(
      data,
      'key',
      Math.round(i * aDur * TS),
      Math.round(aDur * TS),
      i === 0
        ? {
            decoderConfig: {
              codec: 'mp4a.40.2',
              numberOfChannels: 2,
              sampleRate: 44100,
              description: aac,
            },
          }
        : undefined,
    )
  }
  muxer.finalize()
  return muxer.target.buffer as ArrayBuffer
}

/** Re-parst eine MP4 und liefert die Track-Infos zur Verifikation. */
function parse(
  buffer: ArrayBuffer,
): Promise<{ tracks: Array<{ type?: string; nb_samples: number }> }> {
  return new Promise((resolve, reject) => {
    const f = createFile(true)
    f.onError = (e) => reject(new Error(e))
    f.onReady = (info) => resolve(info as never)
    const ab = buffer as ArrayBuffer & { fileStart?: number }
    ab.fileStart = 0
    f.appendBuffer(ab)
  })
}

describe('useClientRemux.remux (Integration)', () => {
  it('remuxt eine echte MP4 keyframe-genau zu einer kürzeren, gültigen MP4', async () => {
    const src = buildSampleMp4()
    const before = await parse(src)
    const vBefore = before.tracks.find((t) => t.type === 'video')!
    expect(vBefore.nb_samples).toBe(30)

    const file = new File([src], 'test.mp4', { type: 'video/mp4' })
    const { remux } = useClientRemux()
    const result = await remux(file, 0.7, 1.8)

    expect(result.blob.type).toBe('video/mp4')
    expect(result.blob.size).toBeGreaterThan(0)
    // Start wird auf das Keyframe bei 0.5 s ausgerichtet (GOP 5 @ 10 fps).
    expect(result.startTime).toBeCloseTo(0.5, 3)

    const after = await parse(await result.blob.arrayBuffer())
    const vAfter = after.tracks.find((t) => t.type === 'video')
    const aAfter = after.tracks.find((t) => t.type === 'audio')
    expect(vAfter).toBeDefined()
    expect(aAfter).toBeDefined()
    // Fenster [0.5 .. 1.8] von 3 s -> deutlich weniger als 30 Video-Samples.
    expect(vAfter!.nb_samples).toBeGreaterThan(0)
    expect(vAfter!.nb_samples).toBeLessThan(vBefore.nb_samples)
  })

  it('bricht per AbortSignal ab', async () => {
    const file = new File([buildSampleMp4()], 'test.mp4', { type: 'video/mp4' })
    const { remux } = useClientRemux()
    const ctrl = new AbortController()
    ctrl.abort()
    await expect(remux(file, 0, 1, { signal: ctrl.signal })).rejects.toMatchObject({
      name: 'AbortError',
    })
  })
})
