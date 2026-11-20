/**
 * Projektformate für die Formatauswahl des Timeline-Editors.
 *
 * Jede Bildgröße steht genau einmal in der Liste (der Wert der Auswahl ist
 * „BreitexHöhe“, gespeichert wird weiter nur width/height). Mehrere
 * Plattformen mit gleicher Größe teilen sich deshalb einen Eintrag.
 * Alle Maße sind gerade und ≤ 3840 px, wie der Server sie verlangt.
 */

export type FormatGroup = 'portrait' | 'square' | 'landscape'

export interface FormatPreset {
  width: number
  height: number
  /** Seitenverhältnis zur Anzeige, z. B. „9:16“. */
  ratio: string
  /** Plattformen/Verwendungen, die diese Größe nutzen. */
  names: readonly string[]
  group: FormatGroup
}

export const FORMAT_PRESETS: readonly FormatPreset[] = [
  // Hochformat
  {
    width: 1080,
    height: 1920,
    ratio: '9:16',
    names: [
      'Instagram Reel / Story',
      'TikTok',
      'YouTube Shorts',
      'Facebook Reel / Story',
      'Snapchat',
    ],
    group: 'portrait',
  },
  {
    width: 1080,
    height: 1350,
    ratio: '4:5',
    names: ['Instagram Portrait', 'Facebook Feed', 'LinkedIn Portrait'],
    group: 'portrait',
  },
  { width: 1080, height: 1440, ratio: '3:4', names: ['Instagram Grid Post'], group: 'portrait' },
  { width: 1000, height: 1500, ratio: '2:3', names: ['Pinterest Pin'], group: 'portrait' },
  // Quadratisch
  {
    width: 1080,
    height: 1080,
    ratio: '1:1',
    names: ['Instagram Post', 'Facebook Post', 'LinkedIn', 'X (Twitter)'],
    group: 'square',
  },
  // Querformat
  {
    width: 1920,
    height: 1080,
    ratio: '16:9',
    names: ['YouTube Full HD', 'Facebook', 'LinkedIn', 'X (Twitter)', 'Twitch'],
    group: 'landscape',
  },
  {
    width: 1280,
    height: 720,
    ratio: '16:9',
    names: ['YouTube HD 720p', 'X (Twitter)'],
    group: 'landscape',
  },
  { width: 2560, height: 1440, ratio: '16:9', names: ['YouTube 1440p'], group: 'landscape' },
  { width: 3840, height: 2160, ratio: '16:9', names: ['YouTube 4K'], group: 'landscape' },
  {
    width: 1200,
    height: 628,
    ratio: '1.91:1',
    names: ['Facebook / LinkedIn Ads'],
    group: 'landscape',
  },
]

export const FORMAT_GROUPS: readonly FormatGroup[] = ['portrait', 'square', 'landscape']

export const formatKey = (s: { width: number; height: number }): string => `${s.width}x${s.height}`

/** Anzeige: „Instagram Post · Facebook Post – 1080 × 1080 (1:1)“. */
export function formatLabel(p: FormatPreset): string {
  return `${p.names.join(' · ')} – ${p.width} × ${p.height} (${p.ratio})`
}

/** Kürzeste ganzzahlige Seitenverhältnis-Angabe, z. B. 1920×800 → „12:5“. */
export function ratioOf(width: number, height: number): string {
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b))
  const g = gcd(width, height) || 1
  return `${width / g}:${height / g}`
}

export function findPreset(s: { width: number; height: number }): FormatPreset | undefined {
  return FORMAT_PRESETS.find((p) => p.width === s.width && p.height === s.height)
}
