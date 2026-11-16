<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useTimelineStore } from '@/stores/timeline'

/**
 * Projektformat des Timeline-Editors: Bildgröße, Bildrate und Hintergrund.
 * Das erste Video legt das Format fest; hier lässt es sich ändern (z. B.
 * Hochformat). Clips anderer Größe werden eingepasst, Ränder zeigen den
 * Hintergrund.
 */

const { t } = useI18n()
const store = useTimelineStore()

const SIZES = [
  { width: 1920, height: 1080, ratio: '16:9' },
  { width: 1280, height: 720, ratio: '16:9' },
  { width: 3840, height: 2160, ratio: '16:9' },
  { width: 1080, height: 1920, ratio: '9:16' },
  { width: 1080, height: 1080, ratio: '1:1' },
  { width: 1080, height: 1350, ratio: '4:5' },
] as const
const RATES = [24, 25, 30, 50, 60] as const

const sizeKey = (s: { width: number; height: number }) => `${s.width}x${s.height}`
const settings = computed(() => store.doc.settings)

/** Feste Auswahl plus das aktuelle Format, falls es (vom Video übernommen) nicht dabei ist. */
const sizes = computed(() => {
  const current = settings.value
  const list: Array<{ key: string; label: string }> = SIZES.map((s) => ({
    key: sizeKey(s),
    label: `${s.width} × ${s.height} (${s.ratio})`,
  }))
  if (!list.some((s) => s.key === sizeKey(current)))
    list.unshift({ key: sizeKey(current), label: `${current.width} × ${current.height}` })
  return list
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
      <select :value="sizeKey(settings)" data-testid="project-size" @change="onSize">
        <option v-for="s in sizes" :key="s.key" :value="s.key">{{ s.label }}</option>
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
