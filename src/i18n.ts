import { createI18n } from 'vue-i18n'

const messages = {
  de: {
    app: {
      title: 'Video schneiden',
      subtitle: 'Videos schnell und einfach schneiden.',
    },
    drop: {
      title: 'Video hierher ziehen oder klicken',
      hint: 'MP4, WebM, MOV … Die Datei wird zum Schneiden auf den Server geladen.',
    },
    labels: { selection: 'Auswahl' },
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
      processing: 'Verarbeite …',
    },
    result: { ready: 'Fertig geschnitten:', iosHint: 'Auf iPhone/iPad: „Herunterladen“ → im Teilen-Dialog „In Dateien sichern“ oder „Video sichern“.' },
    errors: { notVideo: 'Bitte eine Videodatei auswählen.' },
    footer: 'Serverseitige Verarbeitung mit FFmpeg.',
  },
  en: {
    app: {
      title: 'Cut video',
      subtitle: 'Cut videos quickly and easily.',
    },
    drop: {
      title: 'Drop a video here or click',
      hint: 'MP4, WebM, MOV … The file is uploaded to the server for cutting.',
    },
    labels: { selection: 'Selection' },
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
      processing: 'Processing …',
    },
    result: { ready: 'Done:', iosHint: 'On iPhone/iPad: tap “Download” → in the share sheet choose “Save to Files” or “Save Video”.' },
    errors: { notVideo: 'Please choose a video file.' },
    footer: 'Server-side processing with FFmpeg.',
  },
} as const

export const i18n = createI18n({
  legacy: false,
  locale: 'de',
  fallbackLocale: 'en',
  messages,
})

export type AppLocale = 'de' | 'en'
