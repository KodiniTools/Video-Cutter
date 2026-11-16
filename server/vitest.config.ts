import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
    root: __dirname,
    // Tests arbeiten ohne Verzeichnis auf der Platte (wie bisher: nur im Arbeitsspeicher).
    env: { MEDIA_INDEX_FILE: '' },
  },
})
