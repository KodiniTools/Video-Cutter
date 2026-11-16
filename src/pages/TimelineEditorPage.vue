<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import ExportDialog from '@/components/timeline/ExportDialog.vue'
import MediaPool from '@/components/timeline/MediaPool.vue'
import PreviewPlayer from '@/components/timeline/PreviewPlayer.vue'
import ProjectSettings from '@/components/timeline/ProjectSettings.vue'
import TextInspector from '@/components/timeline/TextInspector.vue'
import TimelineView from '@/components/timeline/TimelineView.vue'

import { useTimelineStore } from '@/stores/timeline'

const { t } = useI18n()
const store = useTimelineStore()
const exporting = ref(false)

function openExport(): void {
  store.playing = false
  exporting.value = true
}
</script>

<template>
  <div class="editor" data-testid="timeline-editor">
    <header class="editor-head">
      <h2>{{ t('timelineEditor.title') }}</h2>
      <span class="head-actions">
        <ProjectSettings />
        <RouterLink :to="{ name: 'classic' }">{{ t('timelineEditor.back') }}</RouterLink>
        <button
          type="button"
          class="export-btn"
          data-testid="open-export"
          :disabled="store.duration <= 0"
          :title="store.duration <= 0 ? t('timelineExport.empty') : undefined"
          @click="openExport"
        >
          {{ t('timelineExport.open') }}
        </button>
      </span>
    </header>
    <div class="layout">
      <div class="side">
        <MediaPool />
        <TextInspector />
      </div>
      <PreviewPlayer />
    </div>
    <TimelineView />
    <ExportDialog v-if="exporting" @close="exporting = false" />
  </div>
</template>

<style scoped>
.editor {
  display: flex;
  flex-direction: column;
  gap: var(--ds-space-4);
}
.editor-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--ds-space-4);
}
.editor-head h2 {
  margin: 0;
  font-size: var(--ds-text-xl);
}
.editor-head a {
  color: var(--ds-link);
  font-size: var(--ds-text-sm);
}
.head-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  align-items: center;
  gap: var(--ds-space-4);
}
.export-btn {
  height: var(--ds-control-sm);
  padding: 0 var(--ds-space-4);
  border: 1px solid var(--ds-accent);
  border-radius: var(--ds-radius-md);
  background: var(--ds-accent);
  color: var(--ds-on-accent);
  font-weight: var(--ds-weight-semibold);
  cursor: pointer;
}
.export-btn:disabled {
  opacity: 0.45;
  cursor: default;
}
.export-btn:focus-visible {
  outline: none;
  box-shadow: var(--ds-focus-ring);
}
.side {
  display: flex;
  flex-direction: column;
  gap: var(--ds-gap);
  min-width: 0;
}
.layout {
  display: grid;
  grid-template-columns: minmax(280px, 360px) 1fr;
  gap: var(--ds-gap);
  align-items: start;
}
</style>
