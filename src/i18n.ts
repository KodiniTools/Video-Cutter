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
    operation: {
      legend: 'Aktion',
      keep: 'Auswahl behalten',
      keepHint: 'Behält den markierten Bereich, schneidet Anfang und Ende weg.',
      remove: 'Auswahl entfernen',
      removeHint: 'Entfernt den markierten Bereich, fügt davor und danach zusammen.',
      removeNote: 'Beim Entfernen wird immer neu kodiert (H.264/AAC, .mp4).',
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
      uploading: 'Lädt hoch …',
      processing: 'Verarbeite …',
    },
    result: {
      ready: 'Fertig geschnitten:',
      iosHint:
        'Auf iPhone/iPad: „Herunterladen“ → im Teilen-Dialog „In Dateien sichern“ oder „Video sichern“.',
    },
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
    operation: {
      legend: 'Action',
      keep: 'Keep selection',
      keepHint: 'Keeps the marked range, trims off start and end.',
      remove: 'Remove selection',
      removeHint: 'Removes the marked range, joins the parts before and after.',
      removeNote: 'Removing always re-encodes (H.264/AAC, .mp4).',
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
      uploading: 'Uploading …',
      processing: 'Processing …',
    },
    result: {
      ready: 'Done:',
      iosHint:
        'On iPhone/iPad: tap “Download” → in the share sheet choose “Save to Files” or “Save Video”.',
    },
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
