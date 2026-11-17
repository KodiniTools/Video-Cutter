<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { formatClockDuration } from '@/lib/timeFormat'
import { canRecord, RECORDING_TOO_SHORT, recordingToWav } from '@/lib/voiceRecording'
import { useMediaPoolStore } from '@/stores/mediaPool'
import { useTimelineStore } from '@/stores/timeline'
import type { Time } from '@/timeline/model'

/**
 * Sprachaufnahme: nimmt mit dem Mikrofon auf, lädt die Aufnahme als Tondatei
 * hoch und legt sie dort auf eine Ton-Spur, wo der Abspielkopf beim Start stand.
 */

/** Längste Aufnahme; danach stoppt sie von selbst. */
const MAX_RECORDING_MS = 10 * 60 * 1000
const TICK_MS = 100

type Phase = 'idle' | 'starting' | 'recording' | 'processing'
type Problem = 'unsupported' | 'denied' | 'noMic' | 'tooShort' | 'failed'

const { t } = useI18n()
const pool = useMediaPoolStore()
const timeline = useTimelineStore()

const phase = ref<Phase>('idle')
const problem = ref<Problem | null>(null)
/** Bisherige Länge in Sekunden. */
const elapsed = ref(0)
/** Pegel des Mikrofons 0…1. */
const level = ref(0)

let stream: MediaStream | null = null
let recorder: MediaRecorder | null = null
let meter: AudioContext | null = null
let timer: ReturnType<typeof setInterval> | undefined
let chunks: Blob[] = []
let startedAt = 0
/** Stelle der Timeline, an der die Aufnahme landet. */
let insertAt: Time = 0
let discarded = false

function release(): void {
  if (timer !== undefined) clearInterval(timer)
  timer = undefined
  stream?.getTracks().forEach((track) => track.stop())
  stream = null
  void meter?.close().catch(() => {})
  meter = null
  recorder = null
  level.value = 0
}

function problemOf(err: unknown): Problem {
  const name = err instanceof Error ? err.name : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied'
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'noMic'
  return 'failed'
}

/** Pegelanzeige: lautester Wert des aktuellen Abschnitts. */
function watchLevel(source: MediaStream): () => void {
  try {
    meter = new AudioContext()
    const analyser = meter.createAnalyser()
    analyser.fftSize = 1024
    meter.createMediaStreamSource(source).connect(analyser)
    const data = new Uint8Array(analyser.fftSize)
    return () => {
      analyser.getByteTimeDomainData(data)
      let peak = 0
      for (const v of data) peak = Math.max(peak, Math.abs(v - 128) / 128)
      level.value = peak
    }
  } catch {
    // Ohne Pegelanzeige geht die Aufnahme trotzdem.
    return () => {}
  }
}

async function start(): Promise<void> {
  if (phase.value !== 'idle') return
  problem.value = null
  if (!canRecord()) {
    problem.value = 'unsupported'
    return
  }
  phase.value = 'starting'
  insertAt = timeline.playhead
  discarded = false
  chunks = []
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    const rec = (recorder = new MediaRecorder(stream))
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data)
    }
    rec.onstop = () => void finish(rec.mimeType)
    rec.onerror = () => {
      discarded = true
      release()
      phase.value = 'idle'
      problem.value = 'failed'
    }
    const readLevel = watchLevel(stream)
    rec.start()
    startedAt = Date.now()
    elapsed.value = 0
    phase.value = 'recording'
    timer = setInterval(() => {
      const ms = Date.now() - startedAt
      elapsed.value = ms / 1000
      readLevel()
      if (ms >= MAX_RECORDING_MS) stop()
    }, TICK_MS)
  } catch (err) {
    release()
    phase.value = 'idle'
    problem.value = problemOf(err)
  }
}

/** Aufnahme beenden und übernehmen. */
function stop(): void {
  if (phase.value !== 'recording' || !recorder) return
  phase.value = 'processing'
  if (timer !== undefined) clearInterval(timer)
  timer = undefined
  recorder.stop()
}

/** Aufnahme beenden und wegwerfen. */
function discard(): void {
  if (phase.value !== 'recording' || !recorder) return
  discarded = true
  recorder.stop()
}

function fileName(): string {
  const now = new Date()
  const two = (n: number) => String(n).padStart(2, '0')
  const time = `${two(now.getHours())}-${two(now.getMinutes())}-${two(now.getSeconds())}`
  return `${t('timeline.voice.fileName')} ${time}.wav`
}

async function finish(mimeType: string): Promise<void> {
  const recording = new Blob(chunks, mimeType ? { type: mimeType } : {})
  chunks = []
  release()
  if (discarded) {
    phase.value = 'idle'
    return
  }
  const at = insertAt
  try {
    const file = await recordingToWav(recording, fileName())
    // Sobald die Datei auf dem Server liegt, kommt sie auf die Timeline.
    pool.add([file], (media) => timeline.insertAudioAt(media.id, at))
  } catch (err) {
    problem.value =
      err instanceof Error && err.message === RECORDING_TOO_SHORT ? 'tooShort' : 'failed'
  } finally {
    phase.value = 'idle'
  }
}

onBeforeUnmount(() => {
  discarded = true
  if (recorder && recorder.state !== 'inactive') recorder.stop()
  release()
})
</script>

<template>
  <div class="voice" data-testid="voice-recorder">
    <button
      v-if="phase !== 'recording'"
      type="button"
      class="add second"
      :disabled="phase !== 'idle'"
      data-testid="voice-start"
      :title="t('timeline.voice.startHint')"
      @click="start"
    >
      {{ t(phase === 'processing' ? 'timeline.voice.processing' : 'timeline.voice.start') }}
    </button>
    <div v-else class="running" role="group" :aria-label="t('timeline.voice.running')">
      <span class="dot" aria-hidden="true" />
      <span class="time" role="timer" data-testid="voice-time">
        {{ formatClockDuration(elapsed) }}
      </span>
      <meter
        class="level"
        min="0"
        max="1"
        :value="level"
        :aria-label="t('timeline.voice.level')"
        data-testid="voice-level"
      />
      <button type="button" class="btn stop" data-testid="voice-stop" @click="stop">
        {{ t('timeline.voice.stop') }}
      </button>
      <button type="button" class="btn" data-testid="voice-discard" @click="discard">
        {{ t('timeline.voice.discard') }}
      </button>
    </div>
    <p v-if="phase === 'recording'" class="note">{{ t('timeline.voice.hint') }}</p>
    <p v-if="problem" class="note error" role="alert" data-testid="voice-error">
      {{ t(`timeline.voice.problems.${problem}`) }}
    </p>
  </div>
</template>

<style scoped>
.voice {
  display: flex;
  flex-direction: column;
  gap: var(--ds-space-2);
}
.add {
  min-height: var(--ds-control-md);
  padding: 0 var(--ds-space-4);
  border: 1px solid var(--ds-border);
  border-radius: var(--ds-radius-md);
  background: var(--ds-surface-2);
  color: var(--ds-text);
  cursor: pointer;
}
.add:hover:not(:disabled) {
  background: var(--ds-accent-soft);
}
.add:disabled {
  opacity: 0.6;
  cursor: default;
}
.add:focus-visible,
.btn:focus-visible {
  outline: none;
  box-shadow: var(--ds-focus-ring);
}
.running {
  display: flex;
  align-items: center;
  gap: var(--ds-space-2);
  flex-wrap: wrap;
}
.dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--ds-danger);
  animation: blink 1s steps(2, start) infinite;
}
@keyframes blink {
  to {
    visibility: hidden;
  }
}
@media (prefers-reduced-motion: reduce) {
  .dot {
    animation: none;
  }
}
.time {
  font-variant-numeric: tabular-nums;
  font-weight: var(--ds-weight-semibold);
}
.level {
  flex: 1;
  min-width: 60px;
  height: 10px;
}
.btn {
  height: var(--ds-control-sm);
  padding: 0 var(--ds-space-3);
  border: 1px solid var(--ds-border);
  border-radius: var(--ds-radius-md);
  background: var(--ds-surface-1);
  color: var(--ds-text);
  font-size: var(--ds-text-sm);
  cursor: pointer;
}
.btn.stop {
  border-color: var(--ds-accent);
  font-weight: var(--ds-weight-semibold);
}
.note {
  margin: 0;
  color: var(--ds-text-2);
  font-size: var(--ds-text-sm);
}
.note.error {
  color: var(--ds-danger);
}
</style>
