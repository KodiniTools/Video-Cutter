import { onBeforeUnmount, watch, type Ref } from 'vue'
import { frameSeekTime, lastFrameSeekTime } from '@/lib/frameTime'

/** Verwendeter Bereich eines Clips (Von/Bis aus der Liste); `to` = Infinity bis Dateiende. */
export interface ListRange {
  from: number
  to: number
}

/** Halbes Bild Vorlauf, damit nicht schon das erste Bild NACH „Bis" aufblitzt. */
function tolerance(fps: number): number {
  return Number.isFinite(fps) && fps > 0 ? 0.5 / fps : 0.005
}

/**
 * Wohin „Abspielen" springt: liegt die Position außerhalb von Von–Bis, an den
 * Anfang des Bereichs; sonst `null` (an Ort und Stelle weiterspielen).
 * Reine Funktion (testbar).
 */
export function playJumpTarget(t: number, range: ListRange, fps: number): number | null {
  // Am letzten Bild angehalten (dort endet die Wiedergabe) zählt als „am Ende".
  const last = Number.isFinite(range.to) ? lastFrameSeekTime(range.from, range.to, fps) : Infinity
  if (t >= range.from - tolerance(fps) && t < last - 1e-3) return null
  return frameSeekTime(range.from, fps)
}

/** Hat die Wiedergabe das Ende des Bereichs erreicht? */
export function reachedRangeEnd(t: number, range: ListRange, fps: number): boolean {
  return Number.isFinite(range.to) && t >= range.to - tolerance(fps)
}

export interface ListRangePlaybackOptions {
  video: Ref<HTMLVideoElement | null>
  /** Bereich des Clips im Editor; `null` = ungekürzt (Player verhält sich normal). */
  range: Ref<ListRange | null>
  fps: Ref<number>
  /** Spult das Video (und hält den Cursor im Store synchron). */
  seek: (sec: number) => void
  /** Solange `true` (z. B. Auswahl-Vorschau läuft), greift diese Logik nicht ein. */
  suspended: () => boolean
}

/**
 * Der Editor-Player berücksichtigt Von/Bis aus der Liste „Meine Videos":
 * „Abspielen" beginnt bei Von (wenn die Position außerhalb des Bereichs liegt)
 * und hält am letzten Bild vor Bis an. Spulen/Schneiden bleibt frei, die
 * Auswahl-Vorschau („Auswahl abspielen") hat Vorrang.
 */
export function useListRangePlayback(opts: ListRangePlaybackOptions) {
  const { video, range, fps, seek, suspended } = opts
  let raf = 0

  function cancelTick(): void {
    if (raf) cancelAnimationFrame(raf)
    raf = 0
  }

  function tick(): void {
    raf = 0
    const el = video.value
    const r = range.value
    if (!el || el.paused || !r) return
    if (!suspended() && reachedRangeEnd(el.currentTime, r, fps.value)) {
      el.pause()
      seek(lastFrameSeekTime(r.from, r.to, fps.value))
      return
    }
    raf = requestAnimationFrame(tick)
  }

  function onPlay(): void {
    const el = video.value
    const r = range.value
    cancelTick()
    if (!el || !r) return
    if (!suspended()) {
      const target = playJumpTarget(el.currentTime, r, fps.value)
      if (target !== null) seek(target)
    }
    raf = requestAnimationFrame(tick)
  }

  /** Bereich geändert oder Clip geladen: (pausiert) das erste Bild des Bereichs zeigen. */
  function showStart(): void {
    const el = video.value
    const r = range.value
    if (!el || !r || !el.paused || suspended()) return
    seek(frameSeekTime(r.from, fps.value))
  }

  watch(
    video,
    (el, old) => {
      old?.removeEventListener('play', onPlay)
      el?.addEventListener('play', onPlay)
      if (!el) cancelTick()
    },
    { immediate: true },
  )

  // Von in der Liste geändert -> neues Startbild zeigen.
  watch(
    () => range.value?.from,
    (from, old) => {
      if (from !== undefined && from !== old) showStart()
    },
  )

  onBeforeUnmount(() => {
    cancelTick()
    video.value?.removeEventListener('play', onPlay)
  })

  return { showStart }
}
