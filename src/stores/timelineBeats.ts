import { defineStore } from 'pinia'
import { computed, ref, shallowRef, watch } from 'vue'
import { fetchBeats, type BeatAnalysis } from '@/lib/beatsApi'
import {
  addBeatMarkers,
  beatGridTimes,
  beatMarkerCount,
  beatSourceClip,
  fitClipsToBeats,
  removeBeatMarkers,
  splitClipsAtBeats,
  type BeatGrid,
  type BeatResult,
} from '@/timeline/beats'
import type { MarkerEffectKind, OpError, Time } from '@/timeline/model'
import { useTimelineStore } from './timeline'

/**
 * Schnitt im Takt (neuer Editor): Takt eines Ton- oder Video-Clips erkennen
 * lassen, das Raster auf der Timeline zeigen (prüfen, einrasten) und auf
 * Wunsch übernehmen. Nur Bedienzustand – gespeichert wird erst, was
 * übernommen ist (Marker, Schnitte).
 */
export const useTimelineBeatsStore = defineStore('timelineBeats', () => {
  const timeline = useTimelineStore()

  /** Clip, dessen Takt erkannt wurde (Quelle des Rasters). */
  const clipId = ref<string | null>(null)
  const analysis = shallowRef<BeatAnalysis | null>(null)
  const loading = ref(false)
  /** Fehlermeldung bzw. `BEATS_UNSUPPORTED`. */
  const error = ref('')
  const grid = ref<BeatGrid>('beat')
  const shift = ref(0)
  /** Verschiebung des Rasters in Millisekunden. */
  const offsetMs = ref(0)
  /** Raster auf der Timeline zeigen und daran einrasten. */
  const showGrid = ref(true)

  let controller: AbortController | null = null

  const sourceClip = computed(() => beatSourceClip(timeline.doc, clipId.value))

  /** Rasterpunkte auf der Timeline (leer ohne Ergebnis oder ohne Clip). */
  const times = computed<Time[]>(() => {
    const a = analysis.value
    const c = sourceClip.value
    if (!a || !c || (c.kind !== 'audio' && c.kind !== 'video')) return []
    return beatGridTimes(
      a,
      c,
      { grid: grid.value, shift: shift.value, offset: Math.round(offsetMs.value * 1000) },
      timeline.doc.settings.fps,
    )
  })

  /** Was die Timeline zeichnet (bei ausgeschaltetem Raster nichts). */
  const visibleTimes = computed(() => (showGrid.value ? times.value : []))

  watch(visibleTimes, (t) => timeline.setSnapGuides(t), { immediate: true })

  const beatMarkers = computed(() => beatMarkerCount(timeline.doc))

  /** Takt des Clips erkennen lassen (beim Server, ein Abruf je Medium). */
  async function detect(id: string): Promise<boolean> {
    const clip = beatSourceClip(timeline.doc, id)
    if (!clip || (clip.kind !== 'audio' && clip.kind !== 'video')) return false
    controller?.abort()
    const ctrl = new AbortController()
    controller = ctrl
    loading.value = true
    error.value = ''
    try {
      const result = await fetchBeats(clip.asset, ctrl.signal)
      if (controller !== ctrl) return false
      clipId.value = id
      analysis.value = result
      shift.value = 0
      return result.beats.length > 0
    } catch (err) {
      if (controller !== ctrl || ctrl.signal.aborted) return false
      error.value = err instanceof Error ? err.message : String(err)
      return false
    } finally {
      if (controller === ctrl) {
        loading.value = false
        controller = null
      }
    }
  }

  /** Raster verwerfen (nichts auf der Timeline ändert sich). */
  function clear(): void {
    controller?.abort()
    controller = null
    loading.value = false
    clipId.value = null
    analysis.value = null
    error.value = ''
  }

  /** Einen reinen Befehl als einen Verlaufsschritt anwenden; Ergebnis bzw. Fehler. */
  function run<T>(op: () => BeatResult<T>): { info: T } | { error: OpError } {
    const result = op()
    if (!result.ok) return { error: result.error }
    timeline.apply(() => ({ ok: true, doc: result.doc }))
    return { info: result.info }
  }

  function applyMarkers(effect: MarkerEffectKind | null) {
    return run(() => addBeatMarkers(timeline.doc, times.value, { effect }))
  }

  function removeMarkers() {
    return run(() => removeBeatMarkers(timeline.doc))
  }

  function fitClips(trackId: string) {
    return run(() => fitClipsToBeats(timeline.doc, trackId, times.value))
  }

  function splitClips(trackId: string) {
    return run(() => splitClipsAtBeats(timeline.doc, trackId, times.value))
  }

  return {
    clipId,
    analysis,
    loading,
    error,
    grid,
    shift,
    offsetMs,
    showGrid,
    sourceClip,
    times,
    visibleTimes,
    beatMarkers,
    detect,
    clear,
    applyMarkers,
    removeMarkers,
    fitClips,
    splitClips,
  }
})
