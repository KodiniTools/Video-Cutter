<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useTimelineStore } from '@/stores/timeline'
import {
  FORMAT_GROUPS,
  FORMAT_PRESETS,
  findPreset,
  formatKey,
  formatLabel,
  ratioOf,
} from '@/timeline/formats'

/**
 * Projektformat des Timeline-Editors: Bildgröße, Bildrate und Hintergrund.
 * Das erste Video legt das Format fest; hier lässt es sich ändern (z. B.
 * Hochformat). Clips anderer Größe werden eingepasst, Ränder zeigen den
 * Hintergrund.
 */

const { t } = useI18n()
const store = useTimelineStore()

const RATES = [24, 25, 30, 50, 60] as const

const sizeKey = formatKey
const settings = computed(() => store.doc.settings)

/** Gängige Formate mit Plattformnamen, gruppiert nach Hoch-/Quadrat-/Querformat. */
const groups = FORMAT_GROUPS.map((group) => ({
  group,
  options: FORMAT_PRESETS.filter((p) => p.group === group).map((p) => ({
    key: formatKey(p),
    label: formatLabel(p),
  })),
}))

/** Aktuelles Format, falls es (vom Video übernommen) nicht in der Liste steht. */
const customSize = computed(() => {
  const s = settings.value
  if (findPreset(s)) return null
  return { key: formatKey(s), label: `${s.width} × ${s.height} (${ratioOf(s.width, s.height)})` }
})

const currentLabel = computed(() => {
  const preset = findPreset(settings.value)
  return preset ? formatLabel(preset) : (customSize.value?.label ?? '')
})
const rates = computed(() => {
  const fps = settings.value.fps
  const list: number[] = [...RATES]
  if (!list.includes(fps)) list.push(fps)
  return list.sort((a, b) => a - b)
})
const rateLabel = (fps: number) => String(Math.round(fps * 100) / 100).replace('.', ',')

function onSize(event: Event): void {
  const [width, height] = (event.target as HTMLSelectElement).value.split('x').map(Number)
  store.updateSettings({ width, height })
}

function onRate(event: Event): void {
  store.updateSettings({ fps: Number((event.target as HTMLSelectElement).value) })
}

function onBackground(event: Event): void {
  store.updateSettings({ background: (event.target as HTMLInputElement).value })
}
</script>

<template>
  <div class="project" data-testid="project-settings">
    <label>
      <span>{{ t('timelineProject.size') }}</span>
      <select
        :value="sizeKey(settings)"
        :title="currentLabel"
        class="size"
        data-testid="project-size"
        @change="onSize"
      >
        <option v-if="customSize" :value="customSize.key">
          {{ t('timelineProject.custom') }}: {{ customSize.label }}
        </option>
        <optgroup v-for="g in groups" :key="g.group" :label="t(`timelineProject.group.${g.group}`)">
          <option v-for="s in g.options" :key="s.key" :value="s.key">{{ s.label }}</option>
        </optgroup>
      </select>
    </label>
    <label>
      <span>{{ t('timelineProject.fps') }}</span>
      <select :value="settings.fps" data-testid="project-fps" @change="onRate">
        <option v-for="fps in rates" :key="fps" :value="fps">{{ rateLabel(fps) }}</option>
      </select>
    </label>
    <label :title="t('timelineProject.backgroundTitle')">
      <span>{{ t('timelineProject.background') }}</span>
      <input
        type="color"
        :value="settings.background"
        data-testid="project-background"
        @change="onBackground"
      />
    </label>
  </div>
</template>

<style scoped>
.project {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--ds-space-3);
  font-size: var(--ds-text-sm);
  color: var(--ds-text-2);
}
label {
  display: inline-flex;
  align-items: center;
  gap: var(--ds-space-2);
}
select {
  height: var(--ds-control-sm);
  padding: 0 var(--ds-space-2);
  border: 1px solid var(--ds-border);
  border-radius: var(--ds-radius-md);
  background: var(--ds-surface-2);
  color: var(--ds-text);
}
select.size {
  max-width: min(24rem, 60vw);
  text-overflow: ellipsis;
}
input[type='color'] {
  width: var(--ds-control-sm);
  height: var(--ds-control-sm);
  padding: 2px;
  border: 1px solid var(--ds-border);
  border-radius: var(--ds-radius-md);
  background: var(--ds-surface-2);
  cursor: pointer;
}
select:focus-visible,
input:focus-visible {
  outline: none;
  box-shadow: var(--ds-focus-ring);
}
</style>
