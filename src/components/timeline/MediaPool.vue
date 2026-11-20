<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import StillClipForm from './StillClipForm.vue'
import VoiceOverForm from './VoiceOverForm.vue'
import VoiceRecorder from './VoiceRecorder.vue'
import WaveformCanvas from './WaveformCanvas.vue'
import { API_BASE } from '@/lib/apiBase'
import { DERIVED_MEDIA_GONE, proxyUrl, stripTileStyle } from '@/lib/derivedApi'
import { MEDIA_AUDIO_UNSUPPORTED, MEDIA_IMAGE_UNSUPPORTED, UPLOAD_ABORTED } from '@/lib/mediaApi'
import { IMAGE_ACCEPT } from '@/lib/imageAssets'
import { secondsToTime } from '@/timeline/model'
import { DEFAULT_GRAPHIC_DURATION, newImageData } from '@/timeline/graphics'
import { formatClockDuration } from '@/lib/timeFormat'
import {
  generatedAtRisk,
  IMAGE_LOAD_FAILED,
  useMediaPoolStore,
  type PoolItem,
} from '@/stores/mediaPool'
import { useTimelineStore } from '@/stores/timeline'
import { useTimelineProjectStore } from '@/stores/timelineProjects'

/** Medienliste des Timeline-Editors: Videos, Tondateien und Bilder hochladen, ansehen, entfernen. */
const { t } = useI18n()
const pool = useMediaPoolStore()
const timeline = useTimelineStore()
const projects = useTimelineProjectStore()

/** Bild-Clips/KI-Videos liegen nur im Zwischenspeicher, solange kein Projekt gespeichert ist. */
const showGeneratedHint = computed(() => generatedAtRisk(pool.items, projects.dirty))

/** Breite des Vorschaubilds in px (Höhe folgt dem Seitenverhältnis des Filmstreifens). */
const THUMB_WIDTH = 96

const input = ref<HTMLInputElement | null>(null)
const dragging = ref(false)
/** Formular „Bild-Clip“ aufgeklappt? */
const stillOpen = ref(false)
/** KI-Sprecher aufgeklappt? (einmal geöffnet, bleibt er erhalten: Text + laufender Auftrag) */
const voiceOverOpen = ref(false)
const voiceOverUsed = ref(false)

function toggleVoiceOver(): void {
  voiceOverOpen.value = !voiceOverOpen.value
  voiceOverUsed.value = true
}
/** Schlüssel des Mediums, dessen Entfernen zuletzt abgelehnt wurde. */
const blockedKey = ref<string | null>(null)

function onPick(event: Event): void {
  const el = event.target as HTMLInputElement
  pool.add([...(el.files ?? [])])
  // Dieselbe Datei soll erneut wählbar sein.
  el.value = ''
}

function onDrop(event: DragEvent): void {
  dragging.value = false
  pool.add([...(event.dataTransfer?.files ?? [])])
}

function remove(item: PoolItem): void {
  blockedKey.value = pool.remove(item.key) === 'in-use' ? item.key : null
}

/** Vorschaubild: das mittlere Bild des Filmstreifens (Bilder: das Bild selbst). */
function thumbStyle(item: PoolItem): Record<string, string> {
  if (isImage(item)) {
    const m = item.media
    const ratio = m && m.width > 0 && m.height > 0 ? m.height / m.width : 9 / 16
    return {
      width: `${THUMB_WIDTH}px`,
      height: `${Math.round(THUMB_WIDTH * Math.min(1, ratio))}px`,
      ...(item.thumb
        ? {
            backgroundImage: `url("${item.thumb}")`,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
          }
        : {}),
    }
  }
  const strip = item.derived?.strip
  const tile =
    item.media && strip
      ? stripTileStyle(item.media.id, strip, Math.floor(strip.count / 2), THUMB_WIDTH)
      : null
  const ratio = strip?.tileWidth && strip.tileHeight ? strip.tileHeight / strip.tileWidth : 9 / 16
  return {
    width: `${THUMB_WIDTH}px`,
    height: `${Math.round(THUMB_WIDTH * Math.min(1, ratio))}px`,
    ...(tile ?? {}),
  }
}

const isAudio = (item: PoolItem) => item.media?.kind === 'audio'
const isImage = (item: PoolItem) => item.media?.kind === 'image'

/** „+ Timeline“: Bilder als Bild-Clip auf eine Ebene, sonst Video/Ton wie bisher. */
function insert(item: PoolItem): void {
  const m = item.media
  if (!m) return
  if (m.kind === 'image')
    timeline.insertImageAtPlayhead(newImageData(m.id), secondsToTime(DEFAULT_GRAPHIC_DURATION))
  else timeline.insertMediaAtPlayhead(m.id)
}

/**
 * Abspielen im Vorschaubild: Überfahren spielt stumm in Schleife, ein Klick spielt mit Ton
 * (nochmals klicken hält an). Es läuft immer höchstens ein Vorschaubild.
 */
const playing = ref<{ key: string; sound: boolean } | null>(null)
/** Abspielstand 0…1 für die dünne Leiste im Vorschaubild. */
const playProgress = ref(0)
/** Vorschau-Kopie ließ sich nicht laden: dann das Original vom Server. */
const useOriginal = ref(false)

/**
 * Abspielbar im Vorschaubild: Videos mit fertiger Vorschau-Kopie und Tondateien
 * (diese direkt aus der hochgeladenen Datei, nur per Klick).
 */
const canPlay = (item: PoolItem) =>
  !!item.media && (isAudio(item) || item.derived?.proxy.state === 'ready')

function playSrc(item: PoolItem): string {
  const id = item.media!.id
  return useOriginal.value || isAudio(item)
    ? `${API_BASE}/api/media/${encodeURIComponent(id)}/file`
    : proxyUrl(id)
}

function startPlay(item: PoolItem, sound: boolean): void {
  if (playing.value?.key !== item.key) {
    playProgress.value = 0
    useOriginal.value = false
  }
  playing.value = { key: item.key, sound }
}

function onHover(item: PoolItem): void {
  // Ein mit Ton laufendes Vorschaubild wird durch Überfahren nicht unterbrochen.
  // Tondateien stumm abzuspielen ergibt nichts: Sie laufen nur per Klick.
  if (!canPlay(item) || isAudio(item) || playing.value?.sound) return
  startPlay(item, false)
}

function onLeave(item: PoolItem): void {
  if (playing.value?.key === item.key && !playing.value.sound) playing.value = null
}

function onThumbClick(item: PoolItem): void {
  if (!canPlay(item)) return
  if (playing.value?.key === item.key && playing.value.sound) playing.value = null
  else startPlay(item, true)
}

function onTimeUpdate(event: Event): void {
  const el = event.target as HTMLMediaElement
  playProgress.value = el.duration > 0 ? el.currentTime / el.duration : 0
}

/** Mit Ton einmal bis zum Ende, dann aus; stumm läuft es per `loop` weiter. */
function onEnded(): void {
  playing.value = null
}

function onVideoError(): void {
  if (!useOriginal.value) useOriginal.value = true
  else playing.value = null
}

function onAudioError(): void {
  playing.value = null
}

function playLabel(item: PoolItem): string {
  const active = playing.value?.key === item.key && playing.value.sound
  const key = isAudio(item)
    ? active
      ? 'mediaPool.stopAudioNamed'
      : 'mediaPool.playAudioNamed'
    : active
      ? 'mediaPool.stopPreviewNamed'
      : 'mediaPool.playPreviewNamed'
  return t(key, { name: item.name })
}

function addLabel(item: PoolItem): string {
  const key = isAudio(item)
    ? 'mediaPool.addAudioToTimelineNamed'
    : isImage(item)
      ? 'mediaPool.addImageToTimelineNamed'
      : 'mediaPool.addToTimelineNamed'
  return t(key, { name: item.name })
}

function details(item: PoolItem): string {
  const m = item.media
  if (!m) return ''
  if (m.kind === 'audio') return `${formatClockDuration(m.duration)} · ${t('mediaPool.audioFile')}`
  if (m.kind === 'image')
    return m.width > 0 && m.height > 0
      ? `${t('mediaPool.imageFile')} · ${m.width}×${m.height}`
      : t('mediaPool.imageFile')
  const size = m.width > 0 && m.height > 0 ? ` · ${m.width}×${m.height}` : ''
  return `${formatClockDuration(m.duration)}${size}`
}

function status(item: PoolItem): { text: string; tone: 'info' | 'ok' | 'error' } {
  if (item.state === 'uploading')
    return {
      text: t('mediaPool.uploading', { pct: Math.round(item.progress * 100) }),
      tone: 'info',
    }
  if (item.state === 'error') {
    const text =
      item.error === DERIVED_MEDIA_GONE
        ? t('mediaPool.gone')
        : item.error === UPLOAD_ABORTED
          ? t('mediaPool.aborted')
          : item.error === MEDIA_AUDIO_UNSUPPORTED
            ? t('mediaPool.audioUnsupported')
            : item.error === MEDIA_IMAGE_UNSUPPORTED
              ? t('mediaPool.imageUnsupported')
              : (item.error ?? t('mediaPool.uploadFailed'))
    return { text, tone: 'error' }
  }
  switch (item.prepare) {
    case 'busy': {
      const proxy = item.derived?.proxy
      return {
        text:
          proxy?.state === 'running'
            ? t('mediaPool.preparingPct', { pct: Math.round(proxy.progress) })
            : t('mediaPool.preparing'),
        tone: 'info',
      }
    }
    case 'failed':
      return {
        text:
          item.error === IMAGE_LOAD_FAILED
            ? t('mediaPool.imageLoadFailed')
            : t('mediaPool.prepareFailed'),
        tone: 'error',
      }
    case 'unsupported':
      return { text: t('mediaPool.unsupported'), tone: 'error' }
    case 'done':
      return { text: t('mediaPool.ready'), tone: 'ok' }
    case 'idle':
      return { text: '', tone: 'info' }
  }
}

const rejectedText = computed(() =>
  pool.rejected.length ? t('mediaPool.rejected', { names: pool.rejected.join(', ') }) : '',
)
</script>

<template>
  <section
    class="pool"
    :class="{ dragging }"
    data-testid="media-pool"
    @dragover.prevent="dragging = true"
    @dragleave.self="dragging = false"
    @drop.prevent="onDrop"
  >
    <header class="pool-head">
      <h3>{{ t('mediaPool.title') }}</h3>
      <span v-if="pool.items.length" class="count">{{ pool.items.length }}</span>
    </header>

    <input
      ref="input"
      class="file"
      type="file"
      :accept="`video/*,audio/*,${IMAGE_ACCEPT}`"
      multiple
      data-testid="media-pool-input"
      @change="onPick"
    />
    <button type="button" class="add" @click="input?.click()">{{ t('mediaPool.add') }}</button>
    <button
      type="button"
      class="add second"
      :aria-expanded="stillOpen"
      data-testid="media-pool-still"
      @click="stillOpen = !stillOpen"
    >
      {{ t('timeline.still.open') }}
    </button>
    <StillClipForm v-if="stillOpen" @close="stillOpen = false" />
    <VoiceRecorder />
    <button
      type="button"
      class="add second"
      :aria-expanded="voiceOverOpen"
      data-testid="media-pool-voice-over"
      :title="t('timeline.voiceOver.openHint')"
      @click="toggleVoiceOver"
    >
      {{ t('timeline.voiceOver.open') }}
    </button>
    <VoiceOverForm v-if="voiceOverUsed" v-show="voiceOverOpen" />

    <p v-if="rejectedText" class="note error" role="alert">{{ rejectedText }}</p>
    <p v-if="showGeneratedHint" class="note warn" data-testid="media-pool-generated-hint">
      {{ t('mediaPool.generatedUnsaved') }}
    </p>
    <p v-if="!pool.items.length" class="note">{{ t('mediaPool.empty') }}</p>

    <ul v-else class="items">
      <li
        v-for="item in pool.items"
        :key="item.key"
        class="item"
        :data-state="item.state"
        :data-kind="item.media?.kind"
      >
        <button
          v-if="canPlay(item)"
          type="button"
          class="thumb playable"
          :class="{ active: playing?.key === item.key, audio: isAudio(item) }"
          :style="thumbStyle(item)"
          :title="t(isAudio(item) ? 'mediaPool.playAudioHint' : 'mediaPool.playPreviewHint')"
          :aria-label="playLabel(item)"
          :aria-pressed="playing?.key === item.key && playing.sound"
          data-testid="media-pool-thumb"
          @mouseenter="onHover(item)"
          @mouseleave="onLeave(item)"
          @click="onThumbClick(item)"
        >
          <span v-if="isAudio(item)">♪</span>
          <audio
            v-if="isAudio(item) && playing?.key === item.key"
            :src="playSrc(item)"
            autoplay
            preload="auto"
            data-testid="media-pool-thumb-audio"
            @timeupdate="onTimeUpdate"
            @ended="onEnded"
            @error="onAudioError"
          ></audio>
          <video
            v-else-if="playing?.key === item.key"
            class="thumb-video"
            :src="playSrc(item)"
            :muted="!playing.sound"
            :loop="!playing.sound"
            autoplay
            playsinline
            preload="auto"
            data-testid="media-pool-thumb-video"
            @timeupdate="onTimeUpdate"
            @ended="onEnded"
            @error="onVideoError"
          ></video>
          <span v-if="playing?.key === item.key" class="thumb-progress">
            <span :style="{ width: `${Math.round(playProgress * 100)}%` }"></span>
          </span>
          <span class="thumb-badge" aria-hidden="true">{{
            playing?.key === item.key && playing.sound ? '❚❚' : '▶'
          }}</span>
        </button>
        <div
          v-else
          class="thumb"
          :class="{ image: isImage(item) }"
          :style="thumbStyle(item)"
          :data-testid="isImage(item) ? 'media-pool-image-thumb' : undefined"
          aria-hidden="true"
        ></div>
        <div class="body">
          <div class="row">
            <span class="name" :title="item.name">{{ item.name }}</span>
            <button
              v-if="item.media"
              type="button"
              class="to-timeline"
              :title="addLabel(item)"
              :aria-label="addLabel(item)"
              @click="insert(item)"
            >
              {{ t('mediaPool.addToTimeline') }}
            </button>
            <button
              type="button"
              class="icon"
              :title="t('mediaPool.remove')"
              :aria-label="t('mediaPool.removeNamed', { name: item.name })"
              @click="remove(item)"
            >
              🗑
            </button>
          </div>
          <div v-if="details(item)" class="details">{{ details(item) }}</div>
          <div v-if="item.peaks" class="wave"><WaveformCanvas :peaks="item.peaks" /></div>
          <div
            v-if="item.state === 'uploading'"
            class="bar"
            role="progressbar"
            :aria-valuenow="Math.round(item.progress * 100)"
            aria-valuemin="0"
            aria-valuemax="100"
          >
            <span :style="{ width: `${Math.round(item.progress * 100)}%` }"></span>
          </div>
          <div v-if="status(item).text" class="status" :data-tone="status(item).tone">
            {{ status(item).text }}
            <button
              v-if="item.state === 'ready' && item.prepare === 'failed'"
              type="button"
              class="link"
              @click="pool.prepare(item.key)"
            >
              {{ t('mediaPool.retry') }}
            </button>
          </div>
          <p v-if="blockedKey === item.key" class="status" data-tone="error" role="alert">
            {{ t('mediaPool.inUse') }}
          </p>
        </div>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.pool {
  display: flex;
  flex-direction: column;
  gap: var(--ds-space-3);
  padding: var(--ds-space-4);
  border: 1px solid var(--ds-border);
  border-radius: var(--ds-radius-lg);
  background: var(--ds-surface-1);
}
.pool.dragging {
  border-color: var(--ds-accent);
  box-shadow: var(--ds-focus-ring);
}
.pool-head {
  display: flex;
  align-items: center;
  gap: var(--ds-space-2);
}
.pool-head h3 {
  margin: 0;
  font-size: var(--ds-text-md);
  font-weight: var(--ds-weight-semibold);
}
.count {
  min-width: 22px;
  padding: 0 6px;
  border-radius: var(--ds-radius-full);
  background: var(--ds-accent);
  color: var(--ds-on-accent);
  font-size: var(--ds-text-xs);
  font-weight: var(--ds-weight-semibold);
  line-height: 22px;
  text-align: center;
}
.file {
  display: none;
}
.add {
  min-height: var(--ds-control-md);
  padding: 0 var(--ds-space-4);
  border: 1px solid var(--ds-accent);
  border-radius: var(--ds-radius-md);
  background: var(--ds-surface-2);
  color: var(--ds-text);
  font-weight: var(--ds-weight-semibold);
  cursor: pointer;
}
.add.second {
  border-color: var(--ds-border);
  font-weight: var(--ds-weight-regular, 400);
}
.add:hover {
  background: var(--ds-accent-soft);
}
.to-timeline {
  flex: none;
  height: var(--ds-control-sm);
  padding: 0 var(--ds-space-2);
  border: 1px solid var(--ds-accent);
  border-radius: var(--ds-radius-full);
  background: var(--ds-surface-1);
  color: var(--ds-text);
  font-size: var(--ds-text-xs);
  font-weight: var(--ds-weight-semibold);
  cursor: pointer;
}
.to-timeline:hover {
  background: var(--ds-accent-soft);
}
.to-timeline:focus-visible,
.add:focus-visible,
.icon:focus-visible,
.link:focus-visible {
  outline: none;
  box-shadow: var(--ds-focus-ring);
}
.note {
  margin: 0;
  font-size: var(--ds-text-sm);
  color: var(--ds-text-2);
}
.note.error {
  color: var(--ds-danger);
}
.note.warn {
  color: var(--ds-text);
  padding: 6px 8px;
  border-left: 3px solid var(--ds-warning);
  background: color-mix(in srgb, var(--ds-warning) 10%, transparent);
  border-radius: 4px;
}
.items {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--ds-space-2);
}
.item {
  display: flex;
  gap: var(--ds-space-3);
  padding: var(--ds-space-2);
  border: 1px solid var(--ds-border);
  border-radius: var(--ds-radius-md);
  background: var(--ds-surface-0);
}
.thumb {
  flex: none;
  border-radius: var(--ds-radius-sm);
  background-color: var(--ds-surface-3);
  background-repeat: no-repeat;
}
.thumb.playable {
  position: relative;
  overflow: hidden;
  padding: 0;
  border: 0;
  cursor: pointer;
}
.thumb.playable:focus-visible {
  outline: none;
  box-shadow: var(--ds-focus-ring);
}
.thumb-video {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  background: #000;
}
.thumb-badge {
  position: absolute;
  right: 4px;
  bottom: 6px;
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  border-radius: var(--ds-radius-full);
  background: rgb(0 0 0 / 0.6);
  color: #fff;
  font-size: 9px;
  line-height: 1;
  opacity: 0;
  transition: opacity 0.15s;
}
.thumb.playable:hover .thumb-badge,
.thumb.playable:focus-visible .thumb-badge,
.thumb.playable[aria-pressed='true'] .thumb-badge {
  opacity: 1;
}
.thumb-progress {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 3px;
  background: rgb(0 0 0 / 0.4);
}
.thumb-progress span {
  display: block;
  height: 100%;
  background: var(--ds-accent);
}
.thumb.audio {
  display: grid;
  place-items: center;
  color: var(--ds-text-2);
  font-size: var(--ds-text-xl);
}
.body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.row {
  display: flex;
  align-items: center;
  gap: var(--ds-space-2);
}
.name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--ds-text-sm);
  font-weight: var(--ds-weight-medium);
}
.icon {
  flex: none;
  width: var(--ds-control-sm);
  height: var(--ds-control-sm);
  border: 1px solid var(--ds-border);
  border-radius: var(--ds-radius-full);
  background: var(--ds-surface-1);
  cursor: pointer;
}
.icon:hover {
  border-color: var(--ds-danger);
}
.details {
  font-size: var(--ds-text-xs);
  color: var(--ds-text-2);
  font-variant-numeric: tabular-nums;
}
.wave {
  height: 24px;
  color: var(--ds-accent);
}
.bar {
  height: 4px;
  border-radius: var(--ds-radius-full);
  background: var(--ds-surface-3);
  overflow: hidden;
}
.bar span {
  display: block;
  height: 100%;
  background: var(--ds-accent);
}
.status {
  margin: 0;
  font-size: var(--ds-text-xs);
  color: var(--ds-text-2);
}
.status[data-tone='ok'] {
  color: var(--ds-success);
}
.status[data-tone='error'] {
  color: var(--ds-danger);
}
.link {
  margin-left: var(--ds-space-1);
  padding: 0;
  border: 0;
  background: none;
  color: var(--ds-link);
  font-size: inherit;
  text-decoration: underline;
  cursor: pointer;
}
</style>
