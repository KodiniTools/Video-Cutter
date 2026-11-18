import { describe, expect, it } from 'vitest'
import { buildRenderArgs, compileTimeline } from '../src/lib/render/compile'
import { parseTimelineDoc, type RenderDoc } from '../src/lib/render/doc'
import { checkLossless } from '../src/lib/render/lossless'
import { graphicFilter } from '../src/lib/graphicOverlay'
import {
  buildAssLines,
  parseTextOverlays,
  splitAnimation,
  type TextOverlay,
} from '../src/lib/textOverlay'
import { SERVER_FEATURES } from '../src/routes/cut'
import { ValidationError } from '../src/lib/validate'

const s = (seconds: number) => Math.round(seconds * 1_000_000)

const text = {
  text: 'Hallo',
  start: 1,
  end: 4,
  x: 0.5,
  y: 0.5,
  font: 'roboto',
  size: 0.06,
  color: '#ffffff',
  style: 'outline',
  accent: '#000000',
  animation: 'fadeIn',
}
const overlay = (o: Record<string, unknown> = {}): TextOverlay =>
  parseTextOverlays([{ ...text, ...o }], 10)[0]

describe('Ausblenden als eigene Animation: Prüfung', () => {
  it('meldet die Funktionen', () => {
    expect(SERVER_FEATURES).toContain('timelineAnimOut')
    expect(SERVER_FEATURES).toContain('timelineClipFadeOut')
  })

  it('fehlt animOut, bleibt alles wie bisher', () => {
    const o = overlay()
    expect(o).not.toHaveProperty('animOut')
    expect(splitAnimation(o)).toEqual({ out: 'none', outSpeed: 1, legacy: true })
    expect(splitAnimation(overlay({ animation: 'slide', animSpeed: 2 }))).toEqual({
      out: 'fade',
      outSpeed: 2,
      legacy: true,
    })
  })

  it('liest animOut mit eigenem Tempo und lehnt Unsinn ab', () => {
    expect(overlay({ animOut: 'zoom', animOutSpeed: 0.5 })).toMatchObject({
      animOut: 'zoom',
      animOutSpeed: 0.5,
    })
    expect(overlay({ animOut: 'fade' }).animOutSpeed).toBe(1)
    expect(() => overlay({ animOut: 'wirbel' })).toThrow(ValidationError)
  })
})

describe('Texte: Ein- und Ausblenden getrennt (ASS)', () => {
  it('Ausblenden mit eigenem Tempo in einer Zeile', () => {
    const [line, ...rest] = buildAssLines(
      overlay({ animSpeed: 2, animOut: 'fade', animOutSpeed: 0.5 }),
      640,
      360,
    )
    expect(rest).toEqual([])
    // Einblenden 400/2 ms, Ausblenden 400/0,5 ms.
    expect(line).toContain('\\fad(200,800)')
  })

  it('„Ohne“ schaltet das bisherige Mit-Ausblenden ab', () => {
    const legacy = buildAssLines(overlay({ animation: 'slide' }), 640, 360)[0]
    expect(legacy).toContain('\\fad(500,400)')
    const off = buildAssLines(overlay({ animation: 'slide', animOut: 'none' }), 640, 360)
    expect(off).toHaveLength(1)
    expect(off[0]).toContain('\\fad(500,0)')
  })

  it('Hinausgleiten: zweite Zeile schließt lückenlos an und bewegt sich zum Rand', () => {
    const lines = buildAssLines(overlay({ animation: 'slide', animOut: 'slideRight' }), 640, 360)
    expect(lines).toHaveLength(2)
    const times = lines.map((l) => l.split(',').slice(1, 3))
    expect(times[0][0]).toBe('0:00:00.99')
    expect(times[0][1]).toBe(times[1][0])
    expect(times[1][0]).toBe('0:00:03.49')
    expect(times[1][1]).toBe('0:00:03.99')
    // Erste Zeile: nur hereingleiten, kein Ausblenden.
    expect(lines[0]).toContain('\\move(320,202,320,180,0,500)\\fad(500,0)')
    // Zweite Zeile: 22 px (6 % der Höhe) nach rechts, dabei ausblenden.
    expect(lines[1]).toContain('\\move(320,180,342,180,0,500)\\fad(0,500)')
  })

  it('Wegzoomen und Wegploppen skalieren in der zweiten Zeile', () => {
    const zoom = buildAssLines(overlay({ animOut: 'zoom' }), 640, 360)
    expect(zoom).toHaveLength(2)
    expect(zoom[1]).toMatch(/\\fad\(0,250\)\\t\(\d+,\d+,\\fscx160\\fscy160\)/)
    const pop = buildAssLines(overlay({ animOut: 'pop' }), 640, 360)
    expect(pop[1]).toContain('\\fscx112\\fscy112')
    expect(pop[1]).toContain('\\fscx40\\fscy40')
  })
})

describe('Grafiken: Ein- und Ausblenden getrennt (FFmpeg)', () => {
  const g = {
    width: 40,
    height: 20,
    x: 0.5,
    y: 0.5,
    start: 1,
    end: 4,
    animation: 'fadeIn' as const,
    loop: 'none' as const,
    animSpeed: 1,
  }
  const filter = (o: Record<string, unknown>) =>
    graphicFilter({ ...g, ...o } as never, 1, '[0:v]', '[v1]', 640, 360)

  it('ohne animOut unverändert: nur einblenden', () => {
    const f = filter({})
    expect(f).toContain('fade=t=in:st=1:d=0.4:alpha=1')
    expect(f).not.toContain('fade=t=out')
  })

  it('Ausblenden mit eigenem Tempo', () => {
    const f = filter({ animSpeed: 2, animOut: 'fade', animOutSpeed: 0.5 })
    expect(f).toContain('fade=t=in:st=1:d=0.2:alpha=1')
    expect(f).toContain('fade=t=out:st=3.2:d=0.8:alpha=1')
  })

  it('„Ohne“ schaltet das Ausblenden einer bisherigen Animation ab', () => {
    expect(filter({ animation: 'fade' })).toContain('fade=t=out')
    expect(filter({ animation: 'fade', animOut: 'none' })).not.toContain('fade=t=out')
  })

  it('Hinausgleiten bewegt in den letzten 0,5 s und blendet aus', () => {
    const f = filter({ animOut: 'slideLeft' })
    expect(f).toContain('fade=t=out:st=3.5:d=0.5:alpha=1')
    expect(f).toContain("x='300-22*min(1,max(0,(t-3.5)/0.5))'")
  })

  it('Wegzoomen skaliert am Ende', () => {
    const f = filter({ animOut: 'zoom' })
    expect(f).toContain('fade=t=out:st=3.75:d=0.25:alpha=1')
    expect(f).toContain('(1+0.6*min(1,max(0,(t-3.5)/0.5)))')
  })
})

describe('Video-Clip: Ausblenden am Ende', () => {
  const raw = (fadeOut?: unknown, extra: Record<string, unknown> = {}) => ({
    version: 2,
    settings: { width: 640, height: 360, fps: 25, background: '#00ff00', sampleRate: 48000 },
    assets: {
      a: { id: 'a', kind: 'video', duration: s(4) },
      b: { id: 'b', kind: 'video', duration: s(4) },
    },
    tracks: [
      {
        id: 'V1',
        kind: 'video',
        hidden: false,
        clips: [
          {
            id: 'v1',
            kind: 'video',
            asset: 'a',
            start: 0,
            duration: s(2),
            sourceIn: 0,
            speed: 1,
            ...(fadeOut === undefined ? {} : { fadeOut }),
            ...extra,
          },
          {
            id: 'v2',
            kind: 'video',
            asset: 'b',
            start: s(3),
            duration: s(2),
            sourceIn: 0,
            speed: 1,
          },
        ],
      },
    ],
  })
  const parsed = (r: unknown): RenderDoc => {
    const p = parseTimelineDoc(r)
    if (!p.ok) throw new Error(JSON.stringify(p.errors))
    return p.doc
  }
  const sources = {
    a: { path: '/m/a.mp4', hasAudio: false },
    b: { path: '/m/b.mp4', hasAudio: false },
  }

  it('prüft die Angabe', () => {
    const clip = parsed(raw({ duration: s(1), mehr: 1 })).tracks[0].clips[0]
    expect(clip).toMatchObject({ fadeOut: { duration: s(1) } })
    expect(parsed(raw(null)).tracks[0].clips[0]).not.toHaveProperty('fadeOut')
    expect(parseTimelineDoc(raw({ duration: 5 })).ok).toBe(false)
    expect(parseTimelineDoc(raw('ja')).ok).toBe(false)
  })

  it('blendet das Bild in den letzten Bildern aus, sonst bleibt die Kette gleich', () => {
    const plain = compileTimeline(parsed(raw()), { sources })
    const faded = compileTimeline(parsed(raw({ duration: s(1) })), { sources })
    expect(plain.filter).not.toContain('fade=t=out')
    // 2 s Clip, 1 s Ausblenden: beginnt bei 1 s, in die Hintergrundfarbe.
    expect(faded.filter).toContain('fade=t=out:st=1.000000:d=1.000000:color=0x00ff00')
    expect(buildRenderArgs(faded, { output: '/tmp/x.mp4' }).length).toBeGreaterThan(0)
  })

  it('über Abschnittsgrenzen: nur der Abschnitt mit dem Clip-Ende blendet', () => {
    const doc = parsed(raw({ duration: s(0.4) }))
    const first = compileTimeline(doc, { sources, range: { start: 0, end: s(1) } })
    const second = compileTimeline(doc, { sources, range: { start: s(1), end: s(2) } })
    expect(first.filter).not.toContain('fade=t=out')
    expect(second.filter).toContain('fade=t=out:st=1.600000:d=0.400000')
  })

  it('ein ausgeblendeter Clip hält kein Standbild in der Lücke', () => {
    const held = compileTimeline(parsed(raw(undefined, { hold: true })), { sources })
    const both = compileTimeline(parsed(raw({ duration: s(1) }, { hold: true })), { sources })
    expect(held.filter).toContain('reverse')
    expect(both.filter).not.toContain('reverse')
  })

  it('verlustfrei geht damit nicht', () => {
    const r = checkLossless(parsed(raw({ duration: s(1) })), {
      a: { codec: 'h264', width: 640, height: 360 } as never,
      b: { codec: 'h264', width: 640, height: 360 } as never,
    } as never)
    expect(r.ok).toBe(false)
  })
})
