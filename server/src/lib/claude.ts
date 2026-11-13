import Anthropic from '@anthropic-ai/sdk'
import { config } from '../config'
import type { Word } from './whisper'

/**
 * Claude-Anbindung für Untertitel und Schnittvorschläge. Claude bekommt das
 * Wort-Transkript (mit Index und Zeitstempeln) und antwortet als JSON
 * (Structured Outputs). Zeiten berechnet der Server selbst aus den
 * Wort-Indizes – Claude erfindet also keine Zeitstempel.
 *
 * Der API-Key kommt ausschließlich aus ANTHROPIC_API_KEY (Server-.env).
 */

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
type Effort = (typeof EFFORTS)[number]

export function claudeReady(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY)
}

let client: Anthropic | null = null
function getClient(): Anthropic {
  // Retries/Timeouts: SDK-Standard (2 Wiederholungen bei 429/5xx/Netzwerk).
  client ??= new Anthropic()
  return client
}

function effort(): Effort {
  const e = config.claudeEffort as Effort
  return EFFORTS.includes(e) ? e : 'medium'
}

/** Zielsprache der Untertitel. */
export const SUBTITLE_TARGETS = ['original', 'de', 'en'] as const
export type SubtitleTarget = (typeof SUBTITLE_TARGETS)[number]

/** Art eines Schnittvorschlags. */
export const CUT_KINDS = ['filler', 'slip', 'repeat', 'pause'] as const
export type CutKind = (typeof CUT_KINDS)[number]

export interface SubtitleCue {
  start: number
  end: number
  text: string
}

export interface CutSuggestion {
  start: number
  end: number
  kind: CutKind
  /** Betroffener Wortlaut (leer bei Pausen). */
  text: string
  /** Begründung von Claude (leer bei Pausen). */
  reason: string
}

// --- Prompt ------------------------------------------------------------------

const SYSTEM = `You help edit spoken videos. You receive an automatic speech-recognition transcript as a numbered word list. Each line is "<index> <start>-<end> <word>" with times in seconds. The recognizer makes mistakes: misheard words, missing punctuation, wrong capitalization, and sometimes invented phrases during silence or music (for example "Untertitel im Auftrag des ZDF" or "Vielen Dank fürs Zuschauen" where nobody speaks). Refer to words only by their index. Answer only with the requested JSON.`

/** Transkript als kompakte Wortliste für den Prompt. */
export function formatWords(words: Word[]): string {
  return words.map((w, i) => `${i} ${w.start.toFixed(2)}-${w.end.toFixed(2)} ${w.text}`).join('\n')
}

const LANG_NAMES: Record<string, string> = { de: 'German', en: 'English' }

function subtitleTask(target: SubtitleTarget, language: string): string {
  const lang =
    target === 'original'
      ? `the spoken language${LANG_NAMES[language] ? ` (${LANG_NAMES[language]})` : ''}`
      : LANG_NAMES[target]
  return `Create subtitles in ${lang}.

Rules:
- Each cue covers a contiguous word range: "from" is the index of its first word, "to" the index of its last word. Cues are in order and do not overlap. Every spoken word belongs to exactly one cue; skip only hallucinated phrases.
- At most 2 lines per cue and about 42 characters per line; put a line break as "\\n" between the lines. A cue should usually last 1 to 7 seconds; split at natural pauses and sentence boundaries.
- Fix recognition errors, spelling, capitalization and punctuation. Leave out filler words (uh, um, äh, ähm) and false starts.${
    target === 'original'
      ? ''
      : `\n- Translate naturally into ${lang}; keep each cue aligned with the words it translates.`
  }`
}

const CUT_TASK = `Find passages a video editor would cut out to make the speech tighter:
- "filler": filler words and hesitations (uh, um, äh, ähm, also, halt, sozusagen, you know, like) that add nothing.
- "slip": slips of the tongue and false starts that the speaker corrects right after.
- "repeat": a sentence or phrase that is repeated as a retake; mark the earlier, worse attempt.

Each suggestion covers a contiguous word range "from".."to" (indices) that can be removed without breaking the remaining sentence. Give a short reason (max. 12 words) in the language of the transcript. Do not suggest cutting content that carries meaning. Return an empty list if nothing should be cut.`

const SUBTITLE_SCHEMA = {
  type: 'object',
  properties: {
    cues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          from: { type: 'integer' },
          to: { type: 'integer' },
          text: { type: 'string' },
        },
        required: ['from', 'to', 'text'],
        additionalProperties: false,
      },
    },
  },
  required: ['cues'],
  additionalProperties: false,
}

const CUT_SCHEMA = {
  type: 'object',
  properties: {
    suggestions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          from: { type: 'integer' },
          to: { type: 'integer' },
          kind: { type: 'string', enum: ['filler', 'slip', 'repeat'] },
          reason: { type: 'string' },
        },
        required: ['from', 'to', 'kind', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['suggestions'],
  additionalProperties: false,
}

// --- Aufruf ------------------------------------------------------------------

/** Übersetzt SDK-Fehler in verständliche Meldungen. */
function friendlyError(err: unknown): Error {
  if (err instanceof Anthropic.APIUserAbortError) return new Error('Abgebrochen.')
  if (err instanceof Anthropic.AuthenticationError) {
    return new Error('Claude-API-Key ungültig (ANTHROPIC_API_KEY in der Server-.env prüfen).')
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return new Error('Der Claude-API-Key hat keinen Zugriff auf dieses Modell.')
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new Error('Claude ist gerade ausgelastet (Rate-Limit). Bitte gleich erneut versuchen.')
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new Error('Claude ist nicht erreichbar (Netzwerk).')
  }
  if (err instanceof Anthropic.APIError) {
    return new Error(`Claude-Fehler (${err.status ?? '?'}): ${err.message}`)
  }
  return err instanceof Error ? err : new Error('Unbekannter Fehler bei Claude.')
}

/**
 * Schickt Transkript + Aufgabe an Claude und liefert die JSON-Antwort.
 * Streaming, weil lange Transkripte lange Antworten erzeugen.
 */
async function askClaude(
  words: Word[],
  task: string,
  schema: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  return askClaudeWith(
    SYSTEM,
    `<transcript>\n${formatWords(words)}\n</transcript>`,
    task,
    schema,
    signal,
  )
}

/** Wie askClaude, aber mit eigenem System-Prompt und Eingabetext. */
async function askClaudeWith(
  system: string,
  input: string,
  task: string,
  schema: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  let message: Anthropic.Beta.BetaMessage
  try {
    const stream = getClient().beta.messages.stream(
      {
        model: config.claudeModel,
        max_tokens: 64000,
        // Lehnt das Modell ab, beantwortet die API die Anfrage mit einem
        // Ersatzmodell (Auswahl durch Anthropic).
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        thinking: { type: 'adaptive' },
        output_config: { effort: effort(), format: { type: 'json_schema', schema } },
        system,
        messages: [
          {
            role: 'user',
            content: [
              // Transkript zuerst und gecacht: Untertitel + Vorschläge für
              // dasselbe Video teilen sich diesen Teil.
              {
                type: 'text',
                text: input,
                cache_control: { type: 'ephemeral' },
              },
              { type: 'text', text: task },
            ],
          },
        ],
      },
      { signal },
    )
    message = await stream.finalMessage()
  } catch (err) {
    throw friendlyError(err)
  }

  if (message.stop_reason === 'refusal') {
    throw new Error('Claude hat die Anfrage abgelehnt.')
  }
  if (message.stop_reason === 'max_tokens') {
    throw new Error('Das Video ist zu lang für einen Durchgang (Antwort abgeschnitten).')
  }
  const text = message.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new Error('Claude lieferte kein gültiges JSON.')
  }
}

// --- Auswertung (rein, testbar) ------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function intOr(v: unknown, def: number): number {
  return typeof v === 'number' && Number.isInteger(v) ? v : def
}

/** Höchstens 2 Zeilen; eine lange Zeile wird am Leerzeichen nahe der Mitte umbrochen. */
export function wrapSubtitle(text: string, maxLine = 42): string {
  const lines = text
    .split(/\n|\\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
  if (lines.length === 0) return ''
  if (lines.length > 2) return wrapSubtitle(lines.join(' '), maxLine)
  if (lines.length === 2 || lines[0].length <= maxLine) return lines.join('\n')
  const one = lines[0]
  const mid = one.length / 2
  let best = -1
  for (let i = 0; i < one.length; i++) {
    if (one[i] === ' ' && (best < 0 || Math.abs(i - mid) < Math.abs(best - mid))) best = i
  }
  return best < 0 ? one : `${one.slice(0, best)}\n${one.slice(best + 1)}`
}

/**
 * Baut aus Claudes Antwort gültige Untertitel: Zeiten aus den Wort-Indizes,
 * sortiert, ohne Überlappung, Mindestdauer, auf `maxCues` begrenzt.
 */
export function buildSubtitleCues(
  words: Word[],
  raw: unknown,
  duration: number,
  maxCues: number,
  maxTextLength = 300,
): { cues: SubtitleCue[]; truncated: boolean } {
  const list = isRecord(raw) && Array.isArray(raw.cues) ? raw.cues : []
  const total = duration > 0 ? duration : Infinity
  const ranges = list
    .filter(isRecord)
    .map((c) => {
      const from = intOr(c.from, -1)
      const to = intOr(c.to, -1)
      const text = typeof c.text === 'string' ? wrapSubtitle(c.text).slice(0, maxTextLength) : ''
      return { from, to: Math.max(from, to), text }
    })
    .filter((c) => c.text && c.from >= 0 && c.from < words.length)
    .map((c) => ({ ...c, to: Math.min(c.to, words.length - 1) }))
    .sort((a, b) => a.from - b.from)

  const cues: SubtitleCue[] = []
  for (let i = 0; i < ranges.length; i++) {
    const r = ranges[i]
    const start = Math.min(words[r.from].start, total)
    const nextStart = i + 1 < ranges.length ? words[ranges[i + 1].from].start : total
    // Kurze Wörter trotzdem lesbar lange zeigen, aber nicht in den nächsten Cue.
    let end = Math.max(words[r.to].end, start + 1)
    end = Math.min(end, nextStart, total)
    const prev = cues[cues.length - 1]
    const s = prev ? Math.max(start, prev.end) : start
    if (end - s < 0.2) continue
    cues.push({ start: round3(s), end: round3(end), text: r.text })
  }
  return { cues: cues.slice(0, maxCues), truncated: cues.length > maxCues }
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}

/** Pausen zwischen Wörtern (und am Anfang/Ende), die länger als `minPause` sind. */
export function findPauses(words: Word[], duration: number, minPause: number): CutSuggestion[] {
  // Um jede Pause bleibt etwas Luft, damit der Schnitt nicht abgehackt wirkt.
  const PAD = 0.25
  const out: CutSuggestion[] = []
  const push = (gapStart: number, gapEnd: number, padStart: boolean, padEnd: boolean) => {
    if (gapEnd - gapStart < minPause) return
    const s = gapStart + (padStart ? PAD : 0)
    const e = gapEnd - (padEnd ? PAD : 0)
    if (e - s >= 0.3)
      out.push({ start: round3(s), end: round3(e), kind: 'pause', text: '', reason: '' })
  }
  if (words.length === 0) return out
  push(0, words[0].start, false, true)
  for (let i = 1; i < words.length; i++) push(words[i - 1].end, words[i].start, true, true)
  if (duration > 0) push(words[words.length - 1].end, duration, true, false)
  return out
}

/**
 * Baut Schnittvorschläge aus Claudes Antwort (Wort-Indizes -> Zeiten) plus
 * erkannten Pausen. Sortiert, ohne Überlappungen.
 */
export function buildCutSuggestions(
  words: Word[],
  raw: unknown,
  duration: number,
  minPause: number,
): CutSuggestion[] {
  const list = isRecord(raw) && Array.isArray(raw.suggestions) ? raw.suggestions : []
  const total = duration > 0 ? duration : Infinity
  const fromClaude: CutSuggestion[] = []
  for (const s of list.filter(isRecord)) {
    const from = intOr(s.from, -1)
    const to = intOr(s.to, -1)
    if (from < 0 || to < from || to >= words.length) continue
    const kind = (CUT_KINDS as readonly string[]).includes(String(s.kind))
      ? (s.kind as CutKind)
      : 'filler'
    // Schnitt bis knapp in die Lücken zu den Nachbarwörtern ausdehnen
    // (Whisper-Wortgrenzen sind ungenau), aber nie in ein Nachbarwort hinein.
    const prevEnd = from > 0 ? words[from - 1].end : 0
    const nextStart = to + 1 < words.length ? words[to + 1].start : total
    const start = Math.max(prevEnd, words[from].start - 0.08)
    const end = Math.min(nextStart, words[to].end + 0.08, total)
    if (end - start < 0.05) continue
    fromClaude.push({
      start: round3(start),
      end: round3(end),
      kind,
      text: words
        .slice(from, to + 1)
        .map((w) => w.text)
        .join(' ')
        .slice(0, 200),
      reason: typeof s.reason === 'string' ? s.reason.trim().slice(0, 200) : '',
    })
  }

  const all = [...fromClaude, ...findPauses(words, duration, minPause)].sort(
    (a, b) => a.start - b.start,
  )
  const out: CutSuggestion[] = []
  for (const s of all) {
    const prev = out[out.length - 1]
    if (prev && s.start < prev.end) continue
    out.push(s)
  }
  return out
}

// --- Öffentliche Aufgaben ------------------------------------------------------

export async function createSubtitles(
  words: Word[],
  language: string,
  target: SubtitleTarget,
  duration: number,
  maxCues: number,
  signal: AbortSignal,
): Promise<{ cues: SubtitleCue[]; truncated: boolean }> {
  if (words.length === 0) return { cues: [], truncated: false }
  const raw = await askClaude(words, subtitleTask(target, language), SUBTITLE_SCHEMA, signal)
  return buildSubtitleCues(words, raw, duration, maxCues)
}

export async function createCutSuggestions(
  words: Word[],
  duration: number,
  minPause: number,
  signal: AbortSignal,
): Promise<CutSuggestion[]> {
  if (words.length === 0) return findPauses(words, duration, minPause)
  const raw = await askClaude(words, CUT_TASK, CUT_SCHEMA, signal)
  return buildCutSuggestions(words, raw, duration, minPause)
}

// --- Texte übersetzen ------------------------------------------------------------

/** Zielsprachen für das Übersetzen vorhandener Texte. */
export const TRANSLATE_TARGETS = ['en', 'de'] as const
export type TranslateTarget = (typeof TRANSLATE_TARGETS)[number]

const TRANSLATE_SYSTEM = `You translate short on-screen texts (titles, captions, subtitles, labels) of a tutorial video. You receive them as a numbered list in JSON. Answer only with the requested JSON.`

function translateTask(target: TranslateTarget): string {
  return `Translate every text into ${LANG_NAMES[target]}.

Rules:
- Return one entry per input text with the same "i".
- Translate naturally and concisely, as subtitles or on-screen labels; keep the tone.
- Keep line breaks: if a text has several lines, the translation has the same number of lines, separated by "\\n".
- Keep emojis, numbers, URLs, product names, keyboard shortcuts and UI labels in quotes unchanged.
- If a text is already in ${LANG_NAMES[target]}, return it unchanged.`
}

const TRANSLATE_SCHEMA = {
  type: 'object',
  properties: {
    translations: {
      type: 'array',
      items: {
        type: 'object',
        properties: { i: { type: 'integer' }, text: { type: 'string' } },
        required: ['i', 'text'],
        additionalProperties: false,
      },
    },
  },
  required: ['translations'],
  additionalProperties: false,
}

/**
 * Ordnet Claudes Übersetzungen den Eingaben zu. Fehlende oder leere Einträge
 * behalten den Originaltext (`missing` zählt sie). Zeilenumbrüche aus "\\n"
 * werden echte Umbrüche; Länge und Zeilenzahl bleiben in den Text-Grenzen.
 */
export function buildTranslations(
  texts: string[],
  raw: unknown,
  maxLength = 300,
  maxLines = 6,
): { texts: string[]; missing: number } {
  const list = isRecord(raw) && Array.isArray(raw.translations) ? raw.translations : []
  const byIndex = new Map<number, string>()
  for (const t of list.filter(isRecord)) {
    const i = intOr(t.i, -1)
    if (i < 0 || i >= texts.length || typeof t.text !== 'string') continue
    const clean = t.text
      .replace(/\\n/g, '\n')
      .replace(/\r\n?/g, '\n')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
    if (!clean.length) continue
    const lines =
      clean.length > maxLines
        ? [...clean.slice(0, maxLines - 1), clean.slice(maxLines - 1).join(' ')]
        : clean
    byIndex.set(i, lines.join('\n').slice(0, maxLength))
  }
  let missing = 0
  const out = texts.map((orig, i) => {
    const t = byIndex.get(i)
    if (t === undefined) missing++
    return t ?? orig
  })
  return { texts: out, missing }
}

export async function translateTexts(
  texts: string[],
  target: TranslateTarget,
  signal: AbortSignal,
): Promise<{ texts: string[]; missing: number }> {
  if (texts.length === 0) return { texts: [], missing: 0 }
  const input = JSON.stringify(texts.map((text, i) => ({ i, text })))
  const raw = await askClaudeWith(
    TRANSLATE_SYSTEM,
    `<texts>\n${input}\n</texts>`,
    translateTask(target),
    TRANSLATE_SCHEMA,
    signal,
  )
  return buildTranslations(texts, raw)
}
