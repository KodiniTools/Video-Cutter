/// <reference types="vitest/config" />
import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

// COOP/COEP aktivieren "cross-origin isolation" – nötig für multi-thread
// FFmpeg-Cores und generell empfohlen für FFmpeg.wasm.
const crossOriginIsolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

export default defineConfig({
  // Für Deployment in ein Unterverzeichnis anpassen, z. B. '/videoschneiden/'.
  base: process.env.VITE_BASE ?? '/',
  plugins: [vue()],
  // @ffmpeg/ffmpeg erzeugt seinen Worker per `new Worker(url, { type: 'module' })`.
  // Ohne dies bündelt Vite den Worker als IIFE (klassisch) -> Mismatch, der Worker
  // startet nicht sauber und `load()` bleibt hängen. 'es' baut ihn als ES-Modul.
  worker: { format: 'es' },
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    headers: crossOriginIsolation,
    // /api im Dev auf das lokale Backend weiterleiten (SSE-fähig).
    proxy: {
      '/api': {
        target: process.env.VITE_DEV_API ?? 'http://localhost:4021',
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
