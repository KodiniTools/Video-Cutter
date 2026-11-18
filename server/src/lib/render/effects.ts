import { MICROS_PER_SECOND, type DocMarkerEffect } from './doc'

/**
 * Drop-Effekte an Markern (nach Muster des Beat-Drops im Visualizer):
 * Blitz, Farbblitz, Stroboskop und Vignetten-Puls. Alles wird mit `drawbox`
 * über das fertige Bild gelegt; der Verlauf (Abklingen, Pulsieren) entsteht
 * aus kurzen Stufen, je Stufe ein `drawbox` mit eigener Deckkraft, das nur in
 * seinem Zeitfenster aktiv ist. Das ist billig (außerhalb des Fensters tut der
 * Filter nichts) und braucht keine Ausdrücke je Pixel.
 *
 * Die Zeiten sind die der ganzen Timeline (`t`); der Aufrufer verschiebt das
 * Bild dafür auf diese Zeiten, damit Effekte über Abschnittsgrenzen der
 * Vorschau hinweg nahtlos weiterlaufen.
 */

/** Höchstens so viele Stufen je Effekt (darüber sieht man keinen Unterschied). */
export const MAX_EFFECT_STEPS = 24
/** Ringe des Vignetten-Pulses (außen kräftig, nach innen schwächer). */
export const VIGNETTE_RINGS = 8
/** Breite des Vignetten-Rands als Anteil der kürzeren Bildseite. */
const VIGNETTE_DEPTH = 0.3

const num = (v: number): string => String(Number(v.toFixed(6)))

/** Hüllkurve je Art über dem Anteil `u` (0…1) der Effektdauer. */
export function effectEnvelope(kind: DocMarkerEffect['kind'], u: number): number {
  switch (kind) {
    case 'flash':
      return (1 - u) ** 2
    case 'burst':
      return u < 0.2 ? u / 0.2 : (1 - u) / 0.8
    case 'vignette':
      return Math.sin(Math.PI * u)
    case 'strobe':
      return 1
  }
}

/**
 * Filter (durch Komma zu verketten) für alle Effekte, die den Abschnitt
 * `[t0, t1)` (Sekunden) berühren. `frameSec` ist die Dauer eines Bildes; mehr
 * Stufen als Bilder bringen nichts.
 */
export function markerEffectFilters(
  effects: readonly DocMarkerEffect[],
  opts: { t0: number; t1: number; frameSec: number; width: number; height: number },
): string[] {
  const out: string[] = []
  for (const e of effects) {
    const a = e.at / MICROS_PER_SECOND
    const d = e.duration / MICROS_PER_SECOND
    const b = a + d
    if (b <= opts.t0 || a >= opts.t1) continue
    const color = `0x${e.color.slice(1)}`
    if (e.kind === 'strobe') {
      const period = 1 / e.rate
      out.push(
        `drawbox=x=0:y=0:w=iw:h=ih:t=fill:color=${color}@${num(e.intensity)}` +
          `:enable='gte(t,${num(a)})*lt(t,${num(b)})*lt(mod(t-${num(a)},${num(period)}),${num(period / 2)})'`,
      )
      continue
    }
    const steps = Math.max(1, Math.min(MAX_EFFECT_STEPS, Math.ceil(d / opts.frameSec)))
    const ring = Math.max(
      1,
      Math.round((Math.min(opts.width, opts.height) * VIGNETTE_DEPTH) / VIGNETTE_RINGS),
    )
    for (let k = 0; k < steps; k++) {
      const from = a + (d * k) / steps
      const to = a + (d * (k + 1)) / steps
      if (to <= opts.t0 || from >= opts.t1) continue
      const level = e.intensity * effectEnvelope(e.kind, (k + 0.5) / steps)
      const enable = `:enable='gte(t,${num(from)})*lt(t,${num(to)})'`
      if (e.kind !== 'vignette') {
        if (level >= 0.01)
          out.push(`drawbox=x=0:y=0:w=iw:h=ih:t=fill:color=${color}@${num(level)}${enable}`)
        continue
      }
      for (let j = 0; j < VIGNETTE_RINGS; j++) {
        const alpha = level * (1 - j / VIGNETTE_RINGS) ** 2
        if (alpha < 0.01) continue
        const inset = j * ring
        out.push(
          `drawbox=x=${inset}:y=${inset}:w=iw-${2 * inset}:h=ih-${2 * inset}:t=${ring}` +
            `:color=${color}@${num(alpha)}${enable}`,
        )
      }
    }
  }
  return out
}
