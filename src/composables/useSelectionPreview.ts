import { onBeforeUnmount, ref, watch, type Ref } from 'vue'
import { frameSeekTime, lastFrameSeekTime } from '@/lib/frameTime'

/** So viele Sekunden vor dem Ende startet die Vorschau nach dem Verschieben des Ende-Reglers. */
export const END_PREVIEW_LEAD = 2

/** Halbes Bild Vorlauf, damit am Ende nicht schon das erste Bild NACH der Auswahl aufblitzt. */
function endTolerance(fps: number): number {
  return Number.isFinite(fps) && fps > 0 ? 0.5 / fps : 0.005
}

/**
 * Entscheidet für die laufende Auswahl-Vorschau, was bei Wiedergabezeit `t` passiert.
 * Reine Funktion (testbar): 'play' = weiterlaufen, 'loop' = zurück zum Anfang,
 * 'stop' = am letzten Bild anhalten.
 */
export function previewAction(
  t: number,
  end: number,
  loop: boolean,
  fps: number,
): 'play' | 'loop' | 'stop' {
  if (t < end - endTolerance(fps)) return 'play'
  return loop ? 'loop' : 'stop'
}

/** Ab wo die Vorschau nach dem Verschieben eines Reglers weiterläuft. */
export function restartTime(
  target: 'start' | 'end',
  start: number,
  end: number,
  fps: number,
): number {
  const from = target === 'start' ? start : Math.max(start, end - END_PREVIEW_LEAD)
  return frameSeekTime(from, fps)
}

export interface SelectionPreviewOptions {
  video: Ref<HTMLVideoElement | null>
  start: Ref<number>
  end: Ref<number>
  fps: Ref<number>
  /** Spult das Video (und hält den Cursor im Store synchron). */
  seek: (sec: number) => void
}

/**
 * „Auswahl abspielen": spielt nur den Bereich Anfang–Ende im vorhandenen
 * Video-Element (Overlays bleiben sichtbar, kein Server-Encode). Stoppt am
 * letzten Bild oder springt im Schleifenmodus zurück zum Anfang. Wird ein
 * Regler gezogen, hält die Vorschau an (der Regler zeigt sein Bild live) und
 * läuft nach dem Loslassen mit dem neuen Bereich weiter.
 *
 * Jede Pause von außen (Player-Steuerung, Bild-Spinner …) beendet die Vorschau.
 */
export function useSelectionPreview(opts: SelectionPreviewOptions) {
  const { video, start, end, fps, seek } = opts
  /** Vorschau läuft (oder ist nur fürs Reglerziehen angehalten). */
  const active = ref(false)
  /** Bereich in Schleife wiederholen statt am Ende anzuhalten. */
  const loop = ref(false)

  let raf = 0
  /** Eigene pause()-Aufrufe sollen die Vorschau nicht beenden. */
  let internalPause = false
  /** Beim Reglerziehen angehalten -> nach dem Loslassen weiterspielen. */
  let resumeAfterDrag = false

  function cancelTick(): void {
    if (raf) cancelAnimationFrame(raf)
    raf = 0
  }

  function pauseInternally(el: HTMLVideoElement): void {
    if (el.paused) return
    internalPause = true
    el.pause()
  }

  function tick(): void {
    raf = 0
    const el = video.value
    if (!active.value || !el || el.paused) return
    switch (previewAction(el.currentTime, end.value, loop.value, fps.value)) {
      case 'play':
        break
      case 'loop':
        seek(frameSeekTime(start.value, fps.value))
        break
      case 'stop':
        pauseInternally(el)
        seek(lastFrameSeekTime(start.value, end.value, fps.value))
        active.value = false
        return
    }
    raf = requestAnimationFrame(tick)
  }

  function startTick(): void {
    cancelTick()
    raf = requestAnimationFrame(tick)
  }

  function playFrom(sec: number): void {
    const el = video.value
    if (!el || !(end.value > start.value)) return
    resumeAfterDrag = false
    active.value = true
    seek(sec)
    // play() kann abgelehnt werden (z. B. Quelle noch nicht geladen) -> Vorschau aus.
    el.play().then(startTick, () => {
      active.value = false
    })
  }

  function play(): void {
    playFrom(frameSeekTime(start.value, fps.value))
  }

  function stop(): void {
    resumeAfterDrag = false
    cancelTick()
    const el = video.value
    if (el) pauseInternally(el)
    active.value = false
  }

  function toggle(): void {
    if (active.value) stop()
    else play()
  }

  /** Regler wird gegriffen: Vorschau anhalten, damit das Ziehen das Bild live zeigt. */
  function holdForEdit(): void {
    const el = video.value
    if (!active.value || !el || el.paused) return
    resumeAfterDrag = true
    cancelTick()
    pauseInternally(el)
  }

  /**
   * Bereich wurde geändert (Regler losgelassen, Pfeiltaste, Zeitfeld): lief die
   * Vorschau, mit dem neuen Bereich weiterspielen – nach Anfang-Änderung ab dem
   * Anfang, nach Ende-Änderung kurz vor dem Ende.
   */
  function rangeEdited(target: 'start' | 'end'): void {
    const el = video.value
    const running = active.value && !!el && !el.paused
    if (!resumeAfterDrag && !running) return
    playFrom(restartTime(target, start.value, end.value, fps.value))
  }

  function onPause(): void {
    if (internalPause) {
      internalPause = false
      return
    }
    // Pause von außen (Player-Knopf, Spinner, Ende des Videos) beendet die Vorschau.
    resumeAfterDrag = false
    cancelTick()
    active.value = false
  }

  watch(
    video,
    (el, old) => {
      old?.removeEventListener('pause', onPause)
      el?.addEventListener('pause', onPause)
      if (!el) stop()
    },
    { immediate: true },
  )

  onBeforeUnmount(() => {
    cancelTick()
    video.value?.removeEventListener('pause', onPause)
  })

  return { active, loop, play, stop, toggle, holdForEdit, rangeEdited }
}
