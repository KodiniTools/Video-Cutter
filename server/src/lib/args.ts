export type TrimMode = 'copy' | 'reencode'
/** 'keep' = ausgewählten Bereich behalten, 'remove' = Bereich entfernen (Rest zusammenfügen). */
export type CutOperation = 'keep' | 'remove'

/** Toleranz in Sekunden für Rand-/Degenerationsfälle. */
const EPS = 0.05

/** Formatiert Sekunden als FFmpeg-Zeit `HH:MM:SS.mmm`. */
export function formatFfmpegTime(seconds: number): string {
  const s = Math.max(0, seconds)
  const hrs = Math.floor(s / 3600)
  const mins = Math.floor((s % 3600) / 60)
  const secs = Math.floor(s % 60)
  const ms = Math.round((s - Math.floor(s)) * 1000)
  if (ms === 1000) return formatFfmpegTime(Math.floor(s) + 1)
  const pad = (n: number, len = 2) => String(n).padStart(len, '0')
  return `${pad(hrs)}:${pad(mins)}:${pad(secs)}.${pad(ms, 3)}`
}

/** Ein Bereich als Start + Länge (Sekunden). */
export interface Segment {
  start: number
  duration: number
}

/** Übergangs-Presets (UI) -> FFmpeg-xfade-Übergangsnamen. */
export type TransitionPreset = 'none' | 'fade' | 'slide' | 'scale' | 'flip'
const XFADE_TYPES: Record<Exclude<TransitionPreset, 'none'>, string> = {
  fade: 'fade',
  slide: 'slideleft',
  scale: 'zoomin',
  flip: 'squeezev',
}

/** Übergang zwischen zusammengefügten Ausschnitten. */
export interface Transition {
  preset: TransitionPreset
  /** Übergangsdauer in Sekunden (gleichmäßig auf beide Clips). */
  duration: number
}

export interface ServerArgsInput {
  inputPath: string
  outputPath: string
  start?: number
  duration?: number
  mode: TrimMode
  /** Standard: 'keep'. */
  operation?: CutOperation
  /** Gesamtdauer des Videos in Sekunden – für 'remove' und Clamping nötig. */
  total?: number
  /** Mehrere Ausschnitte. Ohne Angabe wird {start,duration} als einziger genutzt. */
  segments?: Segment[]
  /** Optionaler Übergang beim Zusammenfügen mehrerer Ausschnitte. */
  transition?: Transition
}

/**
 * Effektive, sichere Übergangsdauer für die gegebenen Bereiche.
 * - 0, wenn kein/none-Übergang oder weniger als zwei Bereiche.
 * - Sonst auf die Bereichslängen begrenzt, damit xfade nie mehr Material
 *   verlangt, als vorhanden ist (innere Bereiche werden zweimal genutzt ->
 *   halbe Länge als Obergrenze).
 */
export function effectiveTransition(
  ranges: Segment[],
  transition?: Transition,
): { type: string; d: number } | null {
  if (!transition || transition.preset === 'none' || ranges.length < 2) return null
  const type = XFADE_TYPES[transition.preset]
  const minLen = Math.min(...ranges.map((r) => r.duration))
  const cap = ranges.length > 2 ? minLen / 2 : minLen
  const d = Math.min(transition.duration, Math.max(0, cap - 0.05))
  if (!(d >= 0.1)) return null
  return { type, d }
}

/**
 * Ermittelt aus den ausgewählten Segmenten die tatsächlich zu BEHALTENDEN
 * Bereiche (nach Zusammenführen von Überlappungen), abhängig von der Operation:
 * - 'keep':   die (zusammengeführten) Auswahl-Bereiche.
 * - 'remove': das Komplement der Auswahl innerhalb [0, total].
 */
export function computeKeepRanges(
  segments: Segment[],
  operation: CutOperation,
  total: number,
): Segment[] {
  const tot = Number.isFinite(total) ? total : Number.POSITIVE_INFINITY
  const ivs = segments
    .map((r) => {
      const s = Math.max(0, r.start)
      return { s, e: Math.min(s + Math.max(0, r.duration), tot) }
    })
    .filter((iv) => iv.e - iv.s > EPS)
    .sort((a, b) => a.s - b.s)

  // Überlappende/angrenzende Bereiche zusammenführen.
  const merged: { s: number; e: number }[] = []
  for (const iv of ivs) {
    const last = merged[merged.length - 1]
    if (last && iv.s <= last.e + EPS) last.e = Math.max(last.e, iv.e)
    else merged.push({ ...iv })
  }

  let keep: { s: number; e: number }[]
  if (operation === 'keep') {
    keep = merged
  } else {
    keep = []
    let cursor = 0
    for (const iv of merged) {
      if (iv.s - cursor > EPS) keep.push({ s: cursor, e: iv.s })
      cursor = Math.max(cursor, iv.e)
    }
    if (Number.isFinite(tot) && tot - cursor > EPS) keep.push({ s: cursor, e: tot })
  }

  return keep
    .filter((iv) => iv.e - iv.s > EPS)
    .map((iv) => ({ start: iv.s, duration: iv.e - iv.s }))
}

// Gemeinsame Präfixe/Encoder-Optionen.
const PROGRESS = ['-hide_banner', '-nostdin', '-y', '-progress', 'pipe:1', '-nostats']

/**
 * Re-Encode-Codecs passend zum Ziel-Container (aus der Ausgabe-Endung):
 * - .webm -> VP9 + Opus (behält das WebM-Format des Uploads bei).
 * - sonst -> H.264 + AAC in mp4 (mit faststart fürs Web).
 */
function reencodeCodecs(outputPath: string): string[] {
  if (/\.webm$/i.test(outputPath)) {
    return [
      '-c:v',
      'libvpx-vp9',
      '-b:v',
      '0',
      '-crf',
      '32',
      '-row-mt',
      '1',
      '-deadline',
      'good',
      '-cpu-used',
      '4',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'libopus',
      '-b:a',
      '128k',
    ]
  }
  return [
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '23',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-movflags',
    '+faststart',
  ]
}

/** Behalten: schneidet [start, start+duration] heraus (copy = verlustfrei, sonst H.264/AAC). */
function keepArgs(
  input: string,
  output: string,
  start: number,
  duration: number,
  mode: TrimMode,
): string[] {
  const base = [
    ...PROGRESS,
    '-ss',
    formatFfmpegTime(start),
    '-i',
    input,
    '-t',
    formatFfmpegTime(Math.max(0, duration)),
  ]
  if (mode === 'copy') {
    return [...base, '-c', 'copy', '-avoid_negative_ts', 'make_zero', output]
  }
  return [...base, ...reencodeCodecs(output), output]
}

/** Re-Encode-Trim eines einzelnen Segments [start, start+duration]. */
function reencodeTrim(input: string, output: string, start: number, duration: number): string[] {
  const base = [
    ...PROGRESS,
    '-ss',
    formatFfmpegTime(start),
    '-i',
    input,
    '-t',
    formatFfmpegTime(Math.max(0, duration)),
  ]
  return [...base, ...reencodeCodecs(output), output]
}

/**
 * Fügt mehrere zu behaltende Bereiche zusammen. Jeder Bereich wird als eigener
 * Input eingelesen (`-ss/-t -i`) – NICHT über einen split, sonst puffern die
 * Zweige den Rest im Speicher (OOM). Immer Re-Encode (concat braucht Frames).
 */
function concatArgs(input: string, output: string, ranges: Segment[]): string[] {
  const inputs = ranges.flatMap((r) => [
    '-ss',
    formatFfmpegTime(r.start),
    '-t',
    formatFfmpegTime(Math.max(0, r.duration)),
    '-i',
    input,
  ])
  let filter = ''
  ranges.forEach((_, i) => {
    filter += `[${i}:v]setpts=PTS-STARTPTS[v${i}];[${i}:a]asetpts=PTS-STARTPTS[a${i}];`
  })
  filter +=
    ranges.map((_, i) => `[v${i}][a${i}]`).join('') +
    `concat=n=${ranges.length}:v=1:a=1[outv][outa]`

  return [
    ...PROGRESS,
    ...inputs,
    '-filter_complex',
    filter,
    '-map',
    '[outv]',
    '-map',
    '[outa]',
    ...reencodeCodecs(output),
    output,
  ]
}

/**
 * Fügt Bereiche mit weichem Übergang (xfade/acrossfade) zusammen. Jeder
 * Übergang blendet die letzten `d` Sekunden des vorigen Clips mit den ersten
 * `d` Sekunden des nächsten über (gleichmäßig auf beide Clips). Immer Re-Encode.
 */
function xfadeArgs(
  input: string,
  output: string,
  ranges: Segment[],
  type: string,
  d: number,
): string[] {
  const inputs = ranges.flatMap((r) => [
    '-ss',
    formatFfmpegTime(r.start),
    '-t',
    formatFfmpegTime(Math.max(0, r.duration)),
    '-i',
    input,
  ])

  // Jeden Clip normieren (PTS, Pixelformat) – xfade verlangt gleiche Basis.
  let filter = ''
  ranges.forEach((_, i) => {
    filter += `[${i}:v]setpts=PTS-STARTPTS,format=yuv420p[v${i}];[${i}:a]asetpts=PTS-STARTPTS[a${i}];`
  })

  // Video- und Audioketten mit kumulativem Offset aufbauen.
  let vPrev = 'v0'
  let aPrev = 'a0'
  let acc = ranges[0].duration
  for (let t = 1; t < ranges.length; t++) {
    const offset = acc - t * d // = sum(L0..L_{t-1}) - t*d
    const vOut = t === ranges.length - 1 ? 'outv' : `vx${t}`
    const aOut = t === ranges.length - 1 ? 'outa' : `ax${t}`
    filter += `[${vPrev}][v${t}]xfade=transition=${type}:duration=${d.toFixed(3)}:offset=${offset.toFixed(3)}[${vOut}];`
    filter += `[${aPrev}][a${t}]acrossfade=d=${d.toFixed(3)}:c1=tri:c2=tri[${aOut}];`
    vPrev = vOut
    aPrev = aOut
    acc += ranges[t].duration
  }

  return [
    ...PROGRESS,
    ...inputs,
    '-filter_complex',
    filter.replace(/;$/, ''),
    '-map',
    '[outv]',
    '-map',
    '[outa]',
    ...reencodeCodecs(output),
    output,
  ]
}

/**
 * Baut die vollständige Argumentliste für den nativen FFmpeg-Aufruf.
 * `-progress pipe:1` liefert maschinenlesbaren Fortschritt auf stdout.
 * Wird ausschließlich mit `spawn`/`execFile` genutzt (keine Shell → keine Injection).
 *
 * Verallgemeinert auf beliebig viele Ausschnitte:
 * - Ein einzelner zu behaltender Bereich + copy  -> verlustfreier Trim.
 * - Ein einzelner Bereich + reencode             -> Re-Encode-Trim.
 * - Mehrere Bereiche mit Übergang               -> Re-Encode + xfade-Kette.
 * - Mehrere Bereiche ohne Übergang              -> Re-Encode + concat.
 */
export function buildServerArgs({
  inputPath,
  outputPath,
  start = 0,
  duration = 0,
  mode,
  operation = 'keep',
  total,
  segments,
  transition,
}: ServerArgsInput): string[] {
  const src = segments && segments.length ? segments : [{ start, duration }]
  const fallbackTotal = operation === 'keep' ? Number.POSITIVE_INFINITY : start + duration
  const keep = computeKeepRanges(
    src,
    operation,
    Number.isFinite(total) ? (total as number) : fallbackTotal,
  )

  // Sicherheitsnetz (durch Validierung ausgeschlossen): nichts übrig.
  if (keep.length === 0) {
    return keepArgs(inputPath, outputPath, start, Math.max(0, duration), mode)
  }

  if (keep.length === 1) {
    const r = keep[0]
    // Verlustfrei nur bei 'keep' + copy sinnvoll; 'remove' kodiert immer neu.
    if (operation === 'keep' && mode === 'copy') {
      return keepArgs(inputPath, outputPath, r.start, r.duration, 'copy')
    }
    return reencodeTrim(inputPath, outputPath, r.start, r.duration)
  }

  const xf = effectiveTransition(keep, transition)
  if (xf) {
    return xfadeArgs(inputPath, outputPath, keep, xf.type, xf.d)
  }
  return concatArgs(inputPath, outputPath, keep)
}

/**
 * Erwartete Ausgabedauer (Sekunden) für die Fortschrittsanzeige.
 * Summe der behaltenen Bereiche, abzüglich der Überlappungen durch Übergänge.
 */
export function outputDurationFor(keep: Segment[], transition?: Transition): number {
  const sum = keep.reduce((s, r) => s + r.duration, 0)
  const xf = effectiveTransition(keep, transition)
  if (!xf) return sum
  return Math.max(0, sum - (keep.length - 1) * xf.d)
}
