import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { config } from '../../config'
import type { CompiledTimeline } from './compile'
import type { RenderDoc } from './doc'

/**
 * Lautheit des fertigen Tons messen (Qualitäts-Check vor dem Export).
 *
 * Gemessen wird die Mischung, die auch der Export schreibt: derselbe Compiler,
 * aber nur mit den Ton-Spuren (das Bild ist ein winziges Farbbild, das FFmpeg
 * gleich wieder verwirft). FFmpegs `ebur128` liefert alle 100 ms die
 * Momentan-Lautheit (EBU R128, 400-ms-Fenster) und die Spitze des Abschnitts,
 * am Ende die integrierte Lautheit, den Lautheitsumfang und die echte Spitze.
 */

/** Abstand der Messwerte in Sekunden (fest bei `ebur128`). */
export const LOUDNESS_STEP = 0.1
/** Untergrenzen: Stille liefert -120 LUFS bzw. -inf dBFS. */
export const LUFS_FLOOR = -70
export const DBFS_FLOOR = -99

export interface LoudnessResult {
  /** Integrierte Lautheit in LUFS (Stille: -70). */
  integrated: number
  /** Lautheitsumfang (LRA) in LU. */
  range: number
  /** Höchste echte Spitze (True Peak) in dBFS. */
  truePeak: number
  /** Abstand der Messwerte in Sekunden. */
  step: number
  /** Momentan-Lautheit je Schritt (Fenster endet beim Schritt), LUFS. */
  momentary: number[]
  /** Spitze je Schritt in dBFS. */
  peak: number[]
}

/** Nur die Ton-Spuren: Bild, Texte, Grafiken und Effekte spielen für den Ton keine Rolle. */
export function audioOnlyDoc(doc: RenderDoc): RenderDoc {
  const { effects: _effects, ...rest } = doc
  return { ...rest, tracks: doc.tracks.filter((t) => t.kind === 'audio'), markers: [] }
}

/** FFmpeg-Argumente: Mischung messen, nichts schreiben. */
export function buildLoudnessArgs(compiled: CompiledTimeline): string[] {
  return [
    '-hide_banner',
    '-nostdin',
    '-nostats',
    ...compiled.inputs,
    '-filter_complex',
    `${compiled.filter};[aout]ebur128=peak=true:framelog=info[aq];[vout]nullsink`,
    '-map',
    '[aq]',
    '-t',
    compiled.duration.toFixed(6),
    '-f',
    'null',
    '-',
  ]
}

const round1 = (v: number) => Math.round(v * 10) / 10

/** Zahl aus der Ausgabe; `-inf`/`nan` werden zur Untergrenze. */
function level(raw: string, floor: number): number {
  const v = Number(raw)
  return Number.isFinite(v) ? Math.max(floor, round1(v)) : floor
}

const FRAME_RE = /\bt:\s*([\d.]+)\s+TARGET:.*?\bM:\s*(\S+)\s+S:.*?\bFTPK:\s*((?:-?[\w.]+\s+)+)dBFS/
const SUMMARY_I_RE = /Integrated loudness:\s*\n\s*I:\s*(\S+)\s*LUFS/
const SUMMARY_LRA_RE = /Loudness range:\s*\n\s*LRA:\s*(\S+)\s*LU/
const SUMMARY_PEAK_RE = /True peak:\s*\n\s*Peak:\s*(\S+)\s*dBFS/

/**
 * Liest die Ausgabe von `ebur128` (stderr). Je Zeile ein Schritt; bei Stereo
 * stehen zwei Spitzen da, es zählt die größere. Fehlt die Zusammenfassung,
 * gibt es `null`.
 */
export function parseEbur128(log: string, duration: number): LoudnessResult | null {
  const steps = Math.max(0, Math.round(duration / LOUDNESS_STEP))
  const momentary: number[] = new Array(steps).fill(LUFS_FLOOR)
  const peak: number[] = new Array(steps).fill(DBFS_FLOOR)
  for (const line of log.split('\n')) {
    const m = FRAME_RE.exec(line)
    if (!m) continue
    // t = Ende des Schritts; Schritt i deckt [i·0,1 s, (i+1)·0,1 s) ab.
    const i = Math.round(Number(m[1]) / LOUDNESS_STEP) - 1
    if (!(i >= 0 && i < steps)) continue
    momentary[i] = level(m[2], LUFS_FLOOR)
    peak[i] = Math.max(
      ...m[3]
        .trim()
        .split(/\s+/)
        .map((p) => level(p, DBFS_FLOOR)),
    )
  }
  const i = SUMMARY_I_RE.exec(log)
  const lra = SUMMARY_LRA_RE.exec(log)
  const tp = SUMMARY_PEAK_RE.exec(log)
  if (!i || !lra || !tp) return null
  return {
    integrated: level(i[1], LUFS_FLOOR),
    range: Math.max(0, level(lra[1], 0)),
    truePeak: level(tp[1], DBFS_FLOOR),
    step: LOUDNESS_STEP,
    momentary,
    peak,
  }
}

/** Schlüssel einer Messung: Gleiche Eingaben und Filter = gleiches Ergebnis. */
export function loudnessKey(args: readonly string[]): string {
  return createHash('sha1').update(JSON.stringify(args)).digest('hex')
}

/** Misst; wirft bei FFmpeg-Fehler oder Zeitüberschreitung. */
export function runLoudness(
  args: string[],
  duration: number,
  timeoutMs: number = config.ffmpegTimeoutMs,
): Promise<LoudnessResult> {
  const proc = spawn(config.ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] })
  // Die Zeilen je Schritt werden gebraucht: alles behalten (≈ 150 Byte je 0,1 s).
  const chunks: Buffer[] = []
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    proc.kill('SIGKILL')
  }, timeoutMs)
  proc.stderr.on('data', (chunk: Buffer) => chunks.push(chunk))
  return new Promise<LoudnessResult>((resolve, reject) => {
    proc.on('error', (err) => {
      clearTimeout(timer)
      reject(new Error(`FFmpeg konnte nicht gestartet werden: ${err.message}`))
    })
    proc.on('close', (code) => {
      clearTimeout(timer)
      const log = Buffer.concat(chunks).toString()
      if (timedOut) return reject(new Error('Zeitlimit überschritten.'))
      if (code !== 0)
        return reject(new Error(`FFmpeg-Fehler (Code ${code}). ${log.trim().slice(-300)}`))
      const result = parseEbur128(log, duration)
      if (!result) reject(new Error('Messung ohne Ergebnis.'))
      else resolve(result)
    })
  })
}

/** Zuletzt gemessene Ergebnisse (der Dialog wird oft mehrmals geöffnet). */
export class LoudnessCache {
  private readonly items = new Map<string, LoudnessResult>()
  constructor(private readonly max = 20) {}

  get(key: string): LoudnessResult | undefined {
    const hit = this.items.get(key)
    if (hit) {
      this.items.delete(key)
      this.items.set(key, hit)
    }
    return hit
  }

  set(key: string, value: LoudnessResult): void {
    this.items.delete(key)
    this.items.set(key, value)
    while (this.items.size > this.max) {
      const oldest = this.items.keys().next().value
      if (oldest === undefined) break
      this.items.delete(oldest)
    }
  }
}
