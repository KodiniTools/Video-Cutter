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

const LANG_NAMES: Record<string, string> = {
  de: 'German',
  en: 'English',
  hr: 'Croatian',
  bs: 'Bosnian',
  sr: 'Serbian',
  sl: 'Slovenian',
  it: 'Italian',
  fr: 'French',
  es: 'Spanish',
  pt: 'Portuguese',
  nl: 'Dutch',
  pl: 'Polish',
  cs: 'Czech',
  sk: 'Slovak',
  hu: 'Hungarian',
  ro: 'Romanian',
  tr: 'Turkish',
  ru: 'Russian',
  uk: 'Ukrainian',
}

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

/**
 * Wie askClaude, aber mit eigenem System-Prompt und Eingabe. Ein Text wird
 * gecacht; eine Blockliste (z. B. mit Standbildern) geht unverändert mit.
 */
async function askClaudeWith(
  system: string,
  input: string | Anthropic.Beta.BetaContentBlockParam[],
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
              ...(typeof input === 'string'
                ? [
                    {
                      type: 'text' as const,
                      text: input,
                      cache_control: { type: 'ephemeral' as const },
                    },
                  ]
                : input),
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

// --- Prompt für KI-Bilder (Bild-Clip) ------------------------------------------------

/** Stilvorlagen für KI-Bilder (einheitlicher Look aller Bild-Clips). */
export const IMAGE_STYLES = [
  'auto',
  'photo',
  'illustration',
  'minimal',
  'gradient',
  'cinematic',
  '3d',
] as const
export type ImageStyle = (typeof IMAGE_STYLES)[number]

const STYLE_HINTS: Record<ImageStyle, string> = {
  auto: 'Choose the style that best fits the context; if there are video frames, match their look.',
  photo: 'Photorealistic photograph, natural light, shallow depth of field, high detail.',
  illustration: 'Clean modern flat illustration, harmonious limited color palette, soft shapes.',
  minimal: 'Minimalist composition, lots of calm negative space, one simple subject, muted colors.',
  gradient:
    'Abstract smooth color gradient background with soft light and subtle shapes, no objects.',
  cinematic: 'Cinematic film still, dramatic lighting, rich color grading, wide composition.',
  '3d': 'Soft 3D render, clay-like materials, studio lighting, gentle shadows.',
}

/** Eine Nachbarszene: Standbild (JPEG) und/oder Transkript-Ausschnitt. */
export interface ImageContextScene {
  role: 'before' | 'after'
  name: string
  jpeg: Buffer | null
  transcript: string
}

export interface ImagePromptRequest {
  idea: string
  style: ImageStyle
  aspect: string
  /** Sprache des Prompts (der Nutzer sieht und bearbeitet ihn). */
  language: 'de' | 'en'
  scenes: ImageContextScene[]
}

const IMAGE_PROMPT_SYSTEM = `You write prompts for an AI image generator (Google Gemini). The image becomes the full-screen background of a still clip in a video, inserted between two video clips. Titles and labels are added later as separate overlays, so the image itself must never contain text, letters, numbers, captions, logos, watermarks or user-interface elements. Answer only with the requested JSON.`

function imagePromptTask(r: ImagePromptRequest): string {
  const lang = r.language === 'de' ? 'German' : 'English'
  return `Write one image prompt for the background of the still clip.

Inputs:
- The user's idea or keywords: ${r.idea ? `"${r.idea}"` : '(none: derive the subject from the context)'}
- Style: ${STYLE_HINTS[r.style]}
- Aspect ratio: ${r.aspect}

Rules:
- If video frames or transcript excerpts are given, the image should bridge or introduce what happens around it (for example a calm visual for the next chapter), and match the colors and mood of the frames. Do not copy people from the frames.
- Describe subject, setting, composition, lighting, colors and mood in 2 to 5 sentences.
- Leave calm space (for example in the center or lower third) so text overlays stay readable.
- End with: no text, no letters, no logos, no watermark.
- Write the prompt in ${lang}.`
}

const IMAGE_PROMPT_SCHEMA = {
  type: 'object',
  properties: { prompt: { type: 'string' } },
  required: ['prompt'],
  additionalProperties: false,
}

/** Eingabe-Blöcke: je Szene Überschrift, Standbild, Transkript. */
export function buildImagePromptInput(
  scenes: ImageContextScene[],
): Anthropic.Beta.BetaContentBlockParam[] {
  const blocks: Anthropic.Beta.BetaContentBlockParam[] = []
  for (const s of scenes) {
    const where =
      s.role === 'before'
        ? 'End of the clip BEFORE the still clip'
        : 'Start of the clip AFTER the still clip'
    blocks.push({ type: 'text', text: `${where} ("${s.name}"):` })
    if (s.jpeg) {
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: s.jpeg.toString('base64') },
      })
    }
    if (s.transcript)
      blocks.push({ type: 'text', text: `<transcript>${s.transcript}</transcript>` })
  }
  if (blocks.length === 0) blocks.push({ type: 'text', text: 'No video context is available.' })
  return blocks
}

/** Prüft Claudes Antwort: ein nicht leerer Prompt, gekürzt. */
export function parseImagePrompt(raw: unknown, maxLength = 2000): string {
  const p = isRecord(raw) && typeof raw.prompt === 'string' ? raw.prompt.trim() : ''
  if (!p) throw new Error('Claude hat keinen Prompt geliefert.')
  return p.slice(0, maxLength)
}

export async function createImagePrompt(
  r: ImagePromptRequest,
  signal: AbortSignal,
): Promise<{ prompt: string }> {
  const raw = await askClaudeWith(
    IMAGE_PROMPT_SYSTEM,
    buildImagePromptInput(r.scenes),
    imagePromptTask(r),
    IMAGE_PROMPT_SCHEMA,
    signal,
  )
  return { prompt: parseImagePrompt(raw) }
}

// --- Prompt für KI-Videos (KI-Video-Clip) --------------------------------------------

const VIDEO_PROMPT_SYSTEM = `You write prompts for an AI video generator (Google Gemini Omni). The generated short clip is inserted between two video clips of a longer video. Titles and labels are added later as separate overlays, so the clip itself must never contain text, letters, numbers, captions, logos, watermarks or user-interface elements. Answer only with the requested JSON.`

const VIDEO_STYLE_HINTS: Record<ImageStyle, string> = {
  auto: 'Choose the look that best fits the context; if there are video frames, match their look.',
  photo: 'Photorealistic live-action footage, natural light, shallow depth of field.',
  illustration: 'Clean modern flat 2D animation, harmonious limited color palette, soft shapes.',
  minimal:
    'Minimalist motion design, lots of calm negative space, one simple subject, muted colors.',
  gradient: 'Abstract slowly flowing color gradients with soft light, no objects.',
  cinematic: 'Cinematic footage, dramatic lighting, rich color grading, wide composition.',
  '3d': 'Soft 3D animation, clay-like materials, studio lighting, gentle shadows.',
}

export interface VideoPromptRequest extends ImagePromptRequest {
  /** Länge des Clips in Sekunden. */
  duration: number
}

function videoPromptTask(r: VideoPromptRequest): string {
  const lang = r.language === 'de' ? 'German' : 'English'
  return `Write one video prompt for a single continuous shot of about ${r.duration} seconds.

Inputs:
- The user's idea or keywords: ${r.idea ? `"${r.idea}"` : '(none: derive the subject from the context)'}
- Style: ${VIDEO_STYLE_HINTS[r.style]}
- Aspect ratio: ${r.aspect}

Rules:
- If video frames or transcript excerpts are given, the clip should bridge or introduce what happens around it and match the colors and mood of the frames. Do not copy people from the frames.
- Describe subject, setting, what moves and how, the camera movement (for example slow push-in, pan, static), lighting, colors and mood in 3 to 6 sentences. Keep the action simple enough for ${r.duration} seconds: one shot, no cuts.
- Describe the sound: fitting ambient sound or soft music only, no speech, no voice-over.
- Leave calm space so text overlays stay readable.
- End with: no text, no letters, no logos, no watermark.
- Write the prompt in ${lang}.`
}

export async function createVideoPrompt(
  r: VideoPromptRequest,
  signal: AbortSignal,
): Promise<{ prompt: string }> {
  const raw = await askClaudeWith(
    VIDEO_PROMPT_SYSTEM,
    buildImagePromptInput(r.scenes),
    videoPromptTask(r),
    IMAGE_PROMPT_SCHEMA,
    signal,
  )
  return { prompt: parseImagePrompt(raw) }
}

// --- Highlights für einen kurzen Clip (Short) ----------------------------------------

/** Ziel-Länge des Shorts in Sekunden (Grenzen). */
export const MIN_HIGHLIGHT_TARGET = 15
export const MAX_HIGHLIGHT_TARGET = 90
export const DEFAULT_HIGHLIGHT_TARGET = 45
/** So viele Stellen werden höchstens vorgeschlagen. */
export const MAX_HIGHLIGHTS = 12

export interface Highlight {
  /** Sekunden der Quelldatei. */
  start: number
  end: number
  /** Kurzer Titel (Sprache des Transkripts). */
  title: string
  /** Warum die Stelle stark ist. */
  reason: string
  /** Bewertung 1–10 (10 = beste Stelle). */
  score: number
}

function highlightTask(target: number): string {
  return `Pick the best moments of this video for a vertical short (TikTok, Instagram Reels, YouTube Shorts) of about ${target} seconds in total.

Rules:
- Each highlight covers a contiguous word range "from".."to" (indices) that starts and ends at a sentence or clause boundary, so it is understandable on its own when cut out.
- Prefer strong statements, key insights, surprising or emotional moments, punchlines and clear tips. Avoid greetings, filler, and passages that only make sense with earlier context.
- Usually 2 to 6 highlights, each about 3 to 20 seconds long. Together they should add up to about ${target} seconds (at most ${Math.round(target * 1.2)} seconds). The highlights are joined in chronological order, so together they should still make sense.
- Highlights do not overlap.
- "title": a short catchy title (max. 6 words), "reason": why this moment is strong (max. 15 words), both in the language of the transcript. "score": 1 to 10, 10 for the strongest moment.
- Return an empty list if there is no usable speech.`
}

const HIGHLIGHT_SCHEMA = {
  type: 'object',
  properties: {
    highlights: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          from: { type: 'integer' },
          to: { type: 'integer' },
          title: { type: 'string' },
          reason: { type: 'string' },
          score: { type: 'integer' },
        },
        required: ['from', 'to', 'title', 'reason', 'score'],
        additionalProperties: false,
      },
    },
  },
  required: ['highlights'],
  additionalProperties: false,
}

/**
 * Baut Highlights aus Claudes Antwort: Zeiten aus den Wort-Indizes, etwas Luft
 * vor dem ersten und nach dem letzten Wort (höchstens bis zur Mitte der Lücke),
 * innerhalb von [rangeStart, rangeEnd], chronologisch, ohne Überlappung.
 */
export function buildHighlights(
  words: Word[],
  raw: unknown,
  rangeStart: number,
  rangeEnd: number,
  maxCount = MAX_HIGHLIGHTS,
): Highlight[] {
  const list = isRecord(raw) && Array.isArray(raw.highlights) ? raw.highlights : []
  const LEAD = 0.2
  const TAIL = 0.35
  const items: Highlight[] = []
  for (const h of list.filter(isRecord)) {
    const from = intOr(h.from, -1)
    const to = intOr(h.to, -1)
    if (from < 0 || to < from || to >= words.length) continue
    // Luft höchstens bis zur Mitte der Lücke zum Nachbarwort: So überlappen
    // sich direkt aufeinanderfolgende Stellen nicht.
    const prevEnd = from > 0 ? (words[from - 1].end + words[from].start) / 2 : rangeStart
    const nextStart = to + 1 < words.length ? (words[to].end + words[to + 1].start) / 2 : rangeEnd
    const start = Math.max(rangeStart, prevEnd, words[from].start - LEAD)
    const end = Math.min(rangeEnd, nextStart, words[to].end + TAIL)
    if (end - start < 0.5) continue
    const text = (v: unknown, max: number) =>
      typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : ''
    items.push({
      start: round3(start),
      end: round3(end),
      title: text(h.title, 80),
      reason: text(h.reason, 200),
      score: Math.min(10, Math.max(1, intOr(h.score, 5))),
    })
  }
  items.sort((a, b) => a.start - b.start)
  const out: Highlight[] = []
  for (const h of items) {
    const prev = out[out.length - 1]
    if (prev && h.start < prev.end) {
      // Überlappung: die besser bewertete Stelle behalten.
      if (h.score > prev.score) out[out.length - 1] = h
      continue
    }
    out.push(h)
  }
  if (out.length <= maxCount) return out
  // Zu viele: die besten behalten, wieder chronologisch.
  return out
    .slice()
    .sort((a, b) => b.score - a.score || a.start - b.start)
    .slice(0, maxCount)
    .sort((a, b) => a.start - b.start)
}

/**
 * Highlights im Bereich [rangeStart, rangeEnd] (Sekunden der Quelle, z. B. der
 * verwendete Teil eines Clips). Claude sieht nur die Wörter darin.
 */
export async function createHighlights(
  allWords: Word[],
  target: number,
  rangeStart: number,
  rangeEnd: number,
  signal: AbortSignal,
): Promise<Highlight[]> {
  const words = allWords.filter((w) => w.start >= rangeStart - 0.05 && w.end <= rangeEnd + 0.05)
  if (words.length < 3) return []
  const raw = await askClaudeWith(
    SYSTEM,
    `<transcript>\n${formatWords(words)}\n</transcript>`,
    highlightTask(target),
    HIGHLIGHT_SCHEMA,
    signal,
  )
  return buildHighlights(words, raw, rangeStart, rangeEnd)
}

// --- Titel, Beschreibung, Hashtags und Kapitel ----------------------------------------

/** Ausgabesprache für Titel/Beschreibung (wie die Untertitel). */
export const PUBLISH_TARGETS = SUBTITLE_TARGETS
export type PublishTarget = SubtitleTarget

/** Grenzen wie bei YouTube: Titel 100 Zeichen, Beschreibung 5000 Zeichen. */
export const MAX_TITLE_LENGTH = 100
export const MAX_DESCRIPTION_LENGTH = 5000
export const MAX_HASHTAGS = 15
export const MAX_CHAPTERS = 50
/** YouTube verlangt Kapitel von mindestens 10 Sekunden. */
export const MIN_CHAPTER_GAP = 10

export interface PublishChapter {
  /** Sekunden auf der Timeline (das erste Kapitel beginnt bei 0). */
  at: number
  title: string
}

export interface PublishTexts {
  /** Titelvorschläge, der beste zuerst. */
  titles: string[]
  description: string
  /** Mit führendem „#“, ohne Leerzeichen. */
  hashtags: string[]
  chapters: PublishChapter[]
}

function publishTask(target: PublishTarget, language: string, duration: number): string {
  const lang =
    target === 'original'
      ? `the spoken language${LANG_NAMES[language] ? ` (${LANG_NAMES[language]})` : ''}`
      : LANG_NAMES[target]
  return `The transcript is the complete video in playback order (times are seconds of the finished video, about ${Math.round(duration)} seconds long). Write the texts for publishing it on YouTube or social media, in ${lang}.

Rules:
- "titles": 3 alternative video titles, the best first. Catchy but honest, no clickbait, max. ${MAX_TITLE_LENGTH} characters, no hashtags.
- "description": a video description of 2 to 4 short paragraphs (separate paragraphs with "\\n\\n"): what the video is about and what viewers learn or see, written for viewers. No chapter list, no hashtags, no links, no invented facts.
- "hashtags": 5 to 10 relevant hashtags without "#", single words or CamelCase, no spaces.
- "chapters": chapters for the description. Each chapter starts at the word with index "from" where a new topic or section begins; "title" is a short chapter title (max. 6 words). The first chapter starts at the first word. Chapters are in order and at least ${MIN_CHAPTER_GAP} seconds apart. Use 3 to 12 chapters for videos with distinct sections; return an empty list if the video is too short (under about 1 minute) or has no distinct sections.
- Ignore hallucinated phrases of the recognizer. If there is no usable speech, return empty texts and lists.`
}

const PUBLISH_SCHEMA = {
  type: 'object',
  properties: {
    titles: { type: 'array', items: { type: 'string' } },
    description: { type: 'string' },
    hashtags: { type: 'array', items: { type: 'string' } },
    chapters: {
      type: 'array',
      items: {
        type: 'object',
        properties: { from: { type: 'integer' }, title: { type: 'string' } },
        required: ['from', 'title'],
        additionalProperties: false,
      },
    },
  },
  required: ['titles', 'description', 'hashtags', 'chapters'],
  additionalProperties: false,
}

/** Hashtag säubern: ohne „#“ und Leer-/Satzzeichen; leer = unbrauchbar. */
export function cleanHashtag(v: unknown): string {
  if (typeof v !== 'string') return ''
  const tag = v
    .replace(/^#+/, '')
    .replace(/[\s#.,;:!?"'()[\]{}<>/\\]+/gu, '')
    .slice(0, 60)
  return tag ? `#${tag}` : ''
}

/**
 * Baut die Texte aus Claudes Antwort. Kapitelzeiten kommen aus den
 * Wort-Indizes (Timeline-Zeit des Wortanfangs). Das erste Kapitel beginnt bei
 * 0, Kapitel unter `MIN_CHAPTER_GAP` Sekunden werden mit dem vorigen
 * zusammengelegt (das vorige bleibt), ebenso eines, das zu nah am Ende liegt.
 */
export function buildPublishTexts(words: Word[], raw: unknown, duration: number): PublishTexts {
  const r = isRecord(raw) ? raw : {}
  const line = (v: unknown, max: number) =>
    typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : ''

  const seen = new Set<string>()
  const titles = (Array.isArray(r.titles) ? r.titles : [])
    .map((v) => line(v, MAX_TITLE_LENGTH))
    .filter((v) => v !== '' && !seen.has(v) && seen.add(v))
    .slice(0, 5)

  const description =
    typeof r.description === 'string'
      ? r.description
          .replace(/\r\n?/g, '\n')
          .split('\n')
          .map((l) => l.replace(/[ \t]+/g, ' ').trim())
          .join('\n')
          .replace(/\n{3,}/g, '\n\n')
          .trim()
          .slice(0, MAX_DESCRIPTION_LENGTH)
      : ''

  const tags = new Map<string, string>()
  for (const v of Array.isArray(r.hashtags) ? r.hashtags : []) {
    const tag = cleanHashtag(v)
    if (tag && !tags.has(tag.toLowerCase())) tags.set(tag.toLowerCase(), tag)
  }
  const hashtags = [...tags.values()].slice(0, MAX_HASHTAGS)

  const total = duration > 0 ? duration : Infinity
  const candidates = (Array.isArray(r.chapters) ? r.chapters : [])
    .filter(isRecord)
    .flatMap((c) => {
      const i = intOr(c.from, -1)
      if (i < 0 || i >= words.length) return []
      return [{ at: words[i].start, title: line(c.title, 80) }]
    })
    .filter((c) => c.at < total)
    .sort((a, b) => a.at - b.at)
  const chapters: PublishChapter[] = []
  for (const c of candidates) {
    const prev = chapters[chapters.length - 1]
    if (!prev) {
      chapters.push({ at: 0, title: c.title })
      continue
    }
    if (c.at - prev.at < MIN_CHAPTER_GAP || total - c.at < MIN_CHAPTER_GAP) continue
    chapters.push({ at: round3(c.at), title: c.title })
    if (chapters.length >= MAX_CHAPTERS) break
  }
  return { titles, description, hashtags, chapters }
}

/**
 * Titel, Beschreibung, Hashtags und Kapitel für das ganze Video. `words`
 * liegen schon in Timeline-Zeit (siehe timelineWords in routes/ai.ts).
 */
export async function createPublishTexts(
  words: Word[],
  language: string,
  target: PublishTarget,
  duration: number,
  signal: AbortSignal,
): Promise<PublishTexts> {
  if (words.length < 3) return { titles: [], description: '', hashtags: [], chapters: [] }
  const raw = await askClaude(
    words,
    publishTask(target, language, duration),
    PUBLISH_SCHEMA,
    signal,
  )
  return buildPublishTexts(words, raw, duration)
}
