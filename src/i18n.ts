import { createI18n } from 'vue-i18n'

const messages = {
  de: {
    app: {
      title: 'Video schneiden',
      subtitle: 'Direkt im Browser – deine Datei verlässt dein Gerät nicht.',
    },
    drop: {
      title: 'Video hierher ziehen oder klicken',
      hint: 'MP4, WebM, MOV … Die Verarbeitung passiert lokal in deinem Browser.',
    },
    labels: { selection: 'Auswahl' },
    location: {
      legend: 'Verarbeitung',
      browser: 'Im Browser',
      server: 'Auf dem Server',
      browserHint: 'Lokal, kein Upload.',
      serverHint: 'Datei wird auf den Server geladen (DE-Server).',
    },
    actions: {
      change: 'Anderes Video',
      setStart: 'Start setzen',
      setEnd: 'Ende setzen',
      export: 'Schneiden & exportieren',
      download: 'Herunterladen',
    },
    mode: {
      legend: 'Schnittmodus',
      fast: 'Schnell (verlustfrei)',
      fastHint: 'Kopiert die Streams. Sehr schnell, schneidet an Keyframes.',
      accurate: 'Genau (neu kodieren)',
      accurateHint: 'Frame-genau via H.264/AAC. Langsamer, immer .mp4.',
    },
    status: {
      loadingEngine: 'Engine wird geladen …',
      processing: 'Verarbeite …',
    },
    result: { ready: 'Fertig geschnitten:', iosHint: 'Auf iPhone/iPad: „Herunterladen“ → im Teilen-Dialog „In Dateien sichern“ oder „Video sichern“.' },
    errors: { notVideo: 'Bitte eine Videodatei auswählen.' },
    footer: 'Client-seitige Verarbeitung mit FFmpeg (WebAssembly).',
  },
  en: {
    app: {
      title: 'Cut video',
      subtitle: 'Right in your browser – your file never leaves your device.',
    },
    drop: {
      title: 'Drop a video here or click',
      hint: 'MP4, WebM, MOV … Processing happens locally in your browser.',
    },
    labels: { selection: 'Selection' },
    location: {
      legend: 'Processing',
      browser: 'In browser',
      server: 'On server',
      browserHint: 'Local, no upload.',
      serverHint: 'File is uploaded to the server (DE server).',
    },
    actions: {
      change: 'Change video',
      setStart: 'Set start',
      setEnd: 'Set end',
      export: 'Cut & export',
      download: 'Download',
    },
    mode: {
      legend: 'Cut mode',
      fast: 'Fast (lossless)',
      fastHint: 'Copies the streams. Very fast, cuts at keyframes.',
      accurate: 'Accurate (re-encode)',
      accurateHint: 'Frame-accurate via H.264/AAC. Slower, always .mp4.',
    },
    status: {
      loadingEngine: 'Loading engine …',
      processing: 'Processing …',
    },
    result: { ready: 'Done:', iosHint: 'On iPhone/iPad: tap “Download” → in the share sheet choose “Save to Files” or “Save Video”.' },
    errors: { notVideo: 'Please choose a video file.' },
    footer: 'Client-side processing with FFmpeg (WebAssembly).',
  },
} as const

export const i18n = createI18n({
  legacy: false,
  locale: 'de',
  fallbackLocale: 'en',
  messages,
})

export type AppLocale = 'de' | 'en'
