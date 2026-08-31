/**
 * Reine (Browser-freie) Logik für den client-seitigen „Copy"-Remux.
 *
 * Idee (analog zum Audio-Cutter): Der verlustfreie Schnitt (`-c copy`) kopiert
 * nur bereits kodierte Frames – dafür ist KEIN Server nötig. Ein reiner
 * Remux im Browser (Container neu schreiben, Streams unverändert) spart den
 * kompletten Upload/Download und liefert dasselbe Ergebnis wie der Server.
 *
 * Dieses Modul enthält ausschließlich die testbare Kernlogik:
 *  - die Eignungsprüfung (wann darf der Fast-Path überhaupt greifen), und
 *  - die keyframe-genaue Auswahl des zu kopierenden Sample-Fensters.
 *
 * Die eigentliche MP4Box-Anbindung liegt in ../composables/useClientRemux.ts.
 */

import type { CutOperation } from '@/stores/videoEditor'
import type { TrimMode } from '@/lib/ffmpegCommand'

/** Kleine Zeit-Toleranz (Sekunden) gegen Rundungsfehler bei ms<->Timescale. */
export const EPS = 1e-3

/**
 * Container, die der Prototyp remuxen kann. Bewusst auf ISO-BMFF (MP4/MOV)
 * beschränkt – WebM/Matroska bräuchten einen anderen Muxer und fallen daher
 * auf den Server zurück.
 */
export const REMUXABLE_EXT: ReadonlySet<string> = new Set(['mp4', 'm4v', 'mov'])

export interface RemuxEligibility {
  operation: CutOperation
  mode: TrimMode
  /** Anzahl der zu verarbeitenden Ausschnitte. */
  segmentCount: number
  /** Datei-Endung ohne Punkt (Groß-/Kleinschreibung egal). */
  ext: string
}

/**
 * Der client-seitige Remux passt exakt dann, wenn der Server ohnehin nur
 * verlustfrei kopieren würde: EIN Ausschnitt, „behalten", Modus „copy" und ein
 * remuxbarer Container. Jeder andere Fall (entfernen, mehrere Ausschnitte,
 * Re-Encode, WebM) braucht FFmpeg und geht an den Server.
 */
export function isClientRemuxEligible({
  operation,
  mode,
  segmentCount,
  ext,
}: RemuxEligibility): boolean {
  return (
    operation === 'keep' &&
    mode === 'copy' &&
    segmentCount === 1 &&
    REMUXABLE_EXT.has(ext.toLowerCase())
  )
}

/** Ein Sample mit Zeitstempeln in Sekunden (aus den MP4Box-Sampledaten). */
export interface TimedSample {
  /** Composition time (Anzeigezeit) in Sekunden. */
  cts: number
  /** Decode time in Sekunden. */
  dts: number
  /** Ob es sich um ein Keyframe (Sync-Sample) handelt. */
  isSync: boolean
}

/** Das zu kopierende, keyframe-ausgerichtete Sample-Fenster. */
export interface SampleWindow {
  /** Index des ersten zu kopierenden Samples (immer ein Keyframe). */
  firstIndex: number
  /** Index des letzten zu kopierenden Samples (einschließlich). */
  lastIndex: number
  /** Tatsächliche Startzeit (Keyframe-Zeit) in Sekunden. */
  startTime: number
  /** cts des letzten kopierten Samples in Sekunden. */
  endTime: number
}

/**
 * Wählt für den Bereich [start, end] das keyframe-ausgerichtete Sample-Fenster
 * eines Video-Tracks – identisch zur Semantik von FFmpeg `-c copy`:
 *
 *  - Der Schnitt beginnt beim LETZTEN Keyframe bei/vor `start` (frühere
 *    Frames referenzieren sonst fehlende Daten). Gibt es davor keins, wird das
 *    erste Keyframe genommen.
 *  - Das Ende ist das letzte Sample mit `cts <= end` (mindestens der Start).
 *
 * Erwartet Samples in Dekodier-Reihenfolge (wie MP4Box liefert). Liefert
 * `null`, wenn keine Samples/keine Keyframes vorhanden sind.
 */
export function selectSampleWindow(
  samples: readonly TimedSample[],
  start: number,
  end: number,
): SampleWindow | null {
  if (samples.length === 0) return null

  const lo = Math.max(0, Math.min(start, end))
  const hi = Math.max(start, end)

  // Letztes Keyframe bei/vor lo (Fallback: erstes Keyframe überhaupt).
  let firstIndex = -1
  let firstKeyframe = -1
  for (let i = 0; i < samples.length; i++) {
    if (!samples[i].isSync) continue
    if (firstKeyframe < 0) firstKeyframe = i
    if (samples[i].cts <= lo + EPS) firstIndex = i
    else break
  }
  if (firstIndex < 0) firstIndex = firstKeyframe
  if (firstIndex < 0) return null // kein einziges Keyframe -> nicht remuxbar

  // Letztes Sample mit cts <= hi; nie vor firstIndex.
  let lastIndex = firstIndex
  for (let i = firstIndex; i < samples.length; i++) {
    if (samples[i].cts <= hi + EPS) lastIndex = i
    else break
  }

  return {
    firstIndex,
    lastIndex,
    startTime: samples[firstIndex].cts,
    endTime: samples[lastIndex].cts,
  }
}

/**
 * Indizes der Audio-Samples, die zeitlich in [startTime, endTime] fallen –
 * passend zum bereits bestimmten Video-Fenster. Audio hat i. d. R. sehr kurze
 * Samples und keine „echten" Keyframes; wir kopieren alles, dessen cts im
 * Fenster liegt (inklusiv, mit Toleranz).
 */
export function selectAudioWindow(
  samples: readonly TimedSample[],
  startTime: number,
  endTime: number,
): { firstIndex: number; lastIndex: number } | null {
  if (samples.length === 0) return null
  let firstIndex = -1
  let lastIndex = -1
  for (let i = 0; i < samples.length; i++) {
    const c = samples[i].cts
    if (c >= startTime - EPS && c <= endTime + EPS) {
      if (firstIndex < 0) firstIndex = i
      lastIndex = i
    }
  }
  if (firstIndex < 0) return null
  return { firstIndex, lastIndex }
}
