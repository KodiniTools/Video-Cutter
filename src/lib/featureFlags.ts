/**
 * Schalter für Funktionen in Arbeit (nur Frontend).
 *
 * Neuer Timeline-Editor: aus, solange er nicht ausdrücklich freigeschaltet ist –
 * per Build-Variable `VITE_TIMELINE_EDITOR=1` oder im Browser über
 * `localStorage.setItem('videoCutter.timelineEditor', '1')`.
 */
export const TIMELINE_EDITOR_KEY = 'videoCutter.timelineEditor'

export function isTimelineEditorEnabled(): boolean {
  if (import.meta.env.VITE_TIMELINE_EDITOR === '1') return true
  try {
    return localStorage.getItem(TIMELINE_EDITOR_KEY) === '1'
  } catch {
    // localStorage gesperrt (z. B. privater Modus): Schalter bleibt aus.
    return false
  }
}

/**
 * Schaltet den neuen Editor in diesem Browser frei (Schalter in der Kopfzeile).
 * Liefert `false`, wenn der Speicher gesperrt ist – dann bleibt `/editor` zu.
 */
export function enableTimelineEditor(): boolean {
  try {
    localStorage.setItem(TIMELINE_EDITOR_KEY, '1')
  } catch {
    // gesperrter Speicher: unten entscheidet der tatsächliche Stand
  }
  return isTimelineEditorEnabled()
}
