<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import MediaPool from '@/components/timeline/MediaPool.vue'
import PreviewPlayer from '@/components/timeline/PreviewPlayer.vue'
import TimelineView from '@/components/timeline/TimelineView.vue'

// Der Export folgt in der nächsten Phase.
const { t } = useI18n()
</script>

<template>
  <div class="editor" data-testid="timeline-editor">
    <header class="editor-head">
      <h2>{{ t('timelineEditor.title') }}</h2>
      <RouterLink :to="{ name: 'classic' }">{{ t('timelineEditor.back') }}</RouterLink>
    </header>
    <div class="layout">
      <MediaPool class="side" />
      <PreviewPlayer />
    </div>
    <TimelineView />
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
.layout {
  display: grid;
  grid-template-columns: minmax(280px, 360px) 1fr;
  gap: var(--ds-gap);
  align-items: start;
}
</style>
