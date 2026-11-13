import { describe, it, expect } from 'vitest'
import { topOffset } from '@/composables/useSiteNavOffset'

describe('topOffset (Höhe der fixierten Website-Navigation)', () => {
  it('nimmt die Unterkante fixierter/sticky Elemente am oberen Rand', () => {
    expect(
      topOffset(
        [
          { position: 'fixed', top: 0, bottom: 70 },
          { position: 'sticky', top: 0, bottom: 64.4 },
        ],
        900,
      ),
    ).toBe(70)
  })

  it('ignoriert statische, weggescrollte, untere und riesige Elemente', () => {
    expect(
      topOffset(
        [
          { position: 'static', top: 0, bottom: 70 },
          { position: 'fixed', top: -80, bottom: -10 }, // ausgeblendete Navigation
          { position: 'fixed', top: 800, bottom: 900 }, // Cookie-Banner unten
          { position: 'fixed', top: 0, bottom: 900 }, // offenes Mobil-Menü
        ],
        900,
      ),
    ).toBe(0)
  })
})
