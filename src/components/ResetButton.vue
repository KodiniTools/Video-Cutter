<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

/**
 * Knopf ↺ neben einem Regler: setzt ihn auf den Standardwert zurück.
 * `value` ist der Standard, wie er neben dem Regler angezeigt wird (für den
 * Tooltip). Klick und weitere Attribute (`data-testid` …) landen am Knopf.
 */
const props = defineProps<{ value: number | string; disabled?: boolean }>()

const { t, locale } = useI18n()
const label = computed(() =>
  t('timeline.resetValue', {
    value: typeof props.value === 'number' ? props.value.toLocaleString(locale.value) : props.value,
  }),
)
</script>

<template>
  <button type="button" class="reset" :disabled="disabled" :title="label" :aria-label="label">
    ↺
  </button>
</template>

<style scoped>
.reset {
  flex: none;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 1px solid var(--ds-border);
  border-radius: var(--ds-radius-sm);
  background: var(--ds-surface-0);
  color: var(--ds-text);
  font: inherit;
  font-size: var(--ds-text-sm);
  line-height: 1;
  cursor: pointer;
}
.reset:hover:not(:disabled) {
  border-color: var(--ds-accent);
  color: var(--ds-accent);
}
.reset:disabled {
  opacity: 0.35;
  cursor: default;
}
.reset:focus-visible {
  outline: none;
  box-shadow: var(--ds-focus-ring);
}
</style>
