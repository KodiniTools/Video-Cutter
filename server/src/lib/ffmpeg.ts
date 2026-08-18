import { spawn } from 'node:child_process'
import { config } from '../config'

export interface RunHandle {
  promise: Promise<void>
  kill: () => void
}

/**
 * Startet FFmpeg via `spawn` (keine Shell). Parst `-progress`-Ausgabe von
 * stdout und meldet Prozent zurück. Bricht nach `ffmpegTimeoutMs` hart ab.
 */
export function runFfmpeg(
  args: string[],
  durationSec: number,
  onProgress: (percent: number) => void,
): RunHandle {
  const proc = spawn(config.ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })

  let stderrTail = ''
  let timedOut = false

  const timer = setTimeout(() => {
    timedOut = true
    proc.kill('SIGKILL')
  }, config.ffmpegTimeoutMs)

  // stdout: key=value Zeilen (out_time_us, progress, ...)
  let buf = ''
  proc.stdout.on('data', (chunk: Buffer) => {
    buf += chunk.toString()
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      const eq = line.indexOf('=')
      if (eq < 0) continue
      const key = line.slice(0, eq)
      const value = line.slice(eq + 1)

      if (key === 'out_time_us' || key === 'out_time_ms') {
        const micros = key === 'out_time_us' ? Number(value) : Number(value) * 1000
        if (Number.isFinite(micros) && durationSec > 0) {
          const pct = (micros / 1_000_000 / durationSec) * 100
          onProgress(Math.min(99, Math.max(0, Math.round(pct))))
        }
      } else if (key === 'progress' && value === 'end') {
        onProgress(100)
      }
    }
  })

  // stderr: nur das Ende behalten (für Fehlermeldungen)
  proc.stderr.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-4096)
  })

  const promise = new Promise<void>((resolve, reject) => {
    proc.on('error', (err) => {
      clearTimeout(timer)
      reject(new Error(`FFmpeg konnte nicht gestartet werden: ${err.message}`))
    })
    proc.on('close', (code) => {
      clearTimeout(timer)
      if (timedOut) {
        reject(new Error('Zeitlimit überschritten – Job abgebrochen.'))
        return
      }
      if (code === 0) {
        resolve()
        return
      }
      const detail = stderrTail.split('\n').filter(Boolean).slice(-3).join(' ').trim()
      reject(new Error(`FFmpeg-Fehler (Code ${code}). ${detail}`))
    })
  })

  return {
    promise,
    kill: () => {
      clearTimeout(timer)
      proc.kill('SIGKILL')
    },
  }
}
