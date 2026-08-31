/**
 * Minimales Typ-Shim für die im Prototyp genutzte Teilmenge von mp4box.js
 * (Version 0.5.x). mp4box liefert keine eigenen Typen und es gibt kein
 * @types/mp4box-Paket. Bewusst nur das, was useClientRemux.ts anfasst.
 */
declare module 'mp4box' {
  /** Ein Track aus MP4Box.info. Zeiten in `timescale`-Einheiten. */
  export interface MP4Track {
    id: number
    type?: string // von manchen Buildern gesetzt
    codec: string
    timescale: number
    duration: number
    nb_samples: number
    track_width?: number
    track_height?: number
    video?: { width: number; height: number }
    audio?: { sample_rate: number; channel_count: number; sample_size: number }
  }

  export interface MP4Info {
    tracks: MP4Track[]
    videoTracks: MP4Track[]
    audioTracks: MP4Track[]
    duration: number
    timescale: number
    brands: string[]
  }

  /** Ein extrahiertes Sample. cts/dts/duration in `timescale`-Einheiten. */
  export interface MP4Sample {
    number: number
    track_id: number
    timescale: number
    cts: number
    dts: number
    duration: number
    size: number
    is_sync: boolean
    data: Uint8Array
  }

  /** Optionen für addTrack – hier codec-agnostisch über `description`. */
  export interface AddTrackOptions {
    id?: number
    type?: string
    timescale?: number
    width?: number
    height?: number
    duration?: number
    media_duration?: number
    language?: string
    hdlr?: string
    name?: string
    samplerate?: number
    channel_count?: number
    samplesize?: number
    // Wiederverwendete Codec-Konfiguration (avcC/hvcC/av1C/esds …) als Box.
    description?: unknown
    description_boxes?: unknown[]
  }

  export interface AddSampleOptions {
    duration?: number
    cts?: number
    dts?: number
    is_sync?: boolean
    sample_description_index?: number
  }

  /** Grob typisierter stsd-Eintrag; Codec-Boxen liegen als benannte Felder an. */
  export interface SampleEntryBox {
    type: string
    boxes: Array<{ type: string }>
    [key: string]: unknown
  }

  export interface Trak {
    mdia: { minf: { stbl: { stsd: { entries: SampleEntryBox[] } } } }
  }

  export interface ISOFile {
    onReady: ((info: MP4Info) => void) | null
    onError: ((e: string) => void) | null
    onSamples: ((id: number, user: unknown, samples: MP4Sample[]) => void) | null
    appendBuffer(data: ArrayBuffer & { fileStart?: number }): number
    start(): void
    stop(): void
    flush(): void
    setExtractionOptions(id: number, user?: unknown, options?: { nbSamples?: number }): void
    unsetExtractionOptions(id: number): void
    releaseUsedSamples(id: number, sampleNum: number): void
    getTrackById(id: number): Trak | null
    addTrack(options: AddTrackOptions): number | undefined
    addSample(trackId: number, data: Uint8Array, options?: AddSampleOptions): unknown
    getBuffer(): ArrayBuffer
  }

  export function createFile(keepMdatData?: boolean): ISOFile
}
