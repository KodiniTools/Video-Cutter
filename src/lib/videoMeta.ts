/**
 * Liest die Dauer einer Videodatei über ein unsichtbares <video>-Element.
 * Liefert 0, wenn der Browser das Format nicht lesen kann oder das Zeitlimit
 * abläuft – die Dauer dient nur der Anzeige, das Backend ermittelt sie selbst.
 */
export function readVideoDuration(file: File, timeoutMs = 10_000): Promise<number> {
  return new Promise((resolve) => {
    if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') {
      resolve(0)
      return
    }
    const url = URL.createObjectURL(file)
    const el = document.createElement('video')
    let done = false
    const finish = (d: number) => {
      if (done) return
      done = true
      clearTimeout(timer)
      el.removeAttribute('src')
      el.load()
      URL.revokeObjectURL(url)
      resolve(Number.isFinite(d) && d > 0 ? d : 0)
    }
    const timer = setTimeout(() => finish(0), timeoutMs)
    el.preload = 'metadata'
    el.muted = true
    el.onloadedmetadata = () => finish(el.duration)
    el.onerror = () => finish(0)
    el.src = url
  })
}
