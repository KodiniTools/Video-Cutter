<script setup lang="ts">
import { useI18n } from 'vue-i18n'

// Platzhalter: Timeline-Ansicht, Vorschau und Export folgen in den nächsten Phasen.
const { t } = useI18n()
</script>

<template>
  <section class="beta" data-testid="timeline-editor">
    <h2>{{ t('timelineEditor.title') }}</h2>
    <p>{{ t('timelineEditor.placeholder') }}</p>
    <RouterLink :to="{ name: 'classic' }">{{ t('timelineEditor.back') }}</RouterLink>
  </section>
</template>

<style scoped>
.beta {
  display: flex;
  flex-direction: column;
  gap: var(--ds-space-3);
  padding: var(--ds-space-6);
  border: 1px solid var(--ds-border);
  border-radius: var(--ds-radius-md);
  background: var(--ds-surface-1);
}
.beta h2 {
  margin: 0;
  font-size: var(--ds-text-xl);
}
.beta p {
  margin: 0;
  color: var(--ds-text-2);
}
</style>
