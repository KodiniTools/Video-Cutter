<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { fontPreview, type TextFont } from '@/lib/textOverlay'
import { measureLoudness, QUALITY_UNSUPPORTED } from '@/lib/qualityApi'
import { formatTimeMs } from '@/lib/timeFormat'
import { useTimelineStore } from '@/stores/timeline'
import { timeToSeconds } from '@/timeline/model'
import {
  audioHints,
  documentHints,
  estimateTextWidth,
  sortHints,
  type LoudnessMeasure,
  type QualityHint,
  type TextMeasure,
} from '@/timeline/quality'

/**
 * Qualitäts-Check im Export-Dialog: misst am Dokument (Texte, Lücken, kurze
 * Clips) sofort und lässt den Server die Lautheit des Tons messen. Jeder
 * Hinweis springt auf seine Stelle in der Timeline.
 */

const props = defineProps<{
  /** Der Export gleicht die Lautheit an (dann keine Hinweise zu Gesamtlautheit/Übersteuern). */
  normalized: boolean
}>()
const emit = defineEmits<{ jump: [hint: QualityHint] }>()
const { t, n } = useI18n()
const store = useTimelineStore()

/** Text mit der Schrift der Vorschau messen (Canvas); ohne Canvas geschätzt. */
let canvasCtx: CanvasRenderingContext2D | null | undefined
const measure: TextMeasure = (line, font, px) => {
  if (canvasCtx === undefined) {
    try {
      canvasCtx = document.createElement('canvas').getContext('2d')
    } catch {
      canvasCtx = null
    }
  }
  if (!canvasCtx) return estimateTextWidth(line, font, px)
  canvasCtx.font = `${px}px '${fontPreview(font as TextFont).css}'`
  const w = canvasCtx.measureText(line).width
  return w > 0 ? w : estimateTextWidth(line, font, px)
}
const lineRatio = (font: string) => fontPreview(font as TextFont).lineRatio

/** Erhöht sich, sobald die Schriften geladen sind (dann genauer messen). */
const fontsReady = ref(0)
const docHints = computed(() => {
  void fontsReady.value
  return documentHints(store.doc, { measure, lineRatio })
})

type AudioState = 'measuring' | 'done' | 'unsupported' | 'error'
const audioState = ref<AudioState>('measuring')
const audioError = ref('')
const loudness = ref<LoudnessMeasure | null>(null)
let ctrl: AbortController | null = null

const hints = computed(() =>
  sortHints([
    ...docHints.value,
    ...(loudness.value
      ? audioHints(store.doc, loudness.value, { normalized: props.normalized })
      : []),
  ]),
)
const warnCount = computed(() => hints.value.filter((h) => h.severity === 'warn').length)
const infoCount = computed(() => hints.value.length - warnCount.value)

const db = (v: number) => n(v, { maximumFractionDigits: 1, minimumFractionDigits: 1 })
const loudnessSummary = computed(() => {
  const m = loudness.value
  if (!m) return ''
  return t('timelineQuality.loudnessSummary', {
    lufs: db(m.integrated),
    peak: db(m.truePeak),
    range: db(m.range),
  })
})

function hintText(h: QualityHint): string {
  const p: Record<string, string | number> = { ...h.params }
  for (const key of ['lufs', 'db', 's', 'shown', 'need'])
    if (typeof p[key] === 'number') p[key] = db(p[key] as number)
  if (h.kind === 'audioJump') return t(`timelineQuality.kinds.audioJump.${p.dir}`, p)
  return t(`timelineQuality.kinds.${h.kind}`, p)
}
function hintTime(h: QualityHint): string {
  const from = formatTimeMs(timeToSeconds(h.at))
  return h.end !== undefined && h.end > h.at
    ? `${from}–${formatTimeMs(timeToSeconds(h.end))}`
    : from
}

async function remeasure(): Promise<void> {
  ctrl?.abort()
  const c = (ctrl = new AbortController())
  audioState.value = 'measuring'
  audioError.value = ''
  try {
    loudness.value = await measureLoudness(store.doc, c.signal)
    audioState.value = 'done'
  } catch (e) {
    if (c.signal.aborted) return
    const msg = e instanceof Error ? e.message : String(e)
    audioState.value = msg === QUALITY_UNSUPPORTED ? 'unsupported' : 'error'
    audioError.value = msg
  }
}

onMounted(() => {
  void remeasure()
  // Mit geladenen Schriften stimmen die gemessenen Textbreiten.
  document.fonts?.ready.then(() => fontsReady.value++).catch(() => undefined)
})
onBeforeUnmount(() => ctrl?.abort())
</script>

<template>
  <section class="quality" data-testid="quality-check" :aria-label="t('timelineQuality.title')">
    <header class="qhead">
      <strong>{{ t('timelineQuality.title') }}</strong>
      <span class="counts" data-testid="quality-counts">
        <template v-if="hints.length === 0 && audioState !== 'measuring'">
          {{ t('timelineQuality.allGood') }}
        </template>
        <template v-else>
          {{ t('timelineQuality.counts', { warn: warnCount, info: infoCount }) }}
        </template>
      </span>
    </header>
    <p class="status" data-testid="quality-audio" :class="{ error: audioState === 'error' }">
      <template v-if="audioState === 'measuring'">{{ t('timelineQuality.measuring') }}</template>
      <template v-else-if="audioState === 'done'">{{ loudnessSummary }}</template>
      <template v-else-if="audioState === 'unsupported'">{{
        t('timelineQuality.unsupported')
      }}</template>
      <template v-else>
        {{ t('timelineQuality.failed', { error: audioError }) }}
        <button type="button" class="link" data-testid="quality-retry" @click="remeasure">
          {{ t('timelineQuality.retry') }}
        </button>
      </template>
    </p>
    <ul v-if="hints.length > 0" class="list" data-testid="quality-list">
      <li
        v-for="(h, i) in hints"
        :key="`${h.kind}-${h.at}-${h.clipId ?? ''}-${i}`"
        :class="['hint', h.severity]"
        :data-kind="h.kind"
      >
        <span class="icon" :aria-label="t(`timelineQuality.severity.${h.severity}`)">
          {{ h.severity === 'warn' ? '⚠' : 'ℹ' }}
        </span>
        <span class="body">
          <span class="time">{{ hintTime(h) }}</span>
          <span class="text">{{ hintText(h) }}</span>
        </span>
        <button
          type="button"
          class="jump"
          data-testid="quality-jump"
          :title="t('timelineQuality.jumpTitle')"
          @click="emit('jump', h)"
        >
          {{ t('timelineQuality.jump') }}
        </button>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.quality {
  display: flex;
  flex-direction: column;
  gap: var(--ds-space-2);
  padding: var(--ds-space-3);
  border: 1px solid var(--ds-border);
  border-radius: var(--ds-radius-md);
  background: var(--ds-surface-2);
  font-size: var(--ds-text-sm);
}
.qhead {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--ds-space-2);
}
.counts,
.status {
  margin: 0;
  color: var(--ds-text-2);
  font-variant-numeric: tabular-nums;
}
.status.error {
  color: var(--ds-danger);
}
.list {
  display: flex;
  flex-direction: column;
  gap: var(--ds-space-1);
  max-height: 220px;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  list-style: none;
}
.hint {
  display: flex;
  align-items: flex-start;
  gap: var(--ds-space-2);
  padding: var(--ds-space-1) 0;
  border-top: 1px solid var(--ds-border);
}
.hint:first-child {
  border-top: 0;
}
.icon {
  flex: none;
  width: 1.2em;
  text-align: center;
}
.hint.warn .icon {
  color: var(--ds-warning);
}
.hint.info .icon {
  color: var(--ds-text-2);
}
.body {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
}
.time {
  color: var(--ds-text-2);
  font-size: var(--ds-text-xs);
  font-variant-numeric: tabular-nums;
}
.jump,
.link {
  flex: none;
  height: 24px;
  padding: 0 var(--ds-space-2);
  border: 1px solid var(--ds-border);
  border-radius: var(--ds-radius-md);
  background: var(--ds-surface-1);
  color: var(--ds-text);
  font-size: var(--ds-text-xs);
  cursor: pointer;
}
.link {
  margin-left: var(--ds-space-1);
}
.jump:hover,
.link:hover {
  border-color: var(--ds-accent);
}
.jump:focus-visible,
.link:focus-visible {
  outline: none;
  box-shadow: var(--ds-focus-ring);
}
</style>
