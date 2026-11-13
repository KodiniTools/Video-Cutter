import { onBeforeUnmount, onMounted } from 'vue'

/**
 * Höhe der oben fixierten Website-Navigation (SSI-Partial außerhalb von #app)
 * als CSS-Variable `--site-nav-offset` auf <html>. Damit kann der Editor
 * `position: sticky` direkt UNTER der Navigation kleben, statt von ihr
 * verdeckt zu werden. Ohne Partial (Vite-Dev) bleibt der Wert 0px.
 */

export interface TopBox {
  position: string
  top: number
  bottom: number
}

/**
 * Unterkante der Elemente, die oben am Fenster kleben (fixed/sticky, Oberkante
 * am Fensterrand). Elemente, die mehr als die Hälfte des Fensters bedecken
 * (z. B. ein geöffnetes Mobil-Menü), zählen nicht.
 */
export function topOffset(boxes: TopBox[], viewportHeight: number): number {
  let max = 0
  for (const b of boxes) {
    if (b.position !== 'fixed' && b.position !== 'sticky') continue
    if (b.top > 1 || b.bottom <= 0) continue
    if (b.bottom > viewportHeight / 2) continue
    max = Math.max(max, b.bottom)
  }
  return Math.round(max)
}

/** Kandidaten: Partials direkt im <body> und deren direkte Kinder (z. B. <header> in einem Wrapper). */
function candidates(): HTMLElement[] {
  const out: HTMLElement[] = []
  for (const el of Array.from(document.body.children)) {
    if (!(el instanceof HTMLElement) || el.id === 'app' || el.tagName === 'SCRIPT') continue
    out.push(el)
    for (const child of Array.from(el.children)) {
      if (child instanceof HTMLElement) out.push(child)
    }
  }
  return out
}

function measure(): number {
  const boxes = candidates().map((el) => {
    const r = el.getBoundingClientRect()
    return { position: getComputedStyle(el).position, top: r.top, bottom: r.bottom }
  })
  return topOffset(boxes, window.innerHeight)
}

export function useSiteNavOffset(): void {
  let frame = 0
  let last = -1
  let observer: ResizeObserver | null = null

  const update = () => {
    frame = 0
    const px = measure()
    if (px === last) return
    last = px
    document.documentElement.style.setProperty('--site-nav-offset', `${px}px`)
  }
  // Scrollen/Resize: höchstens einmal pro Frame messen (Navigation kann sich
  // beim Scrollen ein- oder ausblenden).
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(update)
  }

  onMounted(() => {
    update()
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, { passive: true })
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(schedule)
      for (const el of candidates()) observer.observe(el)
    }
  })

  onBeforeUnmount(() => {
    window.removeEventListener('resize', schedule)
    window.removeEventListener('scroll', schedule)
    observer?.disconnect()
    if (frame) cancelAnimationFrame(frame)
  })
}
