import { brotliDecompressSync, inflateSync } from 'node:zlib'

/**
 * Liest die für Text-Einblendungen nötigen Schriftmetriken (head, hhea, OS/2,
 * fvar) direkt aus TTF/OTF, WOFF und WOFF2 – ohne externe Abhängigkeiten.
 * WOFF2: Tabellen liegen Brotli-komprimiert hintereinander; head/hhea/OS/2
 * sind nie „transformiert" und können direkt gelesen werden.
 */

export interface FontMetrics {
  unitsPerEm: number
  winAscent: number
  winDescent: number
  hheaAscent: number
  /** Positiv (Betrag des hhea-Descenders). */
  hheaDescent: number
  typoAscent: number
  /** Positiv (Betrag des typo-Descenders). */
  typoDescent: number
  /** OS/2 fsSelection Bit 7: Browser nutzen dann die typo-Werte. */
  useTypoMetrics: boolean
  weight: number
  italic: boolean
  /** Variable Schrift (fvar) – wird für Einblendungen nicht angeboten. */
  variable: boolean
}

export class FontParseError extends Error {}

/** Tabellen-Tags in der Reihenfolge der WOFF2-Spezifikation (Index 0–62). */
const WOFF2_TAGS = [
  'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm',
  'glyf', 'loca', 'prep', 'CFF ', 'VORG', 'EBDT', 'EBLC', 'gasp', 'hdmx', 'kern',
  'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC',
  'JSTF', 'MATH', 'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar',
  'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar', 'gvar', 'hsty',
  'just', 'lcar', 'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat',
  'Gloc', 'Feat', 'Sill',
] // prettier-ignore

const NEEDED = new Set(['head', 'hhea', 'OS/2', 'fvar'])

type Tables = Map<string, Buffer>

function tagAt(buf: Buffer, off: number): string {
  return buf.toString('latin1', off, off + 4)
}

function need(cond: boolean, msg = 'Ungültige Schriftdatei.'): asserts cond {
  if (!cond) throw new FontParseError(msg)
}

function readSfnt(buf: Buffer): Tables {
  need(buf.length >= 12)
  const n = buf.readUInt16BE(4)
  const tables: Tables = new Map()
  for (let i = 0; i < n; i++) {
    const rec = 12 + i * 16
    need(rec + 16 <= buf.length)
    const tag = tagAt(buf, rec)
    const off = buf.readUInt32BE(rec + 8)
    const len = buf.readUInt32BE(rec + 12)
    need(off + len <= buf.length)
    if (NEEDED.has(tag)) tables.set(tag, buf.subarray(off, off + len))
  }
  return tables
}

function readWoff(buf: Buffer): Tables {
  need(buf.length >= 44)
  const n = buf.readUInt16BE(12)
  const tables: Tables = new Map()
  for (let i = 0; i < n; i++) {
    const rec = 44 + i * 20
    need(rec + 20 <= buf.length)
    const tag = tagAt(buf, rec)
    const off = buf.readUInt32BE(rec + 4)
    const compLen = buf.readUInt32BE(rec + 8)
    const origLen = buf.readUInt32BE(rec + 12)
    need(off + compLen <= buf.length)
    if (!NEEDED.has(tag)) continue
    const raw = buf.subarray(off, off + compLen)
    tables.set(tag, compLen < origLen ? inflateSync(raw) : raw)
  }
  return tables
}

function readWoff2(buf: Buffer): Tables {
  need(buf.length >= 48)
  need(tagAt(buf, 4) !== 'ttcf', 'Schriftsammlungen (TTC) werden nicht unterstützt.')
  const n = buf.readUInt16BE(12)
  const compressedSize = buf.readUInt32BE(20)
  let p = 48

  const base128 = (): number => {
    let v = 0
    for (let i = 0; i < 5; i++) {
      need(p < buf.length)
      const b = buf[p++]
      need(!(i === 0 && b === 0x80))
      v = v * 128 + (b & 0x7f)
      if (!(b & 0x80)) return v
    }
    throw new FontParseError('Ungültige Schriftdatei.')
  }

  const dir: { tag: string; length: number }[] = []
  for (let i = 0; i < n; i++) {
    need(p < buf.length)
    const flags = buf[p++]
    const idx = flags & 0x3f
    const version = flags >> 6
    let tag: string
    if (idx === 63) {
      need(p + 4 <= buf.length)
      tag = tagAt(buf, p)
      p += 4
    } else {
      need(idx < WOFF2_TAGS.length)
      tag = WOFF2_TAGS[idx]
    }
    const origLength = base128()
    // glyf/loca: Version 0 = transformiert; sonst: Version ≠ 0 = transformiert.
    const transformed = tag === 'glyf' || tag === 'loca' ? version === 0 : version !== 0
    const length = transformed ? base128() : origLength
    dir.push({ tag, length })
  }
  need(p + compressedSize <= buf.length)
  const data = brotliDecompressSync(buf.subarray(p, p + compressedSize))
  const tables: Tables = new Map()
  let off = 0
  for (const t of dir) {
    need(off + t.length <= data.length)
    if (NEEDED.has(t.tag)) tables.set(t.tag, data.subarray(off, off + t.length))
    off += t.length
  }
  return tables
}

/** Liest die Metriken einer Schriftdatei (TTF, OTF, WOFF, WOFF2). */
export function readFontMetrics(buf: Buffer): FontMetrics {
  need(buf.length >= 12)
  const sig = tagAt(buf, 0)
  let tables: Tables
  if (sig === 'wOF2') tables = readWoff2(buf)
  else if (sig === 'wOFF') tables = readWoff(buf)
  else if (sig === 'OTTO' || sig === 'true' || buf.readUInt32BE(0) === 0x00010000)
    tables = readSfnt(buf)
  else throw new FontParseError('Unbekanntes Schriftformat.')

  const head = tables.get('head')
  const hhea = tables.get('hhea')
  const os2 = tables.get('OS/2')
  need(!!head && head.length >= 54 && !!hhea && hhea.length >= 10 && !!os2 && os2.length >= 78)

  const unitsPerEm = head.readUInt16BE(18)
  need(unitsPerEm >= 16)
  const fsSelection = os2.readUInt16BE(62)
  const m: FontMetrics = {
    unitsPerEm,
    hheaAscent: hhea.readInt16BE(4),
    hheaDescent: Math.abs(hhea.readInt16BE(6)),
    typoAscent: os2.readInt16BE(68),
    typoDescent: Math.abs(os2.readInt16BE(70)),
    winAscent: os2.readUInt16BE(74),
    winDescent: os2.readUInt16BE(76),
    useTypoMetrics: (fsSelection & 0x80) !== 0,
    weight: os2.readUInt16BE(4),
    italic: (fsSelection & 0x01) !== 0,
    variable: tables.has('fvar'),
  }
  need(m.winAscent + m.winDescent > 0)
  return m
}

/**
 * libass rechnet `\fs` als (winAscent + winDescent) der Schrift; CSS als Em.
 * Daraus: `\fs = cssPx * winRatio`, Zeilenhöhe bei libass ebenfalls winRatio.
 */
export function winRatio(m: FontMetrics): number {
  return (m.winAscent + m.winDescent) / m.unitsPerEm
}

/**
 * Vertikaler Versatz (in em), um den libass einen Textblock gegenüber CSS
 * (line-height = winRatio, Halb-Durchschuss) tiefer setzt. libass legt die
 * Grundlinie bei winAscent, der Browser bei Halb-Durchschuss + Ascent
 * (hhea bzw. typo, wenn USE_TYPO_METRICS gesetzt ist).
 */
export function previewShift(m: FontMetrics): number {
  const asc = m.useTypoMetrics ? m.typoAscent : m.hheaAscent
  const desc = m.useTypoMetrics ? m.typoDescent : m.hheaDescent
  return (m.winAscent - m.winDescent - (asc - desc)) / (2 * m.unitsPerEm)
}
