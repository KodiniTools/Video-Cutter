<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import StillClipForm from './StillClipForm.vue'
import VoiceRecorder from './VoiceRecorder.vue'
import WaveformCanvas from './WaveformCanvas.vue'
import { DERIVED_MEDIA_GONE, stripTileStyle } from '@/lib/derivedApi'
import { MEDIA_AUDIO_UNSUPPORTED, UPLOAD_ABORTED } from '@/lib/mediaApi'
import { formatClockDuration } from '@/lib/timeFormat'
import { useMediaPoolStore, type PoolItem } from '@/stores/mediaPool'
import { useTimelineStore } from '@/stores/timeline'

/** Medienliste des Timeline-Editors: Videos und Tondateien hochladen, ansehen, entfernen. */
const { t } = useI18n()
const pool = useMediaPoolStore()
const timeline = useTimelineStore()

/** Breite des Vorschaubilds in px (Höhe folgt dem Seitenverhältnis des Filmstreifens). */
const THUMB_WIDTH = 96

const input = ref<HTMLInputElement | null>(null)
const dragging = ref(false)
/** Formular „Bild-Clip“ aufgeklappt? */
const stillOpen = ref(false)
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

/** Vorschaubild: das mittlere Bild des Filmstreifens. */
function thumbStyle(item: PoolItem): Record<string, string> {
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

function addLabel(item: PoolItem): string {
  return t(isAudio(item) ? 'mediaPool.addAudioToTimelineNamed' : 'mediaPool.addToTimelineNamed', {
    name: item.name,
  })
}

function details(item: PoolItem): string {
  const m = item.media
  if (!m) return ''
  if (m.kind === 'audio') return `${formatClockDuration(m.duration)} · ${t('mediaPool.audioFile')}`
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
      return { text: t('mediaPool.prepareFailed'), tone: 'error' }
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
      accept="video/*,audio/*"
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

    <p v-if="rejectedText" class="note error" role="alert">{{ rejectedText }}</p>
    <p v-if="!pool.items.length" class="note">{{ t('mediaPool.empty') }}</p>

    <ul v-else class="items">
      <li
        v-for="item in pool.items"
        :key="item.key"
        class="item"
        :data-state="item.state"
        :data-kind="item.media?.kind"
      >
        <div
          class="thumb"
          :class="{ audio: isAudio(item) }"
          :style="thumbStyle(item)"
          aria-hidden="true"
        >
          <span v-if="isAudio(item)">♪</span>
        </div>
        <div class="body">
          <div class="row">
            <span class="name" :title="item.name">{{ item.name }}</span>
            <button
              v-if="item.media"
              type="button"
              class="to-timeline"
              :title="addLabel(item)"
              :aria-label="addLabel(item)"
              @click="timeline.appendMedia(item.media.id)"
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
