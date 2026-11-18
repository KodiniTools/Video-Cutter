import { spawn } from 'node:child_process'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { config } from '../config'
import { derivedStore } from './derived'
import { isMediaId, mediaStore, type MediaStore } from './media'

/**
 * Takt einer Tonspur erkennen – ohne KI, nur mit Signalverarbeitung:
 *
 *  1. FFmpeg liefert den Ton als Mono, 22 050 Hz, 16 Bit.
 *  2. Kurze Fenster (1024 Werte, Abstand 256 ≈ 11,6 ms) werden per FFT in
 *     Frequenzen zerlegt; die Zunahme der (logarithmischen) Lautstärke je
 *     Frequenz ergibt eine „Einsatzkurve“ (spectral flux): hoch, wo ein
 *     Schlag einsetzt.
 *  3. Das Tempo ist der Abstand, in dem sich die Einsatzkurve am stärksten
 *     wiederholt (Autokorrelation, mit Vorliebe für Tempi um 120 BPM).
 *  4. Die Schläge selbst legt eine dynamische Programmierung (Ellis 2007)
 *     auf die Einsätze, wobei die Abstände nah am Tempo bleiben müssen.
 *  5. Der erste Schlag eines Takts ist der, an dem im Bass (unter 150 Hz)
 *     über alle Takte hinweg am meisten einsetzt (4/4-Takt angenommen).
 */

export const BEAT_SAMPLE_RATE = 22050
const FFT_SIZE = 1024
const HOP = 256
/** Analyse-Bilder je Sekunde. */
export const BEAT_FPS = BEAT_SAMPLE_RATE / HOP
/** Tempo-Bereich der Suche (BPM). */
export const MIN_BPM = 60
export const MAX_BPM = 200
/** Vorliebe der Tempo-Suche (wie librosa: 120 BPM, Breite eine Oktave). */
const PRIOR_BPM = 120
/** Wie streng die Schlag-Abstände dem Tempo folgen (librosa: 100). */
const TIGHTNESS = 100
/** Frequenzbänder der Einsatzkurve. */
const BANDS = 40
const BAND_MIN_HZ = 30
const BAND_MAX_HZ = 11000
/** Bass-Grenze für die Takt-Erkennung (Hz). */
const LOW_BAND_HZ = 150
/** Länger wird nicht analysiert (Sekunden). */
export const MAX_BEAT_SECONDS = 60 * 60
/** Schläge je Takt (4/4 angenommen). */
export const BEATS_PER_BAR = 4

export interface BeatAnalysis {
  /** Tempo in Schlägen je Minute (aus dem mittleren Abstand der Schläge); 0 = keins. */
  bpm: number
  /** Zeiten der Schläge in Sekunden ab Beginn der Datei, aufsteigend. */
  beats: number[]
  /** Index (0–3) des ersten Schlags, der einen Takt beginnt. */
  downbeat: number
}

// --- FFT ----------------------------------------------------------------------

/** In-place-FFT (Radix 2) auf Real-/Imaginärteil; `n` ist eine Zweierpotenz. */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      let t = re[i]
      re[i] = re[j]
      re[j] = t
      t = im[i]
      im[i] = im[j]
      im[j] = t
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wr = Math.cos(ang)
    const wi = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cr = 1
      let ci = 0
      for (let k = 0; k < len / 2; k++) {
        const a = i + k
        const b = a + len / 2
        const xr = re[b] * cr - im[b] * ci
        const xi = re[b] * ci + im[b] * cr
        re[b] = re[a] - xr
        im[b] = im[a] - xi
        re[a] += xr
        im[a] += xi
        const nr = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = nr
      }
    }
  }
}

// --- Einsatzkurve -------------------------------------------------------------

/**
 * Berechnet die Einsatzkurve stückweise aus rohen Tondaten (16 Bit, mono,
 * little endian) – ohne die ganze Datei im Speicher zu halten. Fenster `t`
 * ist um die Zeit `t * HOP / Abtastrate` zentriert.
 */
export class OnsetReducer {
  private readonly window = new Float64Array(FFT_SIZE)
  /** Ringpuffer der letzten FFT_SIZE Werte. */
  private readonly ring = new Float64Array(FFT_SIZE)
  private pos = 0
  private sinceHop = 0
  private readonly re = new Float64Array(FFT_SIZE)
  private readonly im = new Float64Array(FFT_SIZE)
  private prev: Float64Array | null = null
  /** Frequenzbänder (logarithmisch verteilt) als Bereiche von FFT-Bins. */
  private readonly bands: { from: number; to: number; low: boolean }[] = []
  private carry: number | null = null
  private samples = 0
  private readonly maxSamples: number
  readonly flux: number[] = []
  readonly lowFlux: number[] = []

  constructor(maxSeconds = MAX_BEAT_SECONDS) {
    for (let i = 0; i < FFT_SIZE; i++)
      this.window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FFT_SIZE)
    // Bänder wie beim Gehör (ähnlich Mel): Sonst überstimmen breitbandige
    // Becken mit ihren vielen hohen Bins die Bassdrum.
    const hz = BEAT_SAMPLE_RATE / FFT_SIZE
    let from = 1
    for (let b = 1; b <= BANDS; b++) {
      const edge = BAND_MIN_HZ * (BAND_MAX_HZ / BAND_MIN_HZ) ** (b / BANDS)
      const to = Math.min(FFT_SIZE / 2, Math.max(from + 1, Math.round(edge / hz)))
      if (to > from) {
        this.bands.push({ from, to, low: to * hz <= LOW_BAND_HZ + hz })
        from = to
      }
      if (from >= FFT_SIZE / 2) break
    }
    this.maxSamples = Math.round(maxSeconds * BEAT_SAMPLE_RATE)
    // Wie `center=True`: Das erste Fenster ist um die Zeit 0 zentriert.
    this.pos = FFT_SIZE / 2
    this.sinceHop = FFT_SIZE / 2
  }

  /** Rohe Bytes (s16le) annehmen; ein Stück darf mitten in einem Wert enden. */
  push(chunk: Uint8Array): void {
    let i = 0
    if (this.carry !== null && chunk.length > 0) {
      this.sample(this.carry | (chunk[0] << 8))
      this.carry = null
      i = 1
    }
    for (; i + 1 < chunk.length; i += 2) this.sample(chunk[i] | (chunk[i + 1] << 8))
    if (i < chunk.length) this.carry = chunk[i]
  }

  /** Werte im Bereich −1…1 annehmen (für Tests). */
  pushFloats(values: ArrayLike<number>): void {
    for (let i = 0; i < values.length; i++) this.add(values[i])
  }

  private sample(unsigned: number): void {
    const v = unsigned >= 0x8000 ? unsigned - 0x10000 : unsigned
    this.add(v / 32768)
  }

  private add(v: number): void {
    if (this.samples >= this.maxSamples) return
    this.samples++
    this.ring[this.pos % FFT_SIZE] = v
    this.pos++
    if (++this.sinceHop >= HOP && this.pos >= FFT_SIZE) {
      this.sinceHop = 0
      this.frame()
    }
  }

  private frame(): void {
    const start = this.pos - FFT_SIZE
    for (let i = 0; i < FFT_SIZE; i++) {
      this.re[i] = this.ring[(start + i) % FFT_SIZE] * this.window[i]
      this.im[i] = 0
    }
    fft(this.re, this.im)
    const bins = FFT_SIZE / 2
    const mag = new Float64Array(this.bands.length)
    this.bands.forEach((band, i) => {
      let sum = 0
      for (let k = band.from; k < band.to; k++) sum += Math.hypot(this.re[k], this.im[k])
      // Logarithmisch: leise und laute Stücke zählen ähnlich.
      mag[i] = Math.log1p(100 * (sum / (band.to - band.from) / bins))
    })
    let all = 0
    let low = 0
    if (this.prev) {
      for (let i = 0; i < mag.length; i++) {
        const d = mag[i] - this.prev[i]
        if (d > 0) {
          all += d
          if (this.bands[i].low) low += d
        }
      }
    }
    this.prev = mag
    this.flux.push(all)
    this.lowFlux.push(low)
  }

  /** Abschluss: Rest mit Stille auffüllen, damit das Ende ein Fenster bekommt. */
  finish(): { flux: number[]; lowFlux: number[] } {
    for (let i = 0; i < FFT_SIZE / 2; i++) {
      this.ring[this.pos % FFT_SIZE] = 0
      this.pos++
      if (++this.sinceHop >= HOP && this.pos >= FFT_SIZE) {
        this.sinceHop = 0
        this.frame()
      }
    }
    return { flux: this.flux, lowFlux: this.lowFlux }
  }
}

// --- Auswertung ---------------------------------------------------------------

function mean(a: ArrayLike<number>): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i]
  return a.length ? s / a.length : 0
}

function std(a: ArrayLike<number>): number {
  const m = mean(a)
  let s = 0
  for (let i = 0; i < a.length; i++) s += (a[i] - m) ** 2
  return a.length ? Math.sqrt(s / a.length) : 0
}

/** Gleitender Mittelwert über ±`half` Werte. */
function movingMean(a: ArrayLike<number>, half: number): Float64Array {
  const out = new Float64Array(a.length)
  let sum = 0
  let lo = 0
  let hi = -1
  for (let i = 0; i < a.length; i++) {
    const from = Math.max(0, i - half)
    const to = Math.min(a.length - 1, i + half)
    while (hi < to) sum += a[++hi]
    while (lo < from) sum -= a[lo++]
    out[i] = sum / (hi - lo + 1)
  }
  return out
}

/** Einsatzkurve ohne langsame Schwankungen, auf Standardabweichung 1. */
export function normalizeOnsets(flux: ArrayLike<number>): Float64Array {
  const local = movingMean(flux, Math.round(BEAT_FPS * 0.2))
  const out = new Float64Array(flux.length)
  for (let i = 0; i < flux.length; i++) out[i] = Math.max(0, flux[i] - local[i])
  const s = std(out)
  if (!(s > 1e-9)) return new Float64Array(flux.length)
  for (let i = 0; i < out.length; i++) out[i] /= s
  return out
}

/**
 * Abstand der Schläge in Analyse-Bildern (gebrochen), oder `null` ohne
 * erkennbare Wiederholung.
 */
export function estimatePeriod(onset: Float64Array): number | null {
  const minLag = Math.floor((60 * BEAT_FPS) / MAX_BPM)
  const maxLag = Math.ceil((60 * BEAT_FPS) / MIN_BPM)
  const n = onset.length
  if (n < maxLag * 4) return null
  // Leicht geglättet: Ein Schlag-Abstand liegt selten genau auf ganzen Bildern.
  const smooth = new Float64Array(n)
  for (let i = 0; i < n; i++)
    smooth[i] = 0.5 * onset[i] + 0.25 * ((onset[i - 1] ?? 0) + (onset[i + 1] ?? 0))
  const score = new Float64Array(maxLag + 2)
  for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
    let s = 0
    for (let i = lag; i < n; i++) s += smooth[i] * smooth[i - lag]
    score[lag] = s / (n - lag)
  }
  let best = -1
  let bestValue = 0
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = (60 * BEAT_FPS) / lag
    const prior = Math.exp(-0.5 * Math.log2(bpm / PRIOR_BPM) ** 2)
    const v = score[lag] * prior
    if (v > bestValue) {
      bestValue = v
      best = lag
    }
  }
  if (best < 0) return null
  // Takte mit betonter Eins wiederholen sich im doppelten Abstand oft stärker
  // als die Schläge selbst. Unter 100 BPM: Trägt auch der halbe Abstand
  // deutlich, ist das der eigentliche Schlag.
  const half = Math.round(best / 2)
  if ((60 * BEAT_FPS) / best < 100 && half - 1 >= minLag - 1) {
    const halfScore = Math.max(score[half - 1], score[half], score[half + 1])
    if (halfScore >= 0.5 * score[best]) {
      best =
        score[half - 1] > score[half] && score[half - 1] >= score[half + 1]
          ? half - 1
          : score[half + 1] > score[half]
            ? half + 1
            : half
    }
  }
  // Parabel durch die Nachbarn: Abstand genauer als ein Analyse-Bild.
  const a = score[best - 1]
  const b = score[best]
  const c = score[best + 1]
  const denom = a - 2 * b + c
  const shift = denom < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / denom)) : 0
  return best + shift
}

/** Schläge (Analyse-Bilder) per dynamischer Programmierung (Ellis 2007). */
export function trackBeats(onset: Float64Array, period: number): number[] {
  const n = onset.length
  if (n === 0 || !(period > 0)) return []
  // Einsätze leicht glätten (Gauß, Breite period/32 wie librosa).
  const sigma = Math.max(0.5, period / 32)
  const radius = Math.ceil(sigma * 3)
  const kernel: number[] = []
  for (let k = -radius; k <= radius; k++) kernel.push(Math.exp(-0.5 * (k / sigma) ** 2))
  const local = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    let s = 0
    for (let k = -radius; k <= radius; k++) {
      const j = i + k
      if (j >= 0 && j < n) s += onset[j] * kernel[k + radius]
    }
    local[i] = s
  }

  const cum = new Float64Array(n)
  const back = new Int32Array(n).fill(-1)
  const lo = Math.max(1, Math.round(period / 2))
  const hi = Math.round(period * 2)
  // Strafe für einen Abstand `d`, der vom Tempo abweicht.
  const penalty = new Float64Array(hi + 1)
  for (let d = lo; d <= hi; d++) penalty[d] = TIGHTNESS * Math.log(d / period) ** 2
  for (let t = 0; t < n; t++) {
    let best = -Infinity
    let from = -1
    for (let tau = Math.max(0, t - hi); tau <= t - lo; tau++) {
      const v = cum[tau] - penalty[t - tau]
      if (v > best) {
        best = v
        from = tau
      }
    }
    cum[t] = local[t] + (from >= 0 ? best : 0)
    back[t] = from
  }

  // Letzter Schlag: das letzte deutliche Maximum der aufsummierten Punkte.
  const peaks: number[] = []
  for (let t = 1; t < n - 1; t++) if (cum[t] >= cum[t - 1] && cum[t] > cum[t + 1]) peaks.push(t)
  if (peaks.length === 0) return []
  const values = peaks.map((t) => cum[t]).sort((a, b) => a - b)
  const median = values[Math.floor(values.length / 2)]
  let last = peaks[peaks.length - 1]
  for (let i = peaks.length - 1; i >= 0; i--) {
    if (cum[peaks[i]] >= 0.5 * median) {
      last = peaks[i]
      break
    }
  }
  const beats: number[] = []
  for (let t = last; t >= 0; t = back[t]) beats.push(t)
  beats.reverse()

  // Schläge im leisen Vor- und Nachspann weglassen.
  const rms = Math.sqrt(mean(Array.from(local, (v) => v * v)))
  const strong = (t: number) => local[t] >= 0.5 * rms
  let a = 0
  let b = beats.length
  while (a < b && !strong(beats[a])) a++
  while (b > a && !strong(beats[b - 1])) b--
  return beats.slice(a, b)
}

/** Index (0–3) des ersten Takt-Anfangs: Phase mit dem meisten Bass-Einsatz. */
export function findDownbeat(beatFrames: readonly number[], lowFlux: ArrayLike<number>): number {
  if (beatFrames.length < BEATS_PER_BAR * 2) return 0
  const sums = new Array<number>(BEATS_PER_BAR).fill(0)
  const counts = new Array<number>(BEATS_PER_BAR).fill(0)
  beatFrames.forEach((t, i) => {
    let v = 0
    for (let k = t - 2; k <= t + 2; k++)
      if (k >= 0 && k < lowFlux.length) v = Math.max(v, lowFlux[k])
    sums[i % BEATS_PER_BAR] += v
    counts[i % BEATS_PER_BAR]++
  })
  let best = 0
  for (let k = 1; k < BEATS_PER_BAR; k++)
    if (sums[k] / counts[k] > sums[best] / counts[best] + 1e-9) best = k
  return best
}

/** Gesamte Auswertung aus der Einsatzkurve. */
export function analyzeOnsets(flux: ArrayLike<number>, lowFlux: ArrayLike<number>): BeatAnalysis {
  const onset = normalizeOnsets(flux)
  const period = estimatePeriod(onset)
  if (period === null) return { bpm: 0, beats: [], downbeat: 0 }
  const frames = trackBeats(onset, period)
  if (frames.length < 2) return { bpm: 0, beats: [], downbeat: 0 }
  const beats = frames.map((t) => Math.round((t / BEAT_FPS) * 1000) / 1000)
  // Mittlerer Abstand über alle Schläge: genauer als ein einzelner Abstand.
  const gap = (frames[frames.length - 1] - frames[0]) / (frames.length - 1) / BEAT_FPS
  const bpm = gap > 0 ? Math.round((60 / gap) * 10) / 10 : 0
  return { bpm, beats, downbeat: findDownbeat(frames, lowFlux) }
}

/** Takt aus Werten −1…1 (für Tests und kurze Stücke). */
export function analyzeSamples(samples: ArrayLike<number>): BeatAnalysis {
  const reducer = new OnsetReducer()
  reducer.pushFloats(samples)
  const { flux, lowFlux } = reducer.finish()
  return analyzeOnsets(flux, lowFlux)
}

// --- Ablauf auf dem Server ----------------------------------------------------

export function buildBeatArgs(input: string): string[] {
  return [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'error',
    '-t',
    String(MAX_BEAT_SECONDS),
    '-i',
    input,
    '-vn',
    '-map',
    '0:a:0',
    '-ac',
    '1',
    '-ar',
    String(BEAT_SAMPLE_RATE),
    '-f',
    's16le',
    'pipe:1',
  ]
}

/** Liest die Tonspur mit FFmpeg und wertet sie aus. */
function runBeats(input: string, timeoutMs: number): Promise<BeatAnalysis> {
  const proc = spawn(config.ffmpegPath, buildBeatArgs(input), {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const reducer = new OnsetReducer()
  let stderrTail = ''
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    proc.kill('SIGKILL')
  }, timeoutMs)
  proc.stdout.on('data', (chunk: Buffer) => reducer.push(chunk))
  proc.stderr.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-2048)
  })
  return new Promise<BeatAnalysis>((resolve, reject) => {
    proc.on('error', (err) => {
      clearTimeout(timer)
      reject(new Error(`FFmpeg konnte nicht gestartet werden: ${err.message}`))
    })
    proc.on('close', (code) => {
      clearTimeout(timer)
      if (timedOut) reject(new Error('Zeitlimit überschritten.'))
      else if (code !== 0)
        reject(new Error(`FFmpeg-Fehler (Code ${code}). ${stderrTail.trim().slice(-300)}`))
      else {
        const { flux, lowFlux } = reducer.finish()
        resolve(analyzeOnsets(flux, lowFlux))
      }
    })
  })
}

/** Gespeichertes Ergebnis prüfen (Datei kann beschädigt oder alt sein). */
export function parseBeatAnalysis(raw: unknown): BeatAnalysis | null {
  if (!raw || typeof raw !== 'object') return null
  const d = raw as Record<string, unknown>
  if (typeof d.bpm !== 'number' || !Number.isFinite(d.bpm) || d.bpm < 0) return null
  if (!Array.isArray(d.beats) || !d.beats.every((b) => typeof b === 'number' && b >= 0)) return null
  const downbeat = d.downbeat
  if (typeof downbeat !== 'number' || !Number.isInteger(downbeat) || downbeat < 0) return null
  if (downbeat >= BEATS_PER_BAR) return null
  return { bpm: d.bpm, beats: d.beats as number[], downbeat }
}

const BEATS_FILE = 'beats.json'
/** Version der Auswertung; ändert sich das Verfahren, wird neu gerechnet. */
const BEATS_VERSION = 1

/**
 * Ergebnisse je Medium: im Speicher und als `beats.json` neben den übrigen
 * abgeleiteten Dateien (wird mit dem Medium gelöscht). Immer nur eine
 * Auswertung zur Zeit; gleichzeitige Anfragen für dasselbe Medium teilen sich
 * die laufende.
 */
export class BeatStore {
  private cache = new Map<string, BeatAnalysis>()
  private pending = new Map<string, Promise<BeatAnalysis>>()
  private chain: Promise<unknown> = Promise.resolve()

  constructor(
    private dirOf: (id: string) => string = (id) => derivedStore.dir(id),
    private media: Pick<MediaStore, 'get' | 'acquire' | 'release' | 'onRemove'> = mediaStore,
    private timeoutMs = config.derivedTimeoutMs,
    private run: (input: string, timeoutMs: number) => Promise<BeatAnalysis> = runBeats,
  ) {
    this.media.onRemove((id) => this.cache.delete(id))
  }

  /**
   * Takt eines Mediums; `null`, wenn es das Medium nicht gibt. Ohne Tonspur
   * ist das Ergebnis leer.
   */
  async get(id: string): Promise<BeatAnalysis | null> {
    const item = isMediaId(id) ? this.media.get(id) : undefined
    if (!item) return null
    if (!item.info.hasAudio) return { bpm: 0, beats: [], downbeat: 0 }
    const hit = this.cache.get(id) ?? (await this.load(id))
    if (hit) return hit
    let job = this.pending.get(id)
    if (!job) {
      job = this.chain.then(() => this.compute(id, item.path))
      this.chain = job.catch(() => {})
      this.pending.set(id, job)
      void job.finally(() => this.pending.delete(id)).catch(() => {})
    }
    return job
  }

  private async load(id: string): Promise<BeatAnalysis | null> {
    const raw = await readFile(path.join(this.dirOf(id), BEATS_FILE), 'utf8').catch(() => '')
    if (!raw) return null
    try {
      const data = JSON.parse(raw) as { version?: unknown }
      if (data.version !== BEATS_VERSION) return null
      const parsed = parseBeatAnalysis(data)
      if (parsed) this.cache.set(id, parsed)
      return parsed
    } catch {
      return null
    }
  }

  private async compute(id: string, input: string): Promise<BeatAnalysis> {
    this.media.acquire([id])
    try {
      const result = await this.run(input, this.timeoutMs)
      this.cache.set(id, result)
      try {
        const dir = this.dirOf(id)
        await mkdir(dir, { recursive: true })
        const file = path.join(dir, BEATS_FILE)
        await writeFile(`${file}.tmp`, JSON.stringify({ version: BEATS_VERSION, ...result }))
        await rename(`${file}.tmp`, file)
      } catch (err) {
        console.error(`Takt für ${id} nicht gespeichert:`, err)
      }
      return result
    } finally {
      await this.media.release([id])
    }
  }
}

export const beatStore = new BeatStore()
