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

/** Räumlicher Bildausschnitt: Anteile [0,1] der Originalbreite/-höhe. */
export interface CropRect {
  x: number
  y: number
  width: number
  height: number
}

/** Mindestgröße des Bildausschnitts (Anteil der jeweiligen Kante). */
const MIN_CROP_RATIO = 0.1

/**
 * Baut den FFmpeg-`crop`-Filter aus Anteilswerten – über `iw`/`ih`-Ausdrücke,
 * damit KEINE Quellauflösung (kein ffprobe) bekannt sein muss. Breite/Höhe
 * werden auf gerade Pixelzahlen abgerundet (Encoder-Anforderung bei yuv420p).
 */
export function buildCropFilter(crop: CropRect): string {
  const width = Math.min(1, Math.max(MIN_CROP_RATIO, crop.width))
  const height = Math.min(1, Math.max(MIN_CROP_RATIO, crop.height))
  const x = Math.min(Math.max(0, crop.x), 1 - width)
  const y = Math.min(Math.max(0, crop.y), 1 - height)
  return (
    `crop=trunc(iw*${width}/2)*2:trunc(ih*${height}/2)*2:` + `trunc(iw*${x}/2)*2:trunc(ih*${y}/2)*2`
  )
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
  /** Optionaler Bildausschnitt. Erzwingt Re-Encode (kein Stream-Copy möglich). */
  crop?: CropRect
}

/**
 * Effektive, sichere xfade-Überblenddauer für die gegebenen Bereiche.
 * - null, wenn kein/none-Übergang oder weniger als zwei Bereiche.
 * - `transition.duration` ist die GESAMTdauer der Animation, gleichmäßig auf
 *   beide Clips verteilt (z. B. 4 s = 2 s ausblenden + 2 s einblenden). Die
 *   xfade-Überblendung (wo beide gleichzeitig laufen) ist daher die Hälfte.
 * - Auf die Bereichslängen begrenzt, damit xfade nie mehr Material verlangt,
 *   als vorhanden ist (innere Bereiche werden zweimal genutzt -> halbe Länge).
 */
export function effectiveTransition(
  ranges: Segment[],
  transition?: Transition,
): { preset: Exclude<TransitionPreset, 'none'>; type: string; d: number } | null {
  if (!transition || transition.preset === 'none' || ranges.length < 2) return null
  const type = XFADE_TYPES[transition.preset]
  const minLen = Math.min(...ranges.map((r) => r.duration))
  const cap = ranges.length > 2 ? minLen / 2 : minLen
  // Gesamtdauer -> je Clip die Hälfte (ausblenden + einblenden).
  const d = Math.min(transition.duration / 2, Math.max(0, cap - 0.05))
  if (!(d >= 0.1)) return null
  return { preset: transition.preset, type, d }
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

/** Re-Encode-Trim eines einzelnen Segments [start, start+duration], optional mit Zuschnitt. */
function reencodeTrim(
  input: string,
  output: string,
  start: number,
  duration: number,
  crop?: CropRect,
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
  const filterArgs = crop ? ['-vf', buildCropFilter(crop)] : []
  return [...base, ...filterArgs, ...reencodeCodecs(output), output]
}

/**
 * Fügt mehrere zu behaltende Bereiche zusammen. Jeder Bereich wird als eigener
 * Input eingelesen (`-ss/-t -i`) – NICHT über einen split, sonst puffern die
 * Zweige den Rest im Speicher (OOM). Immer Re-Encode (concat braucht Frames).
 */
function concatArgs(input: string, output: string, ranges: Segment[], crop?: CropRect): string[] {
  const inputs = ranges.flatMap((r) => [
    '-ss',
    formatFfmpegTime(r.start),
    '-t',
    formatFfmpegTime(Math.max(0, r.duration)),
    '-i',
    input,
  ])
  const cropPre = crop ? `${buildCropFilter(crop)},` : ''
  let filter = ''
  ranges.forEach((_, i) => {
    filter += `[${i}:v]${cropPre}setpts=PTS-STARTPTS[v${i}];[${i}:a]asetpts=PTS-STARTPTS[a${i}];`
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
  crop?: CropRect,
): string[] {
  const inputs = ranges.flatMap((r) => [
    '-ss',
    formatFfmpegTime(r.start),
    '-t',
    formatFfmpegTime(Math.max(0, r.duration)),
    '-i',
    input,
  ])

  // Jeden Clip normieren – xfade verlangt gleiche Basis UND konstante Bildrate
  // (variable Framerate lässt den Übergang sonst „verschwinden"/verrutschen).
  const cropPre = crop ? `${buildCropFilter(crop)},` : ''
  let filter = ''
  ranges.forEach((_, i) => {
    filter += `[${i}:v]${cropPre}fps=30,format=yuv420p,setpts=PTS-STARTPTS[v${i}];[${i}:a]asetpts=PTS-STARTPTS[a${i}];`
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
 * Fügt Bereiche mit „Dip to Black" zusammen: der vorige Clip blendet über `f`
 * Sekunden nach Schwarz aus, der nächste blendet über `f` Sekunden aus Schwarz
 * ein (nacheinander, ohne Überlappung). Deutlich sichtbar. Immer Re-Encode.
 */
function fadeDipArgs(
  input: string,
  output: string,
  ranges: Segment[],
  f: number,
  crop?: CropRect,
): string[] {
  const inputs = ranges.flatMap((r) => [
    '-ss',
    formatFfmpegTime(r.start),
    '-t',
    formatFfmpegTime(Math.max(0, r.duration)),
    '-i',
    input,
  ])
  const fd = f.toFixed(3)
  let filter = ''
  ranges.forEach((r, i) => {
    const outStart = Math.max(0, r.duration - f).toFixed(3)
    const vfx = crop ? [buildCropFilter(crop), 'setpts=PTS-STARTPTS'] : ['setpts=PTS-STARTPTS']
    const afx = ['asetpts=PTS-STARTPTS']
    if (i > 0) {
      vfx.push(`fade=t=in:st=0:d=${fd}`)
      afx.push(`afade=t=in:st=0:d=${fd}`)
    }
    if (i < ranges.length - 1) {
      vfx.push(`fade=t=out:st=${outStart}:d=${fd}`)
      afx.push(`afade=t=out:st=${outStart}:d=${fd}`)
    }
    vfx.push('format=yuv420p')
    filter += `[${i}:v]${vfx.join(',')}[v${i}];[${i}:a]${afx.join(',')}[a${i}];`
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
  crop,
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
    if (crop) return reencodeTrim(inputPath, outputPath, start, Math.max(0, duration), crop)
    return keepArgs(inputPath, outputPath, start, Math.max(0, duration), mode)
  }

  if (keep.length === 1) {
    const r = keep[0]
    // Verlustfrei nur bei 'keep' + copy + ohne Zuschnitt möglich; Zuschneiden
    // erfordert Decode+Encode, 'remove' kodiert ohnehin immer neu.
    if (operation === 'keep' && mode === 'copy' && !crop) {
      return keepArgs(inputPath, outputPath, r.start, r.duration, 'copy')
    }
    return reencodeTrim(inputPath, outputPath, r.start, r.duration, crop)
  }

  const xf = effectiveTransition(keep, transition)
  if (xf) {
    // 'fade' = Dip to Black (nacheinander, keine Überlappung), sonst xfade.
    if (xf.preset === 'fade') {
      return fadeDipArgs(inputPath, outputPath, keep, xf.d, crop)
    }
    return xfadeArgs(inputPath, outputPath, keep, xf.type, xf.d, crop)
  }
  return concatArgs(inputPath, outputPath, keep, crop)
}

/**
 * Erwartete Ausgabedauer (Sekunden) für die Fortschrittsanzeige.
 * Summe der behaltenen Bereiche – bei xfade abzüglich der Überlappungen; das
 * Dip-to-Black ('fade') überlappt nicht und behält die volle Länge.
 */
export function outputDurationFor(keep: Segment[], transition?: Transition): number {
  const sum = keep.reduce((s, r) => s + r.duration, 0)
  const xf = effectiveTransition(keep, transition)
  if (!xf || xf.preset === 'fade') return sum
  return Math.max(0, sum - (keep.length - 1) * xf.d)
}

// ---------------------------------------------------------------------------
// Zusammenfügen mit weiteren (hochgeladenen) Videos
// ---------------------------------------------------------------------------

/** Wo ein angehängtes Video landet: vor oder hinter den Ausschnitten. */
export type AppendPosition = 'before' | 'after'

/** Ein angehängtes Video (ggf. auf [start, start+duration] gekürzt). */
export interface AppendClip {
  path: string
  /** Startpunkt im angehängten Video (Sekunden). Standard 0. */
  start?: number
  /** Verwendete Länge in Sekunden (> 0, bereits auf die echte Dauer begrenzt). */
  duration: number
  /** Hat das Video eine Tonspur? Sonst wird Stille eingesetzt. */
  hasAudio: boolean
  /** Standard 'after'. */
  position?: AppendPosition
  /**
   * Nur bei 'after': direkt hinter dem n-ten behaltenen Bereich des
   * Hauptvideos einfügen (1-basiert). Fehlt oder ≥ Anzahl Bereiche = ganz am Ende.
   */
  slot?: number
}

/**
 * Effektive Einfügestelle eines angehängten Videos: Anzahl der Bereiche des
 * Hauptvideos, die VOR ihm laufen (0 = ganz vorne, `mainCount` = ganz hinten).
 */
export function appendSlot(a: AppendClip, mainCount: number): number {
  if (a.position === 'before') return 0
  const s = a.slot
  if (s === undefined || !Number.isInteger(s) || s < 1 || s >= mainCount) return mainCount
  return s
}

/**
 * Gesamtreihenfolge beim Zusammenfügen: die Bereiche des Hauptvideos in
 * Zeitreihenfolge, die angehängten Videos an ihrer Einfügestelle (bei gleicher
 * Stelle in Listenreihenfolge).
 */
export function mergeSequence(
  mainCount: number,
  appends: AppendClip[],
): ({ kind: 'main'; index: number } | { kind: 'append'; index: number })[] {
  const seq: ({ kind: 'main'; index: number } | { kind: 'append'; index: number })[] = []
  for (let k = 0; k <= mainCount; k++) {
    if (k > 0) seq.push({ kind: 'main', index: k - 1 })
    appends.forEach((a, i) => {
      if (appendSlot(a, mainCount) === k) seq.push({ kind: 'append', index: i })
    })
  }
  return seq
}

export interface MergeArgsInput {
  inputPath: string
  outputPath: string
  /** Zu behaltende Bereiche des Hauptvideos (bereits über computeKeepRanges ermittelt). */
  keep: Segment[]
  /** Hat das Hauptvideo eine Tonspur? */
  mainHasAudio: boolean
  /** Angehängte Videos in Reihenfolge (Position je Clip: davor/danach). */
  appends: AppendClip[]
  /** Zielauflösung (gerade Pixelzahlen); alle Clips werden darauf skaliert/gepolstert. */
  width: number
  height: number
  transition?: Transition
  /** Bildausschnitt – gilt nur für das Hauptvideo (Anteile beziehen sich darauf). */
  crop?: CropRect
  /** Lautstärke aller Clips per EBU-R128 (`loudnorm`) auf ein Niveau angleichen. */
  normalizeAudio?: boolean
  /** Wie Clips mit anderem Seitenverhältnis das Zielbild füllen. Standard 'pad'. */
  fill?: OutputFill
  /** Optionale Hintergrundmusik über das gesamte Ergebnis. */
  music?: MusicTrack
  /**
   * Übergang je Nahtstelle (Länge = Clipanzahl − 1). `null` = globaler Übergang
   * (`transition`). Ohne Angabe gilt überall der globale Übergang.
   */
  seams?: (TransitionPreset | null)[]
}

/**
 * Löst die Übergänge je Nahtstelle auf: `null` -> globaler Preset (bzw. 'none').
 * Liefert zusätzlich die gemeinsame Überblenddauer `d` (Sekunden, je Clip),
 * begrenzt wie beim globalen Übergang; 0, wenn keine Nahtstelle animiert ist.
 */
export function resolveSeams(
  ranges: Segment[],
  seams: (TransitionPreset | null)[],
  transition?: Transition,
): { presets: TransitionPreset[]; d: number } {
  const global: TransitionPreset = transition?.preset ?? 'none'
  const presets = seams.map((p) => p ?? global)
  const duration = transition?.duration ?? 1
  // Dieselbe Begrenzung wie global (Preset hier egal, nur nicht 'none').
  const eff = effectiveTransition(ranges, { preset: 'slide', duration })
  const d = presets.some((p) => p !== 'none') && eff ? eff.d : 0
  return { presets: d > 0 ? presets : presets.map(() => 'none'), d }
}

/**
 * Ausgabedauer bei Übergängen je Nahtstelle: Summe minus Überlappung jeder
 * xfade-Nahtstelle (Dip to Black und harte Schnitte überlappen nicht).
 */
export function seamOutputDuration(
  ranges: Segment[],
  seams: (TransitionPreset | null)[],
  transition?: Transition,
): number {
  const sum = ranges.reduce((acc, r) => acc + r.duration, 0)
  const { presets, d } = resolveSeams(ranges, seams, transition)
  const overlaps = presets.filter((p) => p !== 'none' && p !== 'fade').length
  return Math.max(0, sum - overlaps * d)
}

/** Ausgabedauer beim Zusammenfügen (mit oder ohne Übergänge je Nahtstelle). */
export function mergeOutputDuration(
  ranges: Segment[],
  transition?: Transition,
  seams?: (TransitionPreset | null)[],
): number {
  return seams
    ? seamOutputDuration(ranges, seams, transition)
    : outputDurationFor(ranges, transition)
}

/** Hintergrundmusik, die unter das fertige Ergebnis gemischt wird. */
export interface MusicTrack {
  path: string
  /** Lautstärke der Musik (0–1). */
  volume: number
  /** Lautstärke des Originaltons (0–1). */
  originalVolume: number
  /** Musik am Anfang ein- und am Ende ausblenden. */
  fade: boolean
  /** Musik wiederholen, falls sie kürzer als das Video ist. */
  loop: boolean
}

/** Länge der Musik-Ein-/Ausblendung (Sekunden), höchstens ein Viertel der Gesamtlänge. */
const MUSIC_FADE_SEC = 2

/**
 * Filter-Abschnitt, der die Musik (Input `inputIndex`) unter `[mainLabel]`
 * mischt und als `[outa]` ausgibt. `total` = Länge des Ergebnisses.
 * amix teilt jeden Eingang durch die Anzahl der Eingänge; `volume=2` gleicht
 * das aus (funktioniert auch mit älteren FFmpeg-Versionen ohne `normalize`).
 */
export function musicMixFilter(
  music: MusicTrack,
  inputIndex: number,
  mainLabel: string,
  total: number,
): string {
  const vol = Math.min(1, Math.max(0, music.volume))
  const orig = Math.min(1, Math.max(0, music.originalVolume))
  const T = Math.max(0.001, total)
  const mfx = [
    AUDIO_NORM,
    `volume=${vol.toFixed(3)}`,
    `atrim=0:${T.toFixed(3)}`,
    'asetpts=PTS-STARTPTS',
  ]
  if (music.fade) {
    const f = Math.min(MUSIC_FADE_SEC, T / 4)
    if (f >= 0.1) {
      mfx.push(`afade=t=in:st=0:d=${f.toFixed(3)}`)
      mfx.push(`afade=t=out:st=${Math.max(0, T - f).toFixed(3)}:d=${f.toFixed(3)}`)
    }
  }
  return (
    `[${inputIndex}:a]${mfx.join(',')}[mus];` +
    `[${mainLabel}]volume=${orig.toFixed(3)}[aorig];` +
    `[aorig][mus]amix=inputs=2:duration=first:dropout_transition=0,volume=2[outa]`
  )
}

/** Ausgabe-Seitenverhältnis: 'auto' = wie das (ggf. zugeschnittene) Hauptvideo. */
export type OutputAspect = 'auto' | '16:9' | '9:16' | '1:1'
/**
 * Füllmodus bei abweichendem Seitenverhältnis:
 * - 'pad'  = schwarze Balken (Letterbox/Pillarbox),
 * - 'blur' = unscharf vergrößertes Bild als Hintergrund,
 * - 'crop' = auf volle Fläche vergrößern und Überstand abschneiden.
 */
export type OutputFill = 'pad' | 'blur' | 'crop'

export const OUTPUT_ASPECTS: OutputAspect[] = ['auto', '16:9', '9:16', '1:1']
export const OUTPUT_FILLS: OutputFill[] = ['pad', 'blur', 'crop']

const ASPECT_RATIOS: Record<Exclude<OutputAspect, 'auto'>, [number, number]> = {
  '16:9': [16, 9],
  '9:16': [9, 16],
  '1:1': [1, 1],
}

/**
 * Zielauflösung für ein gewähltes Seitenverhältnis. Die kurze Kante des
 * Hauptvideos bleibt erhalten (1920×1080 -> 9:16 = 1080×1920, 1:1 = 1080×1080),
 * damit nichts unnötig hoch- oder herunterskaliert wird.
 */
export function outputTargetSize(
  base: { width: number; height: number },
  aspect: OutputAspect,
): { width: number; height: number } {
  if (aspect === 'auto') return { width: evenPx(base.width), height: evenPx(base.height) }
  const [aw, ah] = ASPECT_RATIOS[aspect]
  const short = Math.min(base.width, base.height)
  return aw >= ah
    ? { width: evenPx((short * aw) / ah), height: evenPx(short) }
    : { width: evenPx(short), height: evenPx((short * ah) / aw) }
}

/**
 * Filterkette, die einen Clip auf W×H bringt. Liefert einen Filtergraph-
 * Abschnitt von `[in]` bis `[out]`; `post` wird am Ende angehängt.
 */
function fitFilter(
  inLabel: string,
  outLabel: string,
  W: number,
  H: number,
  fill: OutputFill,
  pre: string[],
  post: string[],
): string {
  const head = pre.length ? `${pre.join(',')},` : ''
  const tail = post.join(',')
  switch (fill) {
    case 'pad':
      return (
        `[${inLabel}]${head}scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
        `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,${tail}[${outLabel}]`
      )
    case 'crop':
      return (
        `[${inLabel}]${head}scale=${W}:${H}:force_original_aspect_ratio=increase,` +
        `crop=${W}:${H},${tail}[${outLabel}]`
      )
    case 'blur': {
      // Hintergrund klein rechnen, weichzeichnen, wieder hochskalieren – deutlich
      // schneller als ein großer Blur auf voller Auflösung.
      const bw = evenPx(W / 8)
      const bh = evenPx(H / 8)
      const b = `${outLabel}b`
      const f = `${outLabel}f`
      const bb = `${outLabel}bb`
      const ff = `${outLabel}ff`
      return (
        `[${inLabel}]${head}split=2[${b}][${f}];` +
        `[${b}]scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},` +
        `gblur=sigma=6,scale=${W}:${H},setsar=1[${bb}];` +
        `[${f}]scale=${W}:${H}:force_original_aspect_ratio=decrease,setsar=1[${ff}];` +
        `[${bb}][${ff}]overlay=(W-w)/2:(H-h)/2,${tail}[${outLabel}]`
      )
    }
    default: {
      const never: never = fill
      throw new Error(`Unbekannter Füllmodus: ${String(never)}`)
    }
  }
}

/**
 * Lautheits-Angleichung je Clip (EBU R128, Single-Pass): -16 LUFS integriert,
 * max. -1,5 dBTP. `loudnorm` gibt intern 192 kHz aus – die anschließende
 * Audio-Normierung (AUDIO_NORM) setzt wieder auf 48 kHz.
 */
export const LOUDNORM_FILTER = 'loudnorm=I=-16:TP=-1.5:LRA=11'

/** Gemeinsame Bildrate aller Clips (concat/xfade verlangen identische Parameter). */
const MERGE_FPS = 30
/** Audio-Normierung: alle Clips auf 48 kHz Stereo (concat verlangt gleiches Format). */
const AUDIO_NORM = 'aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo'

/** Rundet auf eine gerade Pixelzahl ≥ 2 (Encoder-Anforderung bei yuv420p). */
export function evenPx(n: number): number {
  return Math.max(2, Math.floor(n / 2) * 2)
}

/**
 * Zielauflösung beim Zusammenfügen: die (ggf. zugeschnittene) Auflösung des
 * Hauptvideos. Fallback 1280×720, falls ffprobe keine Maße lieferte.
 */
export function mergeTargetSize(
  width: number,
  height: number,
  crop?: CropRect,
): { width: number; height: number } {
  if (!(width > 0) || !(height > 0)) return { width: 1280, height: 720 }
  const w = crop ? width * Math.min(1, Math.max(MIN_CROP_RATIO, crop.width)) : width
  const h = crop ? height * Math.min(1, Math.max(MIN_CROP_RATIO, crop.height)) : height
  return { width: evenPx(w), height: evenPx(h) }
}

/**
 * Fügt die behaltenen Bereiche des Hauptvideos und die angehängten Videos zu
 * einer Datei zusammen. Jeder Clip wird auf gleiche Auflösung (Letterbox statt
 * Verzerrung), Bildrate, Pixel- und Audioformat normiert; fehlende Tonspuren
 * werden durch Stille ersetzt. Übergänge wie beim Mehrfach-Schnitt. Immer Re-Encode.
 */
export function buildMergeArgs({
  inputPath,
  outputPath,
  keep,
  mainHasAudio,
  appends,
  width,
  height,
  transition,
  crop,
  normalizeAudio = false,
  fill = 'pad',
  music,
  seams,
}: MergeArgsInput): string[] {
  const W = evenPx(width)
  const H = evenPx(height)

  const appendClip = (a: AppendClip) => ({
    inputArgs: [
      ...(a.start && a.start > 0 ? ['-ss', formatFfmpegTime(a.start)] : []),
      '-t',
      formatFfmpegTime(Math.max(0, a.duration)),
      '-i',
      a.path,
    ],
    duration: a.duration,
    hasAudio: a.hasAudio,
    crop: undefined as CropRect | undefined,
  })
  const mainClip = (r: Segment) => ({
    inputArgs: [
      '-ss',
      formatFfmpegTime(r.start),
      '-t',
      formatFfmpegTime(Math.max(0, r.duration)),
      '-i',
      inputPath,
    ],
    duration: r.duration,
    hasAudio: mainHasAudio,
    crop,
  })

  const clips = mergeSequence(keep.length, appends).map((item) =>
    item.kind === 'main' ? mainClip(keep[item.index]) : appendClip(appends[item.index]),
  )

  const ranges: Segment[] = clips.map((c) => ({ start: 0, duration: c.duration }))
  const xf = effectiveTransition(ranges, transition)
  const dip = xf?.preset === 'fade' ? xf.d : 0
  if (seams && seams.length !== Math.max(0, clips.length - 1)) {
    throw new Error('Anzahl der Übergänge passt nicht zur Anzahl der Clips.')
  }
  const perSeam = seams ? resolveSeams(ranges, seams, transition) : null
  /** Dip to Black an Nahtstelle k (zwischen Clip k und k+1)? Liefert die Länge oder 0. */
  const dipAt = (k: number): number => {
    if (perSeam) return perSeam.presets[k] === 'fade' ? perSeam.d : 0
    return k >= 0 && k < clips.length - 1 ? dip : 0
  }

  let filter = ''
  clips.forEach((c, i) => {
    const pre = c.crop ? [buildCropFilter(c.crop)] : []
    const vfx = ['setsar=1', `fps=${MERGE_FPS}`, 'format=yuv420p', 'setpts=PTS-STARTPTS']
    // Stille (anullsrc) braucht keine Lautheits-Angleichung.
    const afx = [
      ...(normalizeAudio && c.hasAudio ? [LOUDNORM_FILTER] : []),
      AUDIO_NORM,
      'asetpts=PTS-STARTPTS',
    ]
    const dipIn = i > 0 ? dipAt(i - 1) : 0
    const dipOut = i < clips.length - 1 ? dipAt(i) : 0
    if (dipIn > 0) {
      const fd = dipIn.toFixed(3)
      vfx.push(`fade=t=in:st=0:d=${fd}`)
      afx.push(`afade=t=in:st=0:d=${fd}`)
    }
    if (dipOut > 0) {
      const fd = dipOut.toFixed(3)
      const outStart = Math.max(0, c.duration - dipOut).toFixed(3)
      vfx.push(`fade=t=out:st=${outStart}:d=${fd}`)
      afx.push(`afade=t=out:st=${outStart}:d=${fd}`)
    }
    filter += `${fitFilter(`${i}:v`, `v${i}`, W, H, fill, pre, vfx)};`
    // Ohne Tonspur: Stille in exakt der Clip-Länge erzeugen.
    const aSrc = c.hasAudio
      ? `[${i}:a]`
      : `anullsrc=r=48000:cl=stereo:d=${Math.max(0.001, c.duration).toFixed(3)},`
    filter += `${aSrc}${afx.join(',')}[a${i}];`
  })

  // Mit Musik endet die Clip-Kette in [amain]; die Mischung liefert dann [outa].
  const aFinal = music ? 'amain' : 'outa'
  if (perSeam && clips.length > 1) {
    // Gemischte Kette: je Nahtstelle xfade (überlappend) oder concat (harter
    // Schnitt bzw. Dip to Black – die Blenden stecken schon in den Clips).
    let vPrev = 'v0'
    let aPrev = 'a0'
    let len = clips[0].duration
    const d = perSeam.d
    for (let t = 1; t < clips.length; t++) {
      const preset = perSeam.presets[t - 1]
      const last = t === clips.length - 1
      const vOut = last ? 'outv' : `vs${t}`
      const aOut = last ? aFinal : `as${t}`
      if (preset === 'none' || preset === 'fade') {
        // concat liefert Zeitbasis 1/1000000 – ein folgendes xfade verlangt
        // dieselbe Zeitbasis wie die Clips (1/fps), daher zurücksetzen.
        filter += `[${vPrev}][${aPrev}][v${t}][a${t}]concat=n=2:v=1:a=1[${vOut}c][${aOut}];`
        filter += `[${vOut}c]settb=1/${MERGE_FPS}[${vOut}];`
        len += clips[t].duration
      } else {
        const type = XFADE_TYPES[preset]
        const offset = Math.max(0, len - d)
        filter += `[${vPrev}][v${t}]xfade=transition=${type}:duration=${d.toFixed(3)}:offset=${offset.toFixed(3)}[${vOut}];`
        filter += `[${aPrev}][a${t}]acrossfade=d=${d.toFixed(3)}:c1=tri:c2=tri[${aOut}];`
        len += clips[t].duration - d
      }
      vPrev = vOut
      aPrev = aOut
    }
    filter = filter.replace(/;$/, '')
  } else if (xf && xf.preset !== 'fade' && clips.length > 1) {
    let vPrev = 'v0'
    let aPrev = 'a0'
    let acc = clips[0].duration
    for (let t = 1; t < clips.length; t++) {
      const offset = acc - t * xf.d
      const last = t === clips.length - 1
      const vOut = last ? 'outv' : `vx${t}`
      const aOut = last ? aFinal : `ax${t}`
      filter += `[${vPrev}][v${t}]xfade=transition=${xf.type}:duration=${xf.d.toFixed(3)}:offset=${offset.toFixed(3)}[${vOut}];`
      filter += `[${aPrev}][a${t}]acrossfade=d=${xf.d.toFixed(3)}:c1=tri:c2=tri[${aOut}];`
      vPrev = vOut
      aPrev = aOut
      acc += clips[t].duration
    }
    filter = filter.replace(/;$/, '')
  } else {
    filter +=
      clips.map((_, i) => `[v${i}][a${i}]`).join('') +
      `concat=n=${clips.length}:v=1:a=1[outv][${aFinal}]`
  }

  const musicInput: string[] = []
  if (music) {
    filter += `;${musicMixFilter(music, clips.length, aFinal, mergeOutputDuration(ranges, transition, seams))}`
    musicInput.push(...(music.loop ? ['-stream_loop', '-1'] : []), '-i', music.path)
  }

  return [
    ...PROGRESS,
    ...clips.flatMap((c) => c.inputArgs),
    ...musicInput,
    '-filter_complex',
    filter,
    '-map',
    '[outv]',
    '-map',
    '[outa]',
    ...reencodeCodecs(outputPath),
    outputPath,
  ]
}
