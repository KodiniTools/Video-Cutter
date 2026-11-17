/** Mehrere Kanäle zu einem mischen (Mittelwert). */
export function mixToMono(channels: readonly Float32Array[]): Float32Array {
  if (channels.length === 0) return new Float32Array(0)
  if (channels.length === 1) return channels[0]
  const out = new Float32Array(channels[0].length)
  for (const ch of channels) for (let i = 0; i < out.length; i++) out[i] += ch[i] ?? 0
  for (let i = 0; i < out.length; i++) out[i] /= channels.length
  return out
}

/** Mono-Ton als WAV-Datei (PCM, 16 Bit). Werte außerhalb −1…1 werden begrenzt. */
export function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const HEADER = 44
  const buffer = new ArrayBuffer(HEADER + samples.length * 2)
  const view = new DataView(buffer)
  const text = (at: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(at + i, value.charCodeAt(i))
  }
  text(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  text(8, 'WAVE')
  text(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // ein Kanal
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // Bytes je Sekunde
  view.setUint16(32, 2, true) // Bytes je Abtastwert
  view.setUint16(34, 16, true)
  text(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(HEADER + i * 2, Math.round(v < 0 ? v * 0x8000 : v * 0x7fff), true)
  }
  return buffer
}
