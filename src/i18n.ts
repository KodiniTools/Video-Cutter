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
    segments: {
      title: 'Ausschnitte',
      add: 'Ausschnitt hinzufügen',
      remove: 'Ausschnitt entfernen',
      empty: 'Noch keine Ausschnitte. Ohne Liste wird die aktuelle Auswahl verwendet.',
      hint: 'Video abspielen und mit ⏱ Start bzw. Ende auf die Wiedergabeposition setzen, dann hinzufügen.',
    },
    operation: {
      legend: 'Aktion',
      keep: 'Ausschnitte behalten',
      keepHint: 'Behält die gewählten Ausschnitte und fügt sie zusammen.',
      remove: 'Ausschnitte entfernen',
      removeHint: 'Entfernt die gewählten Ausschnitte, fügt den Rest zusammen.',
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
      undo: 'Rückgängig',
      redo: 'Wiederherstellen',
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
    segments: {
      title: 'Segments',
      add: 'Add segment',
      remove: 'Remove segment',
      empty: 'No segments yet. Without a list the current selection is used.',
      hint: 'Play the video and use ⏱ to set start or end to the playback position, then add.',
    },
    operation: {
      legend: 'Action',
      keep: 'Keep segments',
      keepHint: 'Keeps the selected segments and joins them together.',
      remove: 'Remove segments',
      removeHint: 'Removes the selected segments, joins the rest together.',
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
      undo: 'Undo',
      redo: 'Redo',
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
