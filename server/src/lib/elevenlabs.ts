import { config } from '../config'

/**
 * KI-Sprecher mit ElevenLabs: Stimmen auflisten und einen Text vertonen.
 * Der Schlüssel kommt ausschließlich aus ELEVENLABS_API_KEY (Server-.env)
 * und verlässt den Server nie.
 *
 * - GET  {base}/v2/voices?page_size=100            -> Stimmen des Kontos
 * - POST {base}/v1/text-to-speech/{voice_id}       -> MP3 (output_format)
 */

export function elevenlabsReady(): boolean {
  return Boolean(process.env.ELEVENLABS_API_KEY)
}

/** Längster Text pro Vertonung (ElevenLabs erlaubt mehr; spart Kontingent bei Versehen). */
export const MAX_SCRIPT_LENGTH = 5000
/** Sprechtempo: ElevenLabs nimmt 0,7 … 1,2 an. */
export const MIN_VOICE_SPEED = 0.7
export const MAX_VOICE_SPEED = 1.2
/** Ausgabe: MP3 44,1 kHz / 128 kbit/s (in allen Tarifen verfügbar). */
export const OUTPUT_FORMAT = 'mp3_44100_128'

export interface Voice {
  id: string
  name: string
  /** premade | cloned | generated | professional … */
  category: string
  /** Kurzbeschreibung aus den Labels (Geschlecht, Akzent, Alter, Einsatz). */
  description: string
  /** Hörprobe (öffentliche URL von ElevenLabs) oder leer. */
  previewUrl: string
}

export interface VoiceSettings {
  speed: number
  stability: number
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

const clamp = (v: unknown, min: number, max: number, fallback: number): number => {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
}

/** Einstellungen aus der Anfrage (fehlende = Standard der Stimme). */
export function parseVoiceSettings(body: Record<string, unknown>): VoiceSettings {
  return {
    speed: Number(clamp(body.speed, MIN_VOICE_SPEED, MAX_VOICE_SPEED, 1).toFixed(2)),
    stability: Number(clamp(body.stability, 0, 1, 0.5).toFixed(2)),
  }
}

/** Gültige Stimmen-ID (ElevenLabs: Buchstaben/Ziffern, ~20 Zeichen). */
export function isVoiceId(v: unknown): v is string {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v)
}

function describe(labels: unknown, fallback: unknown): string {
  const l = isRecord(labels) ? labels : {}
  const parts = ['gender', 'age', 'accent', 'descriptive', 'description', 'use_case', 'use case']
    .map((k) => l[k])
    .filter((v): v is string => typeof v === 'string' && v.trim() !== '')
    .map((v) => v.trim().replace(/_/g, ' '))
  const text = parts.length
    ? [...new Set(parts)].join(', ')
    : typeof fallback === 'string'
      ? fallback
      : ''
  return text.slice(0, 160)
}

/** Stimmen aus einer /v2/voices-Antwort (ungültige Einträge fallen weg). */
export function parseVoiceList(raw: unknown): { voices: Voice[]; next: string | null } {
  const d = isRecord(raw) ? raw : {}
  const list = Array.isArray(d.voices) ? d.voices.filter(isRecord) : []
  const voices = list.flatMap((v) => {
    if (!isVoiceId(v.voice_id)) return []
    const name = typeof v.name === 'string' && v.name.trim() ? v.name.trim() : v.voice_id
    return [
      {
        id: v.voice_id,
        name: name.slice(0, 80),
        category: typeof v.category === 'string' ? v.category : '',
        description: describe(v.labels, v.description),
        previewUrl:
          typeof v.preview_url === 'string' && /^https:\/\//.test(v.preview_url)
            ? v.preview_url
            : '',
      },
    ]
  })
  const next =
    d.has_more === true && typeof d.next_page_token === 'string' && d.next_page_token
      ? d.next_page_token
      : null
  return { voices, next }
}

/** Verständliche Meldung zu einer Fehlerantwort von ElevenLabs. */
export function elevenlabsHttpError(status: number, body: unknown): Error {
  const d = isRecord(body) ? body : {}
  const detail = d.detail
  let msg = ''
  if (typeof detail === 'string') msg = detail
  else if (isRecord(detail) && typeof detail.message === 'string') msg = detail.message
  else if (Array.isArray(detail)) {
    msg = detail
      .filter(isRecord)
      .map((e) => (typeof e.msg === 'string' ? e.msg : ''))
      .filter(Boolean)
      .join('; ')
  }
  const code = isRecord(detail) && typeof detail.status === 'string' ? detail.status : ''
  if (status === 401) {
    if (code === 'quota_exceeded' || /quota/i.test(msg)) {
      return new Error('Das ElevenLabs-Kontingent (Zeichen) ist aufgebraucht.')
    }
    if (/permission/i.test(msg) || code === 'missing_permissions') {
      return new Error(
        'Dem ElevenLabs-API-Key fehlt eine Berechtigung (Text to Speech und Voices: Lesen erlauben).',
      )
    }
    return new Error('ElevenLabs-API-Key ungültig (ELEVENLABS_API_KEY in der Server-.env prüfen).')
  }
  if (status === 403) return new Error('Der ElevenLabs-API-Key hat keinen Zugriff darauf.')
  if (status === 404) return new Error('Diese Stimme gibt es bei ElevenLabs nicht (mehr).')
  if (status === 429) {
    return new Error('ElevenLabs ist ausgelastet oder das Kontingent ist aufgebraucht (429).')
  }
  return new Error(`ElevenLabs-Fehler (${status})${msg ? `: ${msg.slice(0, 300)}` : ''}`)
}

function baseUrl(): string {
  return config.elevenlabsBaseUrl.replace(/\/+$/, '')
}

async function call(
  url: string,
  init: RequestInit,
  signal: AbortSignal | undefined,
): Promise<globalThis.Response> {
  const timeout = AbortSignal.timeout(config.elevenlabsTimeoutMs)
  try {
    return await fetch(url, {
      ...init,
      headers: { ...(init.headers ?? {}), 'xi-api-key': process.env.ELEVENLABS_API_KEY ?? '' },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    })
  } catch (err) {
    if (signal?.aborted) throw new Error('Abgebrochen.')
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new Error('ElevenLabs hat zu lange nicht geantwortet.')
    }
    throw new Error('ElevenLabs ist nicht erreichbar (Netzwerk).')
  }
}

async function readJson(res: globalThis.Response): Promise<unknown> {
  try {
    return await res.json()
  } catch {
    return null
  }
}

const VOICE_CACHE_MS = 10 * 60 * 1000
/** Höchstens so viele Seiten à 100 Stimmen. */
const MAX_VOICE_PAGES = 5
let voiceCache: { at: number; voices: Voice[] } | null = null

/** Stimmen des Kontos (10 min gemerkt), nach Name sortiert. */
export async function listVoices(now = Date.now()): Promise<Voice[]> {
  if (voiceCache && now - voiceCache.at < VOICE_CACHE_MS) return voiceCache.voices
  const all: Voice[] = []
  let token: string | null = null
  for (let page = 0; page < MAX_VOICE_PAGES; page++) {
    const q = new URLSearchParams({ page_size: '100', include_total_count: 'false' })
    if (token) q.set('next_page_token', token)
    const res = await call(`${baseUrl()}/v2/voices?${q}`, { method: 'GET' }, undefined)
    const body = await readJson(res)
    if (!res.ok) throw elevenlabsHttpError(res.status, body)
    const r = parseVoiceList(body)
    all.push(...r.voices)
    token = r.next
    if (!token) break
  }
  const seen = new Set<string>()
  const voices = all
    .filter((v) => (seen.has(v.id) ? false : (seen.add(v.id), true)))
    .sort((a, b) => a.name.localeCompare(b.name))
  voiceCache = { at: now, voices }
  return voices
}

/** Vergisst die gemerkten Stimmen (Tests). */
export function clearVoiceCache(): void {
  voiceCache = null
}

/** Request-Body für die Vertonung. */
export function buildSpeechRequest(
  text: string,
  settings: VoiceSettings,
  model: string = config.elevenlabsModel,
): Record<string, unknown> {
  return {
    text,
    model_id: model,
    voice_settings: {
      stability: settings.stability,
      similarity_boost: 0.75,
      speed: settings.speed,
    },
  }
}

/** Vertont `text` mit der Stimme und liefert die MP3-Daten. */
export async function synthesizeSpeech(
  text: string,
  voiceId: string,
  settings: VoiceSettings,
  signal: AbortSignal,
): Promise<Buffer> {
  const url = `${baseUrl()}/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${OUTPUT_FORMAT}`
  const res = await call(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify(buildSpeechRequest(text, settings)),
    },
    signal,
  )
  if (!res.ok) throw elevenlabsHttpError(res.status, await readJson(res))
  let data: Buffer
  try {
    data = Buffer.from(await res.arrayBuffer())
  } catch {
    if (signal.aborted) throw new Error('Abgebrochen.')
    throw new Error('Die Antwort von ElevenLabs ist abgebrochen.')
  }
  if (data.length < 128) throw new Error('ElevenLabs hat keine Tondatei geliefert.')
  return data
}
