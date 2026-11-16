import { describe, expect, it } from 'vitest'
import { assetFromMedia } from '@/timeline/assets'

const base = { id: 'm', name: 'x', size: 1, duration: 2.5, fps: 25, hasAudio: true }

describe('assetFromMedia', () => {
  it('Video mit Maßen und Bildrate', () => {
    expect(assetFromMedia({ ...base, width: 640, height: 360 })).toEqual({
      id: 'm',
      kind: 'video',
      name: 'x',
      duration: 2_500_000,
      width: 640,
      height: 360,
      fps: 25,
      hasAudio: true,
    })
  })

  it('Tondatei ohne Bildangaben', () => {
    expect(assetFromMedia({ ...base, width: 0, height: 0, fps: 0, kind: 'audio' })).toEqual({
      id: 'm',
      kind: 'audio',
      name: 'x',
      duration: 2_500_000,
      hasAudio: true,
    })
  })
})
