/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>
  export default component
}

interface ImportMetaEnv {
  /** Optional: eigene Basis-URL für ffmpeg-core (selbst gehostet). */
  readonly VITE_FFMPEG_CORE_URL?: string
  /** Optional: Base-Pfad beim Build für Unterverzeichnis-Deployment. */
  readonly VITE_BASE?: string
  /** Optional: Basis-URL des Backends, z. B. '/videoschneiden' (Produktion). */
  readonly VITE_API_BASE?: string
  /** Optional: Ziel des Dev-Proxys für /api (Standard http://localhost:4021). */
  readonly VITE_DEV_API?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
