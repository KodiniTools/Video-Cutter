import http from 'node:http'
import https from 'node:https'
import { config } from '../config'

/**
 * Videoerzeugung mit Google Gemini Omni (Interactions API) für KI-Video-Clips.
 * Veo wird über die Gemini-API nicht mehr angeboten (abgeschaltet 22.10.2026);
 * Nachfolger mit demselben API-Key ist `gemini-omni-…-flash`.
 *
 * Ablauf: POST /interactions (blockiert, bis das Video fertig ist) mit
 * `response_format: { type: "video", delivery: "uri" }`. Die Antwort enthält
 * das Video entweder inline (base64) oder als Datei-Verweis, der abgeholt
 * wird, sobald die Datei „ACTIVE“ ist.
 */

export const VIDEO_ASPECTS = ['16:9', '9:16'] as const
export type VideoAspect = (typeof VIDEO_ASPECTS)[number]

export const MIN_VIDEO_DURATION = 3
export const MAX_VIDEO_DURATION = 15
export const DEFAULT_VIDEO_DURATION = 8

/** Quer- oder Hochformat passend zur Zielgröße (quadratisch -> quer). */
export function videoAspectFor(width: number, height: number): VideoAspect {
  return height > width ? '9:16' : '16:9'
}

export function clampVideoDuration(v: unknown): number {
  const n = Math.round(Number(v))
  if (!Number.isFinite(n)) return DEFAULT_VIDEO_DURATION
  return Math.min(MAX_VIDEO_DURATION, Math.max(MIN_VIDEO_DURATION, n))
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Request-Body für ein Video. */
export function buildVideoRequest(
  prompt: string,
  aspect: VideoAspect,
  durationSec: number,
): Record<string, unknown> {
  const format: Record<string, unknown> = {
    type: 'video',
    aspect_ratio: aspect,
    delivery: 'uri',
  }
  // GEMINI_VIDEO_DURATION=off lässt die Dauer weg (ältere Modelle kennen sie nicht).
  if (config.geminiVideoDuration !== 'off') format.duration = `${durationSec}s`
  if (config.geminiVideoResolution) format.resolution = config.geminiVideoResolution
  return { model: config.geminiVideoModel, input: prompt, response_format: format }
}

/** Wo das fertige Video liegt: inline (base64) oder als Datei-Verweis. */
export type VideoResult = { kind: 'inline'; data: Buffer } | { kind: 'uri'; uri: string }

/**
 * Wertet die Antwort der Interactions API aus. Das Video steht in
 * `steps[].content[]` (type "video") oder in `output_video`.
 */
export function extractVideo(raw: unknown): VideoResult {
  const d = isRecord(raw) ? raw : {}
  const status = typeof d.status === 'string' ? d.status : ''
  if (status === 'failed' || status === 'cancelled') {
    const err = isRecord(d.error) && typeof d.error.message === 'string' ? d.error.message : ''
    throw new Error(`Gemini konnte das Video nicht erzeugen${err ? `: ${err.slice(0, 300)}` : '.'}`)
  }
  const parts: Record<string, unknown>[] = []
  if (isRecord(d.output_video)) parts.push(d.output_video)
  const steps = Array.isArray(d.steps) ? d.steps.filter(isRecord) : []
  for (const s of steps) {
    if (s.type !== 'model_output' || !Array.isArray(s.content)) continue
    for (const c of s.content.filter(isRecord)) if (c.type === 'video') parts.push(c)
  }
  for (const p of parts) {
    if (typeof p.uri === 'string' && p.uri) return { kind: 'uri', uri: p.uri }
    if (typeof p.data === 'string' && p.data) {
      const data = Buffer.from(p.data, 'base64')
      if (data.length > 0) return { kind: 'inline', data }
    }
  }
  if (status && status !== 'completed') {
    throw new Error(`Gemini hat das Video nicht fertiggestellt (Status „${status}“).`)
  }
  throw new Error(
    'Gemini hat kein Video geliefert (evtl. Sicherheitsfilter). Bitte den Prompt umformulieren.',
  )
}

/** Datei-ID aus „files/<id>“ oder einer vollen …/files/<id>[:download]-URL. */
export function fileIdOf(uri: string): string | null {
  const m = /(?:^|\/)files\/([A-Za-z0-9_-]+)/.exec(uri)
  return m ? m[1] : null
}

/** Übersetzt HTTP-Fehler in verständliche Meldungen. */
export function videoHttpError(status: number, body: unknown): Error {
  const err = isRecord(body) && isRecord(body.error) ? body.error : {}
  const msg = typeof err.message === 'string' ? err.message : ''
  if (status === 400 && /api key/i.test(msg)) {
    return new Error('Gemini-API-Key ungültig (GEMINI_API_KEY in der Server-.env prüfen).')
  }
  if (status === 401 || status === 403) {
    return new Error(
      `Der Gemini-API-Key hat keinen Zugriff auf das Videomodell${msg ? ` (${msg.slice(0, 200)})` : ''}.`,
    )
  }
  if (status === 404) {
    return new Error(
      `Gemini-Videomodell „${config.geminiVideoModel}“ nicht gefunden (GEMINI_VIDEO_MODEL prüfen).`,
    )
  }
  if (status === 429) {
    return new Error('Gemini ist ausgelastet oder das Kontingent ist aufgebraucht (429).')
  }
  return new Error(`Gemini-Fehler (${status})${msg ? `: ${msg.slice(0, 300)}` : ''}`)
}

interface JsonResponse {
  status: number
  body: unknown
}

/**
 * JSON-Anfrage über node:http(s). Bewusst nicht `fetch`: Dessen fester
 * Header-Timeout (5 min) würde lange Videoerzeugungen abbrechen.
 */
export function requestJson(
  url: string,
  opts: { method: 'GET' | 'POST'; body?: unknown; signal: AbortSignal; timeoutMs: number },
): Promise<JsonResponse> {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const payload = opts.body === undefined ? null : Buffer.from(JSON.stringify(opts.body))
    const lib = u.protocol === 'http:' ? http : https
    const req = lib.request(
      u,
      {
        method: opts.method,
        signal: opts.signal,
        headers: {
          'x-goog-api-key': process.env.GEMINI_API_KEY ?? '',
          ...(payload
            ? { 'Content-Type': 'application/json', 'Content-Length': String(payload.length) }
            : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('error', reject)
        res.on('end', () => {
          clearTimeout(timer)
          let body: unknown = null
          try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          } catch {
            /* keine JSON-Antwort */
          }
          resolve({ status: res.statusCode ?? 0, body })
        })
      },
    )
    const timer = setTimeout(() => {
      req.destroy(new Error('TIMEOUT'))
    }, opts.timeoutMs)
    req.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    req.end(payload ?? undefined)
  })
}

function networkError(err: unknown, signal: AbortSignal): Error {
  if (signal.aborted) return new Error('Abgebrochen.')
  if (err instanceof Error && err.message === 'TIMEOUT') {
    return new Error('Gemini hat zu lange nicht geantwortet (Zeitlimit für Videos).')
  }
  return new Error('Gemini ist nicht erreichbar (Netzwerk).')
}

const base = () => config.geminiBaseUrl.replace(/\/+$/, '')

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        reject(new Error('Abgebrochen.'))
      },
      { once: true },
    )
  })
}

/** Wartet, bis die Datei bereit ist, und lädt sie herunter. */
async function downloadFile(uri: string, signal: AbortSignal, pollMs: number): Promise<Buffer> {
  const id = fileIdOf(uri)
  const deadline = Date.now() + config.geminiVideoTimeoutMs
  if (id) {
    for (;;) {
      let r: JsonResponse
      try {
        r = await requestJson(`${base()}/files/${id}`, { method: 'GET', signal, timeoutMs: 60_000 })
      } catch (err) {
        throw networkError(err, signal)
      }
      if (r.status >= 400) throw videoHttpError(r.status, r.body)
      const state = isRecord(r.body) && typeof r.body.state === 'string' ? r.body.state : 'ACTIVE'
      if (state === 'ACTIVE') break
      if (state === 'FAILED') throw new Error('Gemini konnte die Videodatei nicht bereitstellen.')
      if (Date.now() > deadline) throw new Error('Gemini hat zu lange nicht geantwortet.')
      await sleep(pollMs, signal)
    }
  }
  const url = id
    ? `${base()}/files/${id}:download?alt=media`
    : /^https:\/\/generativelanguage\.googleapis\.com\//.test(uri)
      ? uri
      : null
  if (!url) throw new Error('Gemini lieferte einen unbekannten Video-Verweis.')
  let res: globalThis.Response
  try {
    res = await fetch(url, {
      headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY ?? '' },
      redirect: 'follow',
      signal: AbortSignal.any([signal, AbortSignal.timeout(config.geminiVideoTimeoutMs)]),
    })
  } catch (err) {
    throw networkError(err, signal)
  }
  if (!res.ok) throw videoHttpError(res.status, await res.json().catch(() => null))
  const data = Buffer.from(await res.arrayBuffer())
  if (data.length === 0) throw new Error('Gemini lieferte eine leere Videodatei.')
  return data
}

/** Erzeugt ein Video (MP4) aus dem Prompt. */
export async function generateVideo(
  prompt: string,
  aspect: VideoAspect,
  durationSec: number,
  signal: AbortSignal,
  progress: (p: number) => void,
  pollMs = 5000,
): Promise<Buffer> {
  // Gemini meldet keinen Fortschritt; die Anzeige läuft gegen ~90 % (≈ 2 min).
  const started = Date.now()
  const tick = setInterval(() => {
    progress(90 * (1 - Math.exp(-(Date.now() - started) / 60_000)))
  }, 2000)
  try {
    let r: JsonResponse
    try {
      r = await requestJson(`${base()}/interactions`, {
        method: 'POST',
        body: buildVideoRequest(prompt, aspect, durationSec),
        signal,
        timeoutMs: config.geminiVideoTimeoutMs,
      })
    } catch (err) {
      throw networkError(err, signal)
    }
    if (r.status >= 400) throw videoHttpError(r.status, r.body)
    const result = extractVideo(r.body)
    progress(95)
    return result.kind === 'inline' ? result.data : await downloadFile(result.uri, signal, pollMs)
  } finally {
    clearInterval(tick)
  }
}
