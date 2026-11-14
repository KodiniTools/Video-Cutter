import { afterEach, describe, expect, it } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { createApiRateLimit, waitText } from '../src/lib/rateLimits'

let server: Server | null = null

async function start(writeMax: number, readMax: number): Promise<string> {
  const app = express()
  app.use('/api', createApiRateLimit({ windowMs: 60_000, writeMax, readMax }))
  app.get('/api/x', (_req, res) => res.json({ ok: true }))
  app.post('/api/x', (_req, res) => res.json({ ok: true }))
  server = app.listen(0, '127.0.0.1')
  await new Promise((r) => server!.once('listening', r))
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}/api/x`
}

afterEach(async () => {
  await new Promise((r) => (server ? server.close(r) : r(undefined)))
  server = null
})

describe('createApiRateLimit', () => {
  it('zählt POST und GET getrennt', async () => {
    const url = await start(2, 3)
    expect((await fetch(url, { method: 'POST' })).status).toBe(200)
    expect((await fetch(url, { method: 'POST' })).status).toBe(200)
    // Lesende Anfragen sind vom POST-Kontingent unabhängig.
    for (let i = 0; i < 3; i++) expect((await fetch(url)).status).toBe(200)
    expect((await fetch(url)).status).toBe(429)
  })

  it('antwortet mit deutscher JSON-Meldung und Retry-After', async () => {
    const url = await start(1, 10)
    await fetch(url, { method: 'POST' })
    const res = await fetch(url, { method: 'POST' })
    expect(res.status).toBe(429)
    const retry = Number(res.headers.get('Retry-After'))
    expect(retry).toBeGreaterThan(0)
    expect(retry).toBeLessThanOrEqual(60)
    const body = (await res.json()) as { error: string; retryAfter: number }
    expect(body.error).toMatch(/^Zu viele Anfragen in kurzer Zeit\. Bitte in \d+ (Sekunden|Minute)/)
    expect(body.retryAfter).toBeGreaterThan(0)
  })
})

describe('waitText', () => {
  it('rundet sinnvoll', () => {
    expect(waitText(1)).toBe('1 Sekunde')
    expect(waitText(30)).toBe('30 Sekunden')
    expect(waitText(60)).toBe('1 Minute')
    expect(waitText(61)).toBe('2 Minuten')
    expect(waitText(900)).toBe('15 Minuten')
  })
})
