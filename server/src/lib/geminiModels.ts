import { config } from '../config'

/**
 * Wählbare Gemini-Modelle für KI-Bilder und -Videos. Die Liste kommt live von
 * Google (GET /models mit dem eigenen Schlüssel) und zeigt damit genau, was
 * der Schlüssel nutzen darf; ohne Verbindung gilt eine feste Ersatzliste.
 */

export type ModelKind = 'image' | 'video'

export interface ModelChoices {
  /** Voreinstellung aus der Server-.env (GEMINI_IMAGE_MODEL / GEMINI_VIDEO_MODEL). */
  default: string
  models: string[]
}

/** Stand 14.11.2026 (Modellliste eines echten Schlüssels). */
export const FALLBACK_MODELS: Record<ModelKind, readonly string[]> = {
  image: [
    'gemini-nano-banana-2.1',
    'gemini-3.1-flash-image',
    'gemini-3.1-flash-lite-image',
    'gemini-3-pro-image',
    'gemini-2.5-flash-image',
  ],
  video: ['gemini-omni-1.2-flash', 'gemini-omni-1.1-flash'],
}

const MODEL_ID_RE = /^[a-z0-9][a-z0-9.-]{2,79}$/

/** Art eines Modells nach seinem Namen; `null` = weder Bild noch Video. */
export function modelKindOf(id: string): ModelKind | null {
  if (!MODEL_ID_RE.test(id)) return null
  if (/(^|-)(omni|veo)(-|$)/.test(id)) return 'video'
  if (/(^|-)(image|banana)(-|$)/.test(id)) return 'image'
  return null
}

export function defaultModel(kind: ModelKind): string {
  return kind === 'image' ? config.geminiImageModel : config.geminiVideoModel
}

/**
 * Prüft das vom Browser gewünschte Modell: leer -> Voreinstellung; sonst muss
 * der Name gültig sein und zur Art passen (kein Videomodell für Bilder).
 * `null` = abgelehnt.
 */
export function resolveModel(kind: ModelKind, wanted: unknown): string | null {
  if (wanted === undefined || wanted === null || wanted === '') return defaultModel(kind)
  if (typeof wanted !== 'string') return null
  if (wanted === defaultModel(kind)) return wanted
  return modelKindOf(wanted) === kind ? wanted : null
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Liest die Modellnamen aus der Antwort von GET /models. */
export function parseModelList(raw: unknown): Record<ModelKind, string[]> {
  const out: Record<ModelKind, string[]> = { image: [], video: [] }
  const list = isRecord(raw) && Array.isArray(raw.models) ? raw.models : []
  for (const m of list.filter(isRecord)) {
    const id = typeof m.name === 'string' ? m.name.replace(/^models\//, '') : ''
    const kind = modelKindOf(id)
    if (kind && !out[kind].includes(id)) out[kind].push(id)
  }
  return out
}

/** Voreinstellung zuerst, dann feste Versionen, Vorschau-Modelle am Ende. */
export function orderModels(kind: ModelKind, ids: readonly string[]): string[] {
  const def = defaultModel(kind)
  const rest = ids.filter((id) => id !== def)
  const stable = rest.filter((id) => !id.includes('preview'))
  const preview = rest.filter((id) => id.includes('preview'))
  return [def, ...stable, ...preview]
}

const CACHE_MS = 60 * 60 * 1000
let cache: { at: number; lists: Record<ModelKind, string[]> } | null = null

/** Nur für Tests. */
export function resetModelCache(): void {
  cache = null
}

/** Modellauswahl für die App; `live` = Liste stammt von Google. */
export async function listModels(
  now = Date.now(),
): Promise<{ image: ModelChoices; video: ModelChoices; live: boolean }> {
  let lists = cache && now - cache.at < CACHE_MS ? cache.lists : null
  if (!lists && process.env.GEMINI_API_KEY) {
    try {
      const res = await fetch(`${config.geminiBaseUrl.replace(/\/+$/, '')}/models?pageSize=1000`, {
        headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY },
        signal: AbortSignal.timeout(10_000),
      })
      if (res.ok) {
        const parsed = parseModelList(await res.json())
        if (parsed.image.length || parsed.video.length) {
          lists = parsed
          cache = { at: now, lists }
        }
      }
    } catch {
      /* Ersatzliste */
    }
  }
  const pick = (kind: ModelKind): ModelChoices => ({
    default: defaultModel(kind),
    models: orderModels(kind, lists?.[kind].length ? lists[kind] : FALLBACK_MODELS[kind]),
  })
  return { image: pick('image'), video: pick('video'), live: lists !== null }
}
