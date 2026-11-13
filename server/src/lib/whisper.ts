import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { config } from '../config'

/**
 * Lokale Transkription mit whisper.cpp (`whisper-cli`). Ablauf:
 * 1. FFmpeg zieht die Tonspur als 16-kHz-Mono-WAV heraus (Whisper-Eingabe).
 * 2. whisper-cli transkribiert Wort für Wort (`-ml 1 -sow`) und schreibt JSON.
 * Ergebnis: Wörter mit Start/Ende in Sekunden. Alle Prozesse via `spawn`
 * (keine Shell), abbrechbar über ein AbortSignal.
 */

/** Ein erkanntes Wort mit Zeitstempeln (Sekunden). */
export interface Word {
  start: number
  end: number
  text: string
}

export interface Transcript {
  /** Erkannte Sprache (ISO-Kürzel, z. B. "de"). */
  language: string
  words: Word[]
}

/** Erlaubte Sprachangaben für die Erkennung. */
export const TRANSCRIBE_LANGUAGES = ['auto', 'de', 'en'] as const
export type TranscribeLanguage = (typeof TRANSCRIBE_LANGUAGES)[number]

/** Liegt das Programm im PATH bzw. unter dem angegebenen Pfad? */
function binaryExists(bin: string): boolean {
  if (bin.includes('/') || bin.includes('\\')) return existsSync(bin)
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
  return dirs.some((d) => existsSync(path.join(d, bin)))
}

/** Ist die Transkription eingerichtet (Programm + Modell vorhanden)? */
export function whisperReady(): boolean {
  return (
    Boolean(config.whisperModel) &&
    existsSync(config.whisperModel) &&
    binaryExists(config.whisperPath)
  )
}

/**
 * Wertet die JSON-Ausgabe von whisper-cli (`-oj`) aus. Mit `-ml 1 -sow` ist
 * jedes Element von `transcription` ein Wort; `offsets` sind Millisekunden.
 * Rein (ohne Prozess) und daher direkt testbar.
 */
export function parseWhisperJson(json: string): Transcript {
  let data: {
    result?: { language?: unknown }
    transcription?: Array<{ offsets?: { from?: unknown; to?: unknown }; text?: unknown }>
  }
  try {
    data = JSON.parse(json) as typeof data
  } catch {
    throw new Error('Whisper lieferte ungültige Daten.')
  }
  const list = Array.isArray(data.transcription) ? data.transcription : []
  const words: Word[] = []
  for (const item of list) {
    const text = typeof item.text === 'string' ? item.text.trim() : ''
    const from = Number(item.offsets?.from)
    const to = Number(item.offsets?.to)
    // Leere Einträge und Steuer-Token wie "[_BEG_]" / "[Musik]" überspringen.
    if (!text || /^\[.*\]$/.test(text) || !Number.isFinite(from) || !Number.isFinite(to)) continue
    const start = Math.max(0, from / 1000)
    const end = Math.max(start, to / 1000)
    // Satzzeichen, die whisper als eigenes "Wort" liefert, an das vorige hängen.
    const prev = words[words.length - 1]
    if (prev && /^[.,!?;:…)»"']+$/.test(text)) {
      prev.text += text
      prev.end = Math.max(prev.end, end)
      continue
    }
    words.push({ start, end, text })
  }
  const lang = typeof data.result?.language === 'string' ? data.result.language : ''
  return { language: lang || 'auto', words }
}

interface ProcResult {
  code: number | null
  stderrTail: string
}

/** Startet einen Prozess, leitet stderr-Zeilen weiter und beachtet Abbruch/Zeitlimit. */
function runProcess(
  bin: string,
  args: string[],
  signal: AbortSignal,
  timeoutMs: number,
  onStderrLine?: (line: string) => void,
): Promise<ProcResult> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('Abgebrochen.'))
      return
    }
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderrTail = ''
    let buf = ''
    let killedBy: 'abort' | 'timeout' | null = null
    const kill = (why: 'abort' | 'timeout') => {
      killedBy = why
      proc.kill('SIGKILL')
    }
    const onAbort = () => kill('abort')
    signal.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => kill('timeout'), timeoutMs)

    // stdout leeren, damit der Prozess nicht an einer vollen Pipe hängt.
    proc.stdout.resume()
    proc.stderr.on('data', (chunk: Buffer) => {
      const s = chunk.toString()
      stderrTail = (stderrTail + s).slice(-4096)
      if (!onStderrLine) return
      buf += s
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        onStderrLine(buf.slice(0, nl))
        buf = buf.slice(nl + 1)
      }
    })
    proc.on('error', (err) => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      reject(new Error(`${path.basename(bin)} konnte nicht gestartet werden: ${err.message}`))
    })
    proc.on('close', (code) => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      if (killedBy === 'abort') reject(new Error('Abgebrochen.'))
      else if (killedBy === 'timeout')
        reject(new Error('Zeitlimit der Transkription überschritten.'))
      else resolve({ code, stderrTail })
    })
  })
}

function lastLines(text: string, n = 3): string {
  return text.split('\n').filter(Boolean).slice(-n).join(' ').trim()
}

/** FFmpeg-Argumente: erste Tonspur als 16 kHz Mono PCM-WAV. */
export function buildAudioExtractArgs(inputPath: string, wavPath: string): string[] {
  return [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-i',
    inputPath,
    '-map',
    '0:a:0',
    '-vn',
    '-ac',
    '1',
    '-ar',
    '16000',
    '-c:a',
    'pcm_s16le',
    wavPath,
  ]
}

/** whisper-cli-Argumente (Wort-Zeitstempel, JSON-Datei, Fortschritt auf stderr). */
export function buildWhisperArgs(
  wavPath: string,
  outBase: string,
  language: TranscribeLanguage,
): string[] {
  return [
    '-m',
    config.whisperModel,
    '-f',
    wavPath,
    '-l',
    language,
    '-t',
    String(Math.max(1, Math.round(config.whisperThreads))),
    '-ml',
    '1',
    '-sow',
    '-oj',
    '-of',
    outBase,
    '-pp',
  ]
}

/**
 * Transkribiert die Tonspur einer Videodatei.
 * @param onProgress Fortschritt 0–100.
 */
export async function transcribeFile(
  inputPath: string,
  workBase: string,
  language: TranscribeLanguage,
  signal: AbortSignal,
  onProgress: (percent: number) => void,
): Promise<Transcript> {
  const wavPath = `${workBase}.wav`
  const outBase = `${workBase}-whisper`
  try {
    onProgress(1)
    const ff = await runProcess(
      config.ffmpegPath,
      buildAudioExtractArgs(inputPath, wavPath),
      signal,
      config.ffmpegTimeoutMs,
    )
    if (ff.code !== 0) {
      throw new Error(`Tonspur konnte nicht gelesen werden. ${lastLines(ff.stderrTail)}`)
    }
    onProgress(5)

    const wh = await runProcess(
      config.whisperPath,
      buildWhisperArgs(wavPath, outBase, language),
      signal,
      config.whisperTimeoutMs,
      (line) => {
        const m = /progress\s*=\s*(\d+)%/.exec(line)
        if (m) onProgress(5 + Math.round(Number(m[1]) * 0.94))
      },
    )
    if (wh.code !== 0)
      throw new Error(`Whisper-Fehler (Code ${wh.code}). ${lastLines(wh.stderrTail)}`)
    // whisper-cli beendet sich bei manchen Fehlern (z. B. Modell fehlt) mit Code 0.
    const json = await readFile(`${outBase}.json`, 'utf8').catch(() => null)
    if (json === null) {
      throw new Error(`Whisper lieferte kein Ergebnis. ${lastLines(wh.stderrTail)}`)
    }
    const transcript = parseWhisperJson(json)
    onProgress(100)
    return transcript
  } finally {
    await rm(wavPath, { force: true }).catch(() => {})
    await rm(`${outBase}.json`, { force: true }).catch(() => {})
  }
}
