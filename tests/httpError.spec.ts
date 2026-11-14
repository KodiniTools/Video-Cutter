import { describe, it, expect, vi, afterEach } from 'vitest'
import { fallbackErrorMessage, parseRetryAfter, rateLimitMessage } from '@/lib/httpError'
import { fetchMediaInfo } from '@/lib/mediaApi'

afterEach(() => vi.unstubAllGlobals())

describe('httpError', () => {
  it('parseRetryAfter: Sekunden, HTTP-Datum, ungültig', () => {
    expect(parseRetryAfter('120')).toBe(120)
    const now = Date.parse('2026-11-14T10:00:00Z')
    expect(parseRetryAfter('Sat, 14 Nov 2026 10:01:30 GMT', now)).toBe(90)
    expect(parseRetryAfter('quatsch')).toBeNull()
    expect(parseRetryAfter(null)).toBeNull()
  })

  it('rateLimitMessage rundet auf Sekunden/Minuten', () => {
    expect(rateLimitMessage(1)).toContain('in 1 Sekunde ')
    expect(rateLimitMessage(30)).toContain('in 30 Sekunden ')
    expect(rateLimitMessage(60)).toContain('in 1 Minute ')
    expect(rateLimitMessage(601)).toContain('in 11 Minuten ')
    expect(rateLimitMessage(null)).toContain('ein paar Minuten')
  })

  it('fallbackErrorMessage: 429 verständlich, sonst Statuscode', () => {
    expect(fallbackErrorMessage(429, '300')).toMatch(/^Zu viele Anfragen.*5 Minuten/)
    expect(fallbackErrorMessage(500)).toBe('Serverfehler (500).')
  })

  it('429 ohne JSON (altes Backend) -> Meldung mit Wartezeit statt „Serverfehler (429)“', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('Too many requests, please try again later.', {
          status: 429,
          headers: { 'Retry-After': '240' },
        }),
      ),
    )
    await expect(fetchMediaInfo('a')).rejects.toThrow(
      'Zu viele Anfragen in kurzer Zeit. Bitte in 4 Minuten erneut versuchen.',
    )
  })
})
