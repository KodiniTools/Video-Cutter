import { DEFAULT_TEXT_STYLE } from '@/lib/textOverlay'
import { graphicKeys } from './graphicKeys'
import {
  MICROS_PER_SECOND,
  type AudioTrack,
  type OverlayClip,
  type Time,
  type TimelineDoc,
  type VideoClip,
} from './model'

/**
 * Qualitäts-Check vor dem Export. Reine Funktionen ohne Vue: Sie messen am
 * Dokument (Lage und Dauer von Texten, Lücken, sehr kurze Clips, Sprünge im
 * selben Video) und an der Lautheits-Messung des Servers (zu leise/laut,
 * übersteuert, Stille, abrupte Lautstärkesprünge an Clip-Grenzen).
 * Jeder Hinweis nennt eine Stelle auf der Timeline (und ggf. den Clip), damit
 * der Editor dorthin springen kann. Die Texte formuliert der Dialog (i18n).
 */

export type QualitySeverity = 'warn' | 'info'

export const QUALITY_KINDS = [
  'loudnessLow',
  'loudnessHigh',
  'clipping',
  'noAudio',
  'silence',
  'quiet',
  'audioJump',
  'textOutside',
  'textUnsafe',
  'textShort',
  'gap',
  'flashClip',
  'jumpCut',
] as const
export type QualityKind = (typeof QUALITY_KINDS)[number]

export interface QualityHint {
  kind: QualityKind
  severity: QualitySeverity
  /** Stelle auf der Timeline (Sprungziel). */
  at: Time
  /** Ende des betroffenen Bereichs, falls es einer ist. */
  end?: Time
  /** Betroffener Clip (wird beim Springen markiert). */
  clipId?: string
  /** Werte für den Hinweistext (z. B. LUFS, Sekunden). */
  params: Record<string, number | string>
}

/** Lautheits-Messung des Servers (POST /api/quality/loudness). */
export interface LoudnessMeasure {
  integrated: number
  range: number
  truePeak: number
  /** Abstand der Werte in Sekunden (0,1). */
  step: number
  /** Momentan-Lautheit (LUFS) je Schritt; das Fenster endet am Schritt. */
  momentary: number[]
  /** Spitze (dBFS) je Schritt. */
  peak: number[]
}

/** Grenzen der Prüfungen (bewusst an einer Stelle). */
export const QUALITY_LIMITS = {
  /** Gesamtlautheit: darunter zu leise, darüber zu laut (Web/Social: −14 bis −16 LUFS). */
  loudnessLow: -20,
  loudnessHigh: -9,
  /** Spitze ab hier gilt als übersteuert (dBFS). */
  clipping: -0.1,
  /** Momentan-Lautheit bis hier = Stille (LUFS). */
  silence: -60,
  /** Stille bzw. leise Stelle erst ab dieser Länge (s). */
  silenceMin: 2,
  quietMin: 3,
  /** Leise = so viel unter der Gesamtlautheit (LU). */
  quietBelow: 18,
  /** Sprung der Lautheit an einer Clip-Grenze ohne Blende (LU). */
  jump: 15,
  /** …und die lautere Seite mindestens so laut (LUFS). */
  jumpFloor: -30,
  /** Sicherer Bereich: Rand je Seite als Anteil (Title Safe = 90 %). */
  safeMargin: 0.05,
  /** Lesetempo: Zeichen je Sekunde, plus Grundzeit und Mindestdauer (s). */
  readCps: 15,
  readBase: 0.5,
  readMin: 1,
  /** Video-Clip kürzer als das (s) = Blitzer. */
  flashClip: 0.3,
} as const

const sec = (t: Time) => t / MICROS_PER_SECOND
const round1 = (v: number) => Math.round(v * 10) / 10
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** Ende des letzten Clips (alle Spuren). */
export function filmDuration(doc: TimelineDoc): Time {
  let end = 0
  for (const t of doc.tracks) for (const c of t.clips) end = Math.max(end, c.start + c.duration)
  return end
}

// --- Ton --------------------------------------------------------------------

/** Zusammenhängende Bereiche (Schritt-Indizes, Ende exklusiv), Lücken ≤ `bridge` überbrückt. */
function spans(flags: boolean[], bridge = 0): Array<[number, number]> {
  const out: Array<[number, number]> = []
  let from = -1
  for (let i = 0; i <= flags.length; i++) {
    const on = i < flags.length && flags[i]
    if (on && from < 0) from = i
    if (!on && from >= 0) {
      const last = out[out.length - 1]
      if (last && from - last[1] <= bridge) last[1] = i
      else out.push([from, i])
      from = -1
    }
  }
  return out
}

/** Mittel über die Energie (nicht über die dB-Werte) in einem Fenster um i. */
function energyMean(values: number[], i: number, half: number): number {
  let sum = 0
  let n = 0
  for (let k = Math.max(0, i - half); k <= Math.min(values.length - 1, i + half); k++) {
    sum += 10 ** (values[k] / 10)
    n++
  }
  return n > 0 ? 10 * Math.log10(sum / n) : -Infinity
}

/** Zeiten, an denen ein Ton-Clip hart (ohne Blende) beginnt oder endet. */
function hardAudioEdges(doc: TimelineDoc): Array<{ at: Time; clipId: string }> {
  const tracks = doc.tracks.filter((t): t is AudioTrack => t.kind === 'audio')
  const anySolo = tracks.some((t) => t.solo)
  const edges: Array<{ at: Time; clipId: string }> = []
  for (const track of tracks) {
    if (anySolo ? !track.solo : track.muted || track.volume <= 0) continue
    for (const clip of track.clips) {
      if (clip.gain <= 0) continue
      if (!clip.fadeIn && clip.start > 0) edges.push({ at: clip.start, clipId: clip.id })
      if (!clip.fadeOut) edges.push({ at: clip.start + clip.duration, clipId: clip.id })
    }
  }
  return edges.sort((a, b) => a.at - b.at)
}

/** Hinweise aus der Lautheits-Messung. `normalized`: Der Export gleicht die Lautheit an. */
export function audioHints(
  doc: TimelineDoc,
  m: LoudnessMeasure,
  opts: { normalized?: boolean } = {},
): QualityHint[] {
  const L = QUALITY_LIMITS
  const step = m.step > 0 ? m.step : 0.1
  const at = (i: number): Time => Math.round(i * step * MICROS_PER_SECOND)
  const hints: QualityHint[] = []
  const anySound = m.momentary.some((v) => v > L.silence)
  if (!anySound) {
    return [{ kind: 'noAudio', severity: 'info', at: 0, params: {} }]
  }

  // Gesamtlautheit und Übersteuern: Beides behebt das Angleichen beim Export.
  if (!opts.normalized) {
    if (m.integrated < L.loudnessLow)
      hints.push({
        kind: 'loudnessLow',
        severity: 'warn',
        at: 0,
        params: { lufs: round1(m.integrated) },
      })
    else if (m.integrated > L.loudnessHigh)
      hints.push({
        kind: 'loudnessHigh',
        severity: 'warn',
        at: 0,
        params: { lufs: round1(m.integrated) },
      })
    for (const [a, b] of spans(
      m.peak.map((p) => p >= L.clipping),
      3,
    )) {
      let max = -Infinity
      for (let k = a; k < b; k++) max = Math.max(max, m.peak[k])
      hints.push({
        kind: 'clipping',
        severity: 'warn',
        at: at(a),
        end: at(b),
        params: { db: round1(max) },
      })
    }
  }

  // Stille im Film (mindestens 2 s).
  const silent = m.momentary.map((v) => v <= L.silence)
  // Das Fenster der Momentan-Lautheit ist 400 ms lang: Ein Schritt zählt erst
  // als still, wenn das ganze Fenster still war, die Stille begann also früher.
  const lag = Math.max(0, Math.round(0.4 / step) - 1)
  for (const [found, b] of spans(silent, 2)) {
    const a = Math.max(0, found - lag)
    if ((b - a) * step < L.silenceMin) continue
    hints.push({
      kind: 'silence',
      severity: 'info',
      at: at(a),
      end: at(b),
      params: { s: round1((b - a) * step) },
    })
  }

  // Leise Stellen: deutlich unter der Gesamtlautheit, aber keine Stille.
  const smooth = m.momentary.map((_, i) => energyMean(m.momentary, i, 5))
  const quietLevel = m.integrated - L.quietBelow
  const quiet = smooth.map((v, i) => !silent[i] && v > L.silence && v < quietLevel)
  for (const [a, b] of spans(quiet, 3)) {
    if ((b - a) * step < L.quietMin) continue
    hints.push({
      kind: 'quiet',
      severity: 'info',
      at: at(a),
      end: at(b),
      params: {
        s: round1((b - a) * step),
        lu: Math.round(m.integrated - Math.min(...smooth.slice(a, b))),
      },
    })
  }

  // Abrupte Sprünge: 400 ms vor gegen 400 ms nach einer harten Clip-Grenze.
  // Das Ende des Films zählt nicht (dort endet ohnehin alles).
  const window = Math.round(0.4 / step)
  const filmEnd = filmDuration(doc)
  const valueAt = (i: number) => (i >= 0 && i < m.momentary.length ? m.momentary[i] : -70)
  let lastAt = -Infinity
  for (const edge of hardAudioEdges(doc)) {
    if (edge.at === lastAt || edge.at >= filmEnd) continue
    const i = Math.round(sec(edge.at) / step)
    // Fenster danach muss noch im Film liegen.
    if (i <= 0 || i - 1 + window >= m.momentary.length) continue
    const before = valueAt(i - 1)
    const after = valueAt(i - 1 + window)
    if (Math.abs(before - after) < L.jump || Math.max(before, after) < L.jumpFloor) continue
    lastAt = edge.at
    hints.push({
      kind: 'audioJump',
      severity: 'info',
      at: edge.at,
      clipId: edge.clipId,
      params: { lu: Math.round(Math.abs(before - after)), dir: after > before ? 'up' : 'down' },
    })
  }
  return hints
}

// --- Texte ------------------------------------------------------------------

/** Breite einer Zeile in Pixeln bei Schriftgröße `px` (im Browser per Canvas gemessen). */
export type TextMeasure = (line: string, font: string, px: number) => number

/** Schätzung ohne Canvas: mittlere Zeichenbreite gut einer halben Schriftgröße. */
export const estimateTextWidth: TextMeasure = (line, _font, px) =>
  Array.from(line).length * px * 0.55

/** Zeilenhöhe als Vielfaches der Schriftgröße (wie libass; Standard Roboto). */
export type LineRatio = (font: string) => number

export interface TextCheckOptions {
  measure?: TextMeasure
  lineRatio?: LineRatio
}

/** Zeichen, die gelesen werden müssen (ohne Leerraum). */
function readChars(text: string): number {
  return Array.from(text.replace(/\s+/g, '')).length
}

/** Mindestdauer zum Lesen eines Textes in Sekunden. */
export function readSeconds(text: string): number {
  const L = QUALITY_LIMITS
  return Math.max(L.readMin, L.readBase + readChars(text) / L.readCps)
}

function textHints(doc: TimelineDoc, opts: TextCheckOptions): QualityHint[] {
  const L = QUALITY_LIMITS
  const measure = opts.measure ?? estimateTextWidth
  const ratio = opts.lineRatio ?? (() => 1.2)
  const { width, height } = doc.settings
  const aspect = width / height
  const hints: QualityHint[] = []
  for (const track of doc.tracks) {
    if (track.kind !== 'overlay' || track.hidden) continue
    for (const clip of track.clips as OverlayClip[]) {
      if (clip.kind !== 'text') continue
      const text = typeof clip.data.text === 'string' ? clip.data.text : ''
      if (!text.trim()) continue

      const need = readSeconds(text)
      const shown = sec(clip.duration)
      if (shown + 1e-6 < need)
        hints.push({
          kind: 'textShort',
          severity: 'warn',
          at: clip.start,
          end: clip.start + clip.duration,
          clipId: clip.id,
          params: { shown: round1(shown), need: round1(need), text: preview(text) },
        })

      // Maße als Anteil des Bildes: Schriftgröße ist ein Anteil der Bildhöhe.
      const size = finite(clip.data.size) ? clip.data.size : DEFAULT_TEXT_STYLE.size
      const font = typeof clip.data.font === 'string' ? clip.data.font : DEFAULT_TEXT_STYLE.font
      const lines = text.split('\n')
      const px = size * 1000
      const w = Math.max(...lines.map((l) => measure(l, font, px))) / (1000 * aspect)
      const h = lines.length * size * ratio(font)
      const keys = graphicKeys(clip.data)
      const places =
        keys.length > 0
          ? keys.map((k) => ({ x: k.x, y: k.y, scale: k.scale, at: k.at }))
          : [
              {
                x: finite(clip.data.x) ? clip.data.x : DEFAULT_TEXT_STYLE.x,
                y: finite(clip.data.y) ? clip.data.y : DEFAULT_TEXT_STYLE.y,
                scale: 1,
                at: 0,
              },
            ]
      let worst: { over: number; at: Time } | null = null
      for (const p of places) {
        const left = p.x - (w * p.scale) / 2
        const right = p.x + (w * p.scale) / 2
        const top = p.y - (h * p.scale) / 2
        const bottom = p.y + (h * p.scale) / 2
        // Wie weit ragt der Text über den sicheren Rand (positiv = drüber)?
        const over = Math.max(
          L.safeMargin - left,
          right - (1 - L.safeMargin),
          L.safeMargin - top,
          bottom - (1 - L.safeMargin),
        )
        if (over > 1e-3 && (!worst || over > worst.over)) worst = { over, at: p.at }
      }
      if (worst) {
        const outside = worst.over > L.safeMargin + 1e-3
        const offset = Math.min(Math.max(0, worst.at), clip.duration - 1)
        hints.push({
          kind: outside ? 'textOutside' : 'textUnsafe',
          severity: 'warn',
          at: clip.start + offset,
          clipId: clip.id,
          params: { text: preview(text) },
        })
      }
    }
  }
  return hints
}

/** Kurzer Auszug für den Hinweis. */
function preview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 32 ? `${flat.slice(0, 31)}…` : flat
}

// --- Bild -------------------------------------------------------------------

function videoHints(doc: TimelineDoc): QualityHint[] {
  const L = QUALITY_LIMITS
  const hints: QualityHint[] = []
  const tracks = doc.tracks.filter((t) => t.kind === 'video' && !t.hidden)
  const end = filmDuration(doc)
  const frame = Math.round(MICROS_PER_SECOND / doc.settings.fps)
  const covered: Array<[Time, Time]> = []
  for (const track of tracks) {
    const clips = [...(track.clips as VideoClip[])].sort((a, b) => a.start - b.start)
    clips.forEach((clip, i) => {
      const next = clips[i + 1]
      const clipEnd = clip.start + clip.duration
      covered.push([clip.start, clip.hold ? (next?.start ?? end) : clipEnd])
      if (sec(clip.duration) < L.flashClip)
        hints.push({
          kind: 'flashClip',
          severity: 'warn',
          at: clip.start,
          clipId: clip.id,
          params: { frames: Math.max(1, Math.round(clip.duration / frame)) },
        })
      // Sprung im selben Video: direkt anschließend, weiter hinten in der Quelle, ohne Übergang.
      if (
        next &&
        next.asset === clip.asset &&
        next.kind === 'video' &&
        clip.kind === 'video' &&
        !next.transitionIn &&
        Math.abs(next.start - clipEnd) < frame
      ) {
        const sourceEnd = clip.sourceIn + clip.duration * clip.speed
        const skipped = next.sourceIn - sourceEnd
        if (skipped >= frame * clip.speed)
          hints.push({
            kind: 'jumpCut',
            severity: 'info',
            at: next.start,
            clipId: next.id,
            params: { s: round1(sec(skipped)) },
          })
      }
    })
  }
  if (covered.length === 0) return hints
  // Lücken ohne Bild (zu sehen ist nur der Hintergrund).
  covered.sort((a, b) => a[0] - b[0])
  let reach = 0
  const gaps: Array<[Time, Time]> = []
  for (const [a, b] of covered) {
    if (a - reach >= frame) gaps.push([reach, a])
    reach = Math.max(reach, b)
  }
  if (end - reach >= frame) gaps.push([reach, end])
  for (const [a, b] of gaps)
    hints.push({ kind: 'gap', severity: 'warn', at: a, end: b, params: { s: round1(sec(b - a)) } })
  return hints
}

// --- Gesamt -----------------------------------------------------------------

/** Warnungen zuerst, dann nach Zeit. */
export function sortHints(hints: QualityHint[]): QualityHint[] {
  const rank = (h: QualityHint) => (h.severity === 'warn' ? 0 : 1)
  return [...hints].sort((a, b) => rank(a) - rank(b) || a.at - b.at)
}

/** Alle Prüfungen am Dokument (ohne Ton-Messung). */
export function documentHints(doc: TimelineDoc, opts: TextCheckOptions = {}): QualityHint[] {
  return sortHints([...videoHints(doc), ...textHints(doc, opts)])
}

/** Antwort des Servers prüfen (altes oder fremdes Format → `null`). */
export function parseLoudness(raw: unknown): LoudnessMeasure | null {
  if (!raw || typeof raw !== 'object') return null
  const d = raw as Record<string, unknown>
  const nums = (v: unknown): v is number[] => Array.isArray(v) && v.every(finite)
  if (!finite(d.integrated) || !finite(d.range) || !finite(d.truePeak) || !finite(d.step))
    return null
  if (!nums(d.momentary) || !nums(d.peak) || d.momentary.length !== d.peak.length) return null
  return {
    integrated: d.integrated,
    range: d.range,
    truePeak: d.truePeak,
    step: d.step,
    momentary: d.momentary,
    peak: d.peak,
  }
}
