// KodiniTools setzt keine Analyse-, Marketing- oder Tracking-Dienste ein
// (Entscheidung 20.11.2026): kein Google Tag Manager, kein gtag, kein Consent Mode.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('index.html ohne Tracking', () => {
  it('enthält keinen Consent Mode, kein gtag und keinen Tag Manager', () => {
    const html = readFileSync(resolve(__dirname, '..', 'index.html'), 'utf8')
    expect(html).not.toMatch(/googletagmanager|GTM-|gtag|dataLayer|cookieConsent/)
  })
})
