<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import RangeSpinner from './RangeSpinner.vue'
import { BEATS_UNSUPPORTED } from '@/lib/beatsApi'
import { useTimelineStore } from '@/stores/timeline'
import { useTimelineBeatsStore } from '@/stores/timelineBeats'
import { BEAT_GRIDS, GRID_STEP, MAX_BEAT_OFFSET, beatSourceClip } from '@/timeline/beats'
import { MARKER_EFFECTS, type MarkerEffectKind, type OpError } from '@/timeline/model'

/**
 * Schnitt im Takt: Takt des markierten Musik- bzw. Video-Clips erkennen, das
 * Raster prüfen (Linien auf der Timeline, Einrasten) und übernehmen – als
 * Takt-Marker (mit Drop-Effekt) oder als Schnitte auf einer Video-Spur.
 */
const { t, locale } = useI18n()
const store = useTimelineStore()
const beats = useTimelineBeatsStore()

/** Markierter Clip, dessen Takt sich erkennen lässt (Ton bzw. Video mit Ton). */
const candidate = computed(() => {
  const sel = store.selectedClips
  if (sel.length === 0 || sel.length > 2) return null
  // Bild + verknüpfter Ton: der Ton-Clip zählt (gleiche Quelle).
  const pick = sel.find((c) => c.kind === 'audio') ?? sel[0]
  return beatSourceClip(store.doc, pick.id)
})

const active = computed(() => beats.analysis !== null || beats.loading || beats.error !== '')
const visible = computed(() => candidate.value !== null || active.value)

const assetName = (assetId: string) => store.doc.assets[assetId]?.name ?? ''
const sourceName = computed(() => {
  const c = beats.sourceClip
  return c && (c.kind === 'audio' || c.kind === 'video') ? assetName(c.asset) : ''
})
/** Markiert ist ein anderer Clip als der mit dem Raster. */
const otherSelected = computed(
  () => candidate.value !== null && candidate.value.id !== beats.clipId,
)

const errorText = computed(() =>
  beats.error === BEATS_UNSUPPORTED ? t('timeline.beats.outdated') : beats.error,
)
const bpmText = computed(() =>
  (beats.analysis?.bpm ?? 0).toLocaleString(locale.value, { maximumFractionDigits: 1 }),
)
const noBeat = computed(() => beats.analysis !== null && beats.analysis.beats.length === 0)
const sourceGone = computed(
  () => beats.analysis !== null && beats.clipId !== null && beats.sourceClip === null,
)

const step = computed(() => GRID_STEP[beats.grid])
/** „Beginnt bei Schlag“ als 1 … Schritt. */
const shiftOptions = computed(() =>
  step.value > 1 ? Array.from({ length: step.value }, (_, i) => i) : [],
)
watch(step, (s) => {
  if (beats.shift >= s) beats.shift = 0
})

const maxOffsetMs = MAX_BEAT_OFFSET / 1000
function onOffset(e: Event): void {
  const v = Number((e.target as HTMLInputElement).value)
  if (Number.isFinite(v)) beats.offsetMs = Math.max(-maxOffsetMs, Math.min(maxOffsetMs, v))
}

async function detect(): Promise<void> {
  const c = candidate.value
  if (!c) return
  note.value = ''
  await beats.detect(c.id)
}

// --- Übernehmen ----------------------------------------------------------------

const effect = ref<MarkerEffectKind | ''>('')
const note = ref('')
const noteWarn = ref(false)

const videoTracks = computed(() =>
  store.doc.tracks.filter((tr) => tr.kind === 'video' && tr.clips.length > 0),
)
const trackId = ref('')
watch(
  videoTracks,
  (tracks) => {
    if (!tracks.some((tr) => tr.id === trackId.value)) trackId.value = tracks[0]?.id ?? ''
  },
  { immediate: true },
)

function reason(error: OpError): string {
  const known = ['track-locked', 'overlap', 'too-many'] as const
  const key = (known as readonly string[]).includes(error) ? error : 'other'
  return t('timeline.beats.failed', { reason: t(`timeline.beats.reasons.${key}`) })
}

function show(text: string, warn = false): void {
  note.value = text
  noteWarn.value = warn
}

function applyMarkers(): void {
  const r = beats.applyMarkers(effect.value || null)
  if ('error' in r) return show(reason(r.error), true)
  const { added, dropped } = r.info
  if (added === 0 && dropped === 0) return show(t('timeline.beats.markersNone'))
  let text = t('timeline.beats.markersAdded', { n: added })
  if (dropped > 0) text += ` ${t('timeline.beats.markersDropped', { n: dropped })}`
  show(text, dropped > 0)
}

function removeMarkers(): void {
  const r = beats.removeMarkers()
  if ('error' in r) return show(reason(r.error), true)
  show(t('timeline.beats.markersRemoved', { n: r.info.removed }))
}

function fit(): void {
  if (!trackId.value) return
  const r = beats.fitClips(trackId.value)
  if ('error' in r) return show(reason(r.error), true)
  show(
    r.info.fitted > 0
      ? t('timeline.beats.fitted', { n: r.info.fitted })
      : t('timeline.beats.fitNone'),
  )
}

function split(): void {
  if (!trackId.value) return
  const r = beats.splitClips(trackId.value)
  if ('error' in r) return show(reason(r.error), true)
  show(
    r.info.cuts > 0
      ? t('timeline.beats.splitDone', { n: r.info.cuts })
      : t('timeline.beats.splitNone'),
  )
}

const canApply = computed(() => beats.times.length > 0)
</script>

<template>
  <section v-if="visible" class="inspector" data-testid="beat-panel">
    <h3>{{ t('timeline.beats.title') }}</h3>
    <p v-if="!beats.analysis" class="hint">{{ t('timeline.beats.intro') }}</p>

    <button
      v-if="candidate && (!beats.analysis || otherSelected)"
      type="button"
      class="btn primary"
      data-testid="beat-detect"
      :disabled="beats.loading"
      @click="detect"
    >
      {{
        beats.loading
          ? t('timeline.beats.detecting')
          : beats.analysis
            ? t('timeline.beats.again')
            : t('timeline.beats.detect')
      }}
    </button>
    <p v-else-if="!beats.analysis && !beats.loading" class="hint">
      {{ t('timeline.beats.pick') }}
    </p>
    <p v-if="errorText" class="hint warn" role="alert" data-testid="beat-error">
      {{ errorText }}
    </p>

    <template v-if="beats.analysis">
      <p class="name" :title="sourceName">{{ t('timeline.beats.source', { name: sourceName }) }}</p>
      <p v-if="sourceGone" class="hint warn" data-testid="beat-source-gone">
        {{ t('timeline.beats.sourceGone') }}
      </p>
      <p v-else-if="noBeat" class="hint warn" data-testid="beat-none">
        {{ t('timeline.beats.none') }}
      </p>
      <template v-else>
        <p class="result" data-testid="beat-result">
          {{ t('timeline.beats.result', { bpm: bpmText, n: beats.analysis.beats.length }) }}
        </p>
        <label class="field">
          <span>{{ t('timeline.beats.grid') }}</span>
          <select v-model="beats.grid" data-testid="beat-grid">
            <option v-for="g in BEAT_GRIDS" :key="g" :value="g">
              {{ t(`timeline.beats.grids.${g}`) }}
            </option>
          </select>
        </label>
        <label v-if="shiftOptions.length" class="field">
          <span>{{ t('timeline.beats.shift') }}</span>
          <select v-model.number="beats.shift" data-testid="beat-shift">
            <option v-for="i in shiftOptions" :key="i" :value="i">{{ i + 1 }}</option>
          </select>
        </label>
        <label class="field">
          <span>{{ t('timeline.beats.offset') }}</span>
          <RangeSpinner
            :min="-maxOffsetMs"
            :max="maxOffsetMs"
            step="5"
            :value="beats.offsetMs"
            :reset="0"
            data-testid="beat-offset"
            @input="onOffset"
          />
          <small class="hint">{{ t('timeline.beats.offsetHint') }}</small>
        </label>
        <label class="check">
          <input v-model="beats.showGrid" type="checkbox" data-testid="beat-show" />
          <span>{{ t('timeline.beats.show') }}</span>
        </label>
        <p class="hint" data-testid="beat-points">
          {{ t('timeline.beats.points', { n: beats.times.length }) }}
        </p>

        <fieldset class="group">
          <legend>{{ t('timeline.beats.markersTitle') }}</legend>
          <label class="field">
            <span>{{ t('timeline.beats.effect') }}</span>
            <select v-model="effect" data-testid="beat-effect">
              <option value="">{{ t('timeline.beats.noEffect') }}</option>
              <option v-for="k in MARKER_EFFECTS" :key="k" :value="k">
                {{ t(`timeline.marker.effect.kinds.${k}`) }}
              </option>
            </select>
          </label>
          <button
            type="button"
            class="btn"
            data-testid="beat-apply-markers"
            :disabled="!canApply"
            @click="applyMarkers"
          >
            {{ t('timeline.beats.applyMarkers') }}
          </button>
          <button
            v-if="beats.beatMarkers > 0"
            type="button"
            class="btn"
            data-testid="beat-remove-markers"
            @click="removeMarkers"
          >
            {{ t('timeline.beats.removeMarkers', { n: beats.beatMarkers }) }}
          </button>
          <small class="hint">{{ t('timeline.beats.markersNote') }}</small>
        </fieldset>

        <fieldset v-if="videoTracks.length" class="group">
          <legend>{{ t('timeline.beats.cutsTitle') }}</legend>
          <label v-if="videoTracks.length > 1" class="field">
            <span>{{ t('timeline.beats.track') }}</span>
            <select v-model="trackId" data-testid="beat-track">
              <option v-for="tr in videoTracks" :key="tr.id" :value="tr.id">{{ tr.name }}</option>
            </select>
          </label>
          <button
            type="button"
            class="btn"
            data-testid="beat-fit"
            :title="t('timeline.beats.fitTitle')"
            :disabled="!canApply || !trackId"
            @click="fit"
          >
            {{ t('timeline.beats.fit') }}
          </button>
          <small class="hint">{{ t('timeline.beats.fitTitle') }}</small>
          <button
            type="button"
            class="btn"
            data-testid="beat-split"
            :title="t('timeline.beats.splitTitle')"
            :disabled="!canApply || !trackId"
            @click="split"
          >
            {{ t('timeline.beats.split') }}
          </button>
        </fieldset>
      </template>
      <p v-if="note" class="hint" :class="{ warn: noteWarn }" role="status" data-testid="beat-note">
        {{ note }}
      </p>
      <button type="button" class="btn link" data-testid="beat-clear" @click="beats.clear()">
        {{ t('timeline.beats.clear') }}
      </button>
    </template>
  </section>
</template>

<style scoped>
.inspector {
  display: flex;
  flex-direction: column;
  gap: var(--ds-space-3);
  padding: var(--ds-space-4);
  border: 1px solid var(--ds-border);
  border-radius: var(--ds-radius-lg);
  background: var(--ds-surface-1);
  font-size: var(--ds-text-sm);
}
h3 {
  margin: 0;
  font-size: var(--ds-text-md, var(--ds-text-sm));
  font-weight: var(--ds-weight-semibold);
}
.name {
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.result {
  margin: 0;
  font-weight: var(--ds-weight-semibold);
  font-variant-numeric: tabular-nums;
}
.field {
  display: flex;
  flex-direction: column;
  gap: var(--ds-space-1, 4px);
  min-width: 0;
  color: var(--ds-text-2);
}
.check {
  display: flex;
  align-items: center;
  gap: var(--ds-space-2);
  color: var(--ds-text-2);
}
.group {
  display: flex;
  flex-direction: column;
  gap: var(--ds-space-2);
  margin: 0;
  padding: var(--ds-space-3) 0 0;
  border: 0;
  border-top: 1px solid var(--ds-border);
  color: var(--ds-text-2);
}
.group legend {
  padding: 0;
  font-weight: var(--ds-weight-semibold);
  color: var(--ds-text);
}
.hint {
  margin: 0;
  color: var(--ds-text-2);
  line-height: 1.5;
}
.hint.warn {
  color: var(--ds-danger, #b3261e);
}
.btn {
  padding: var(--ds-space-2) var(--ds-space-3);
  border: 1px solid var(--ds-border);
  border-radius: var(--ds-radius-md);
  background: var(--ds-surface-2);
  color: inherit;
  font: inherit;
  cursor: pointer;
  text-align: center;
}
.btn.primary {
  border-color: var(--ds-accent);
  color: var(--ds-accent);
  font-weight: var(--ds-weight-semibold);
}
.btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.btn.link {
  align-self: flex-start;
  padding: 0;
  border: 0;
  background: none;
  color: var(--ds-link);
}
</style>
