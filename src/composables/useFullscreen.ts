import { onBeforeUnmount, onMounted, ref, type Ref } from 'vue'

/**
 * Vollbild über die Fullscreen-API des Browsers für ein Element der App.
 *
 * Bewusst ein Element INNERHALB von #app (nicht <html>): Die fixierte
 * Website-Navigation und der Seiten-Footer liegen außerhalb und verschwinden
 * im Vollbild. Alles, was die App selbst zeigt (Dialoge per showModal, native
 * Auswahllisten, Tastenkürzel am window), funktioniert im Vollbild weiter.
 * Safari (ältere Versionen) kennt nur die webkit-Präfixe.
 */

type FsDocument = Document & {
  webkitFullscreenElement?: Element | null
  webkitFullscreenEnabled?: boolean
  webkitExitFullscreen?: () => Promise<void> | void
}
type FsElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void
}

function fsDoc(): FsDocument {
  return document as FsDocument
}

/** Element, das gerade im Vollbild ist (oder null). */
export function fullscreenElement(): Element | null {
  const d = fsDoc()
  return d.fullscreenElement ?? d.webkitFullscreenElement ?? null
}

/** Kann der Browser Elemente in den Vollbildmodus schalten? */
export function fullscreenSupported(): boolean {
  if (typeof document === 'undefined') return false
  const d = fsDoc()
  const el = document.documentElement as FsElement
  const enabled = d.fullscreenEnabled ?? d.webkitFullscreenEnabled ?? false
  return (
    enabled &&
    (typeof el.requestFullscreen === 'function' || typeof el.webkitRequestFullscreen === 'function')
  )
}

export function useFullscreen(target: Ref<HTMLElement | null>): {
  supported: Ref<boolean>
  active: Ref<boolean>
  toggle: () => Promise<void>
} {
  const supported = ref(false)
  const active = ref(false)

  const sync = () => {
    active.value = target.value !== null && fullscreenElement() === target.value
  }

  async function enter(): Promise<void> {
    const el = target.value as FsElement | null
    if (!el) return
    if (typeof el.requestFullscreen === 'function') await el.requestFullscreen()
    else await el.webkitRequestFullscreen?.()
  }

  async function exit(): Promise<void> {
    const d = fsDoc()
    if (typeof d.exitFullscreen === 'function') await d.exitFullscreen()
    else await d.webkitExitFullscreen?.()
  }

  /** Schaltet um. Lehnt der Browser ab (z. B. Rechte-Richtlinie), bleibt alles wie es ist. */
  async function toggle(): Promise<void> {
    try {
      if (fullscreenElement()) await exit()
      else await enter()
    } catch (err) {
      console.warn('[fullscreen] Umschalten nicht möglich:', err)
    } finally {
      sync()
    }
  }

  onMounted(() => {
    supported.value = fullscreenSupported()
    document.addEventListener('fullscreenchange', sync)
    document.addEventListener('webkitfullscreenchange', sync)
    sync()
  })
  onBeforeUnmount(() => {
    document.removeEventListener('fullscreenchange', sync)
    document.removeEventListener('webkitfullscreenchange', sync)
  })

  return { supported, active, toggle }
}
