import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  analyzeSamples,
  BEAT_SAMPLE_RATE,
  BeatStore,
  buildBeatArgs,
  OnsetReducer,
  parseBeatAnalysis,
  type BeatAnalysis,
} from '../src/lib/beats'

/** Einfacher Rhythmus: Bass auf jedem Schlag (Takt-Eins betont), Rauschen auf 2 und 4, Hi-Hat in Achteln. */
function drums(bpm: number, seconds: number, offset: number, seed = 1): Float32Array {
  const sr = BEAT_SAMPLE_RATE
  const out = new Float32Array(Math.round(seconds * sr))
  let s = seed
  const rnd = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    return s / 0x7fffffff - 0.5
  }
  const beat = 60 / bpm
  for (let i = 0; ; i++) {
    const at = offset + (i * beat) / 2
    if (at >= seconds) break
    const start = Math.round(at * sr)
    const onBeat = i % 2 === 0
    const beatIndex = i / 2
    for (let k = 0; k < sr * 0.25 && start + k < out.length; k++) {
      const t = k / sr
      let v = 0
      if (onBeat) {
        const accent = beatIndex % 4 === 0 ? 1 : 0.45
        v += accent * 0.8 * Math.sin(2 * Math.PI * 55 * t) * Math.exp(-t * 12)
        if (beatIndex % 2 === 1) v += 0.35 * rnd() * Math.exp(-t * 25)
      }
      v += 0.08 * rnd() * Math.exp(-t * 80)
      out[start + k] += v
    }
  }
  return out
}

describe('Takt-Erkennung', () => {
  it('findet Tempo, Schläge und Takt-Anfang eines gleichmäßigen Rhythmus', () => {
    const r = analyzeSamples(drums(120, 30, 0.37))
    expect(r.bpm).toBeGreaterThan(118.5)
    expect(r.bpm).toBeLessThan(121.5)
    // Jeder gefundene Schlag liegt höchstens 35 ms neben einem echten.
    for (const b of r.beats) {
      const k = Math.round((b - 0.37) / 0.5)
      expect(Math.abs(b - (0.37 + k * 0.5))).toBeLessThan(0.035)
    }
    expect(r.beats.length).toBeGreaterThan(50)
    // Der erste Takt-Anfang ist ein betonter Schlag (Index 0, 4, 8 … der echten Schläge).
    const first = r.beats[r.downbeat]
    const k = Math.round((first - 0.37) / 0.5)
    expect(Math.abs(k % 4)).toBe(0)
  })

  it.each([70, 90, 110, 150, 170, 190])('erkennt %i BPM samt Takt-Anfang', (bpm) => {
    const r = analyzeSamples(drums(bpm, 30, 0.2, bpm))
    expect(Math.abs(r.bpm - bpm)).toBeLessThan(bpm / 60)
    const k = Math.round((r.beats[r.downbeat] - 0.2) / (60 / bpm))
    expect(Math.abs(k % 4)).toBe(0)
  })

  it('Stille ergibt keine Schläge', () => {
    expect(analyzeSamples(new Float32Array(BEAT_SAMPLE_RATE * 10))).toEqual({
      bpm: 0,
      beats: [],
      downbeat: 0,
    })
  })

  it('zu kurzer Ton ergibt keine Schläge', () => {
    expect(analyzeSamples(drums(120, 1, 0)).beats).toEqual([])
  })

  it('Rohdaten in beliebigen Stücken ergeben dieselbe Einsatzkurve', () => {
    const f = drums(100, 3, 0.2)
    const bytes = new Uint8Array(f.length * 2)
    f.forEach((v, i) => {
      const x = Math.max(-32768, Math.min(32767, Math.round(v * 32768)))
      bytes[i * 2] = x & 0xff
      bytes[i * 2 + 1] = (x >> 8) & 0xff
    })
    const a = new OnsetReducer()
    a.push(bytes)
    const b = new OnsetReducer()
    for (let i = 0; i < bytes.length; i += 333) b.push(bytes.subarray(i, i + 333))
    expect(b.finish().flux).toEqual(a.finish().flux)
  })

  it('prüft gespeicherte Ergebnisse', () => {
    expect(parseBeatAnalysis({ bpm: 120, beats: [0.5, 1], downbeat: 1 })).toEqual({
      bpm: 120,
      beats: [0.5, 1],
      downbeat: 1,
    })
    expect(parseBeatAnalysis({ bpm: 120, beats: [0.5], downbeat: 4 })).toBeNull()
    expect(parseBeatAnalysis({ bpm: 120, beats: ['x'], downbeat: 0 })).toBeNull()
    expect(parseBeatAnalysis(null)).toBeNull()
  })

  it('FFmpeg liest nur die erste Tonspur als Mono-Rohdaten', () => {
    const args = buildBeatArgs('/x/in.mp4')
    expect(args).toEqual(expect.arrayContaining(['-map', '0:a:0', '-ac', '1', '-f', 's16le']))
    expect(args[args.length - 1]).toBe('pipe:1')
  })
})

describe('BeatStore', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'beats-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const ID = '01234567-89ab-cdef-0123-456789abcdef'
  function media(hasAudio = true) {
    const removers: ((id: string) => void)[] = []
    const used: string[] = []
    return {
      used,
      removers,
      get: (id: string) =>
        id === ID ? ({ id, path: '/x/in.mp4', info: { hasAudio } } as never) : undefined,
      acquire: (ids: string[]) => void used.push(...ids.map((i) => `+${i}`)),
      release: async (ids: string[]) => void used.push(...ids.map((i) => `-${i}`)),
      onRemove: (fn: (id: string) => void) => void removers.push(fn),
    }
  }

  it('rechnet einmal, teilt gleichzeitige Anfragen und speichert das Ergebnis', async () => {
    const m = media()
    let runs = 0
    const result: BeatAnalysis = { bpm: 120, beats: [0.5, 1, 1.5], downbeat: 0 }
    const store = new BeatStore(
      (id) => path.join(dir, id),
      m,
      1000,
      async () => {
        runs++
        return result
      },
    )
    const [a, b] = await Promise.all([store.get(ID), store.get(ID)])
    expect(a).toEqual(result)
    expect(b).toEqual(result)
    expect(runs).toBe(1)
    expect(m.used).toEqual([`+${ID}`, `-${ID}`])
    const saved = JSON.parse(await readFile(path.join(dir, ID, 'beats.json'), 'utf8'))
    expect(saved).toMatchObject({ version: 1, ...result })
    // Neuer Store (Neustart): liest die Datei statt neu zu rechnen.
    const again = new BeatStore(
      (id) => path.join(dir, id),
      media(),
      1000,
      async () => {
        throw new Error('soll nicht rechnen')
      },
    )
    expect(await again.get(ID)).toEqual(result)
  })

  it('unbekanntes Medium -> null, ohne Ton -> leer', async () => {
    const run = async () => ({ bpm: 1, beats: [1], downbeat: 0 })
    expect(await new BeatStore(() => dir, media(), 1000, run).get('nope')).toBeNull()
    expect(await new BeatStore(() => dir, media(false), 1000, run).get(ID)).toEqual({
      bpm: 0,
      beats: [],
      downbeat: 0,
    })
  })

  it('Fehler wird gemeldet und blockiert spätere Anfragen nicht', async () => {
    let fail = true
    const store = new BeatStore(
      (id) => path.join(dir, id),
      media(),
      1000,
      async () => {
        if (fail) throw new Error('kaputt')
        return { bpm: 90, beats: [1, 2], downbeat: 0 }
      },
    )
    await expect(store.get(ID)).rejects.toThrow('kaputt')
    fail = false
    expect(await store.get(ID)).toMatchObject({ bpm: 90 })
  })
})

describe('Takt-Erkennung mit FFmpeg', () => {
  it('liest eine echte Datei', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'beats-ff-'))
    try {
      const wav = path.join(dir, 'd.wav')
      const f = drums(128, 12, 0.25)
      const bytes = Buffer.alloc(44 + f.length * 2)
      bytes.write('RIFF', 0)
      bytes.writeUInt32LE(36 + f.length * 2, 4)
      bytes.write('WAVEfmt ', 8)
      bytes.writeUInt32LE(16, 16)
      bytes.writeUInt16LE(1, 20)
      bytes.writeUInt16LE(1, 22)
      bytes.writeUInt32LE(BEAT_SAMPLE_RATE, 24)
      bytes.writeUInt32LE(BEAT_SAMPLE_RATE * 2, 28)
      bytes.writeUInt16LE(2, 32)
      bytes.writeUInt16LE(16, 34)
      bytes.write('data', 36)
      bytes.writeUInt32LE(f.length * 2, 40)
      f.forEach((v, i) =>
        bytes.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32768))), 44 + i * 2),
      )
      const mp3 = path.join(dir, 'd.m4a')
      await import('node:fs/promises').then((fs) => fs.writeFile(wav, bytes))
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', wav, '-c:a', 'aac', mp3])
      const store = new BeatStore(
        (id) => path.join(dir, id),
        {
          get: () => ({ id: 'x', path: mp3, info: { hasAudio: true } }) as never,
          acquire: () => {},
          release: async () => {},
          onRemove: () => {},
        },
        30_000,
      )
      const r = await store.get('01234567-89ab-cdef-0123-456789abcdef')
      expect(Math.abs((r?.bpm ?? 0) - 128)).toBeLessThan(2)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
