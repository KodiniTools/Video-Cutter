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
    labels: { selection: 'Auswahl', start: 'Start', end: 'Ende' },
    operation: {
      legend: 'Aktion',
      keep: 'Auswahl behalten',
      keepHint: 'Behält den markierten Bereich, schneidet Anfang und Ende weg.',
      remove: 'Auswahl entfernen',
      removeHint: 'Entfernt den markierten Bereich, fügt davor und danach zusammen.',
      removeNote: 'Beim Entfernen wird neu kodiert. WebM bleibt WebM, sonst .mp4.',
    },
    actions: {
      change: 'Anderes Video',
      setStart: 'Start setzen',
      setEnd: 'Ende setzen',
      toPlayhead: 'Auf aktuelle Wiedergabeposition',
      increase: 'Eine Sekunde vor',
      decrease: 'Eine Sekunde zurück',
      export: 'Schneiden & exportieren',
      download: 'Herunterladen',
      discard: 'Verwerfen',
      cancel: 'Abbrechen',
    },
    mode: {
      legend: 'Schnittmodus',
      fast: 'Schnell (verlustfrei)',
      fastHint: 'Kopiert die Streams. Sehr schnell, schneidet an Keyframes.',
      accurate: 'Genau (neu kodieren)',
      accurateHint: 'Frame-genau, neu kodiert. Langsamer. WebM bleibt WebM, sonst .mp4.',
    },
    status: {
      uploading: 'Lädt hoch …',
      processing: 'Verarbeite …',
      remaining: 'noch',
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
    labels: { selection: 'Selection', start: 'Start', end: 'End' },
    operation: {
      legend: 'Action',
      keep: 'Keep selection',
      keepHint: 'Keeps the marked range, trims off start and end.',
      remove: 'Remove selection',
      removeHint: 'Removes the marked range, joins the parts before and after.',
      removeNote: 'Removing re-encodes. WebM stays WebM, otherwise .mp4.',
    },
    actions: {
      change: 'Change video',
      setStart: 'Set start',
      setEnd: 'Set end',
      toPlayhead: 'To current playback position',
      increase: 'One second forward',
      decrease: 'One second back',
      export: 'Cut & export',
      download: 'Download',
      discard: 'Discard',
      cancel: 'Cancel',
    },
    mode: {
      legend: 'Cut mode',
      fast: 'Fast (lossless)',
      fastHint: 'Copies the streams. Very fast, cuts at keyframes.',
      accurate: 'Accurate (re-encode)',
      accurateHint: 'Frame-accurate, re-encoded. Slower. WebM stays WebM, otherwise .mp4.',
    },
    status: {
      uploading: 'Uploading …',
      processing: 'Processing …',
      remaining: 'left',
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
