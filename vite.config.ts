/// <reference types="vitest/config" />
import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'
import { readFileSync } from 'node:fs'
import type { Plugin } from 'vite'

// Titel/Meta-Beschreibung aus src/content/site.json (Kodini Designer) in die
// index.html schreiben – leer = Standard aus der index.html.
function siteMetaPlugin(): Plugin {
  return {
    name: 'kodini-site-meta',
    transformIndexHtml(html) {
      let meta: { title?: string; description?: string } = {}
      try {
        meta =
          JSON.parse(readFileSync(new URL('./src/content/site.json', import.meta.url), 'utf8'))
            .meta ?? {}
      } catch {
        return html
      }
      const esc = (s: string) =>
        s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
      let out = html
      if (meta.title && meta.title.trim())
        out = out.replace(/<title>[^<]*<\/title>/, `<title>${esc(meta.title.trim())}</title>`)
      if (meta.description && meta.description.trim())
        out = out.replace(
          /(<meta name="description" content=")[^"]*(")/,
          `$1${esc(meta.description.trim())}$2`,
        )
      return out
    },
  }
}

// COOP/COEP aktivieren "cross-origin isolation" – nötig für multi-thread
// FFmpeg-Cores und generell empfohlen für FFmpeg.wasm.
const crossOriginIsolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

export default defineConfig({
  // Für Deployment in ein Unterverzeichnis anpassen, z. B. '/videoschneiden/'.
  base: process.env.VITE_BASE ?? '/',
  // Ausgabeordner überschreibbar (Vorschau-Build des Kodini Designers).
  build: { outDir: process.env.VITE_OUT_DIR ?? 'dist', emptyOutDir: true },
  plugins: [vue(), siteMetaPlugin()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    headers: crossOriginIsolation,
    // /api im Dev auf das lokale Backend weiterleiten (SSE-fähig).
    proxy: {
      '/api': {
        target: process.env.VITE_DEV_API ?? 'http://localhost:9015',
        changeOrigin: true,
      },
    },
  },
  preview: { headers: crossOriginIsolation },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['tests/**/*.spec.ts'],
  },
})
