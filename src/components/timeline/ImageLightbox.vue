<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

/**
 * Große Bildvorschau als modaler Dialog. Schließt per ✕, Esc oder Klick neben das Bild.
 * `src` ist das Original; lädt es nicht, wird `fallback` (kleines Vorschaubild) gezeigt.
 */
const props = defineProps<{
  src: string
  fallback?: string
  name: string
  details?: string
}>()
const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()

const dialogEl = ref<HTMLDialogElement | null>(null)
const current = ref(props.src)

function onError(): void {
  if (props.fallback && current.value !== props.fallback) current.value = props.fallback
}

function close(): void {
  emit('close')
}

/** Esc: der Elternteil entfernt den Dialog, nicht der Browser. */
function onCancel(e: Event): void {
  e.preventDefault()
  close()
}

/** Klick auf den Hintergrund (den Dialog selbst, nicht Bild/Kopfzeile) schließt. */
function onBackdrop(e: MouseEvent): void {
  if (e.target === e.currentTarget) close()
}

onMounted(() => {
  const d = dialogEl.value
  if (!d) return
  // showModal fehlt in alten Browsern/jsdom -> Fallback auf open-Attribut.
  if (typeof d.showModal === 'function') d.showModal()
  else d.setAttribute('open', '')
})
</script>

<template>
  <dialog
    ref="dialogEl"
    class="lightbox"
    data-testid="image-lightbox"
    :aria-label="name"
    @cancel="onCancel"
    @click="onBackdrop"
  >
    <div class="frame" @click.self="close">
      <figure class="figure">
        <img
          :src="current"
          :alt="name"
          class="img"
          data-testid="image-lightbox-img"
          @error="onError"
        />
        <figcaption class="caption">
          <span class="name" :title="name">{{ name }}</span>
          <span v-if="details" class="details">{{ details }}</span>
        </figcaption>
      </figure>
      <button
        type="button"
        class="close"
        :title="t('mediaPool.closeImage')"
        :aria-label="t('mediaPool.closeImage')"
        data-testid="image-lightbox-close"
        @click="close"
      >
        ✕
      </button>
    </div>
  </dialog>
</template>

<style scoped>
.lightbox {
  width: 100vw;
  max-width: 100vw;
  height: 100vh;
  max-height: 100vh;
  margin: 0;
  padding: 0;
  border: 0;
  background: transparent;
  overflow: hidden;
}
.lightbox::backdrop {
  background: rgb(0 0 0 / 0.78);
}
.frame {
  position: relative;
  display: grid;
  place-items: center;
  width: 100%;
  height: 100%;
  padding: 48px 16px 16px;
  box-sizing: border-box;
}
.figure {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  max-width: 100%;
  max-height: 100%;
  margin: 0;
}
.img {
  display: block;
  max-width: min(92vw, 100%);
  max-height: calc(100vh - 112px);
  object-fit: contain;
  border-radius: var(--ds-radius-md, 8px);
  background: repeating-conic-gradient(#d0d0d0 0% 25%, #f4f4f4 0% 50%) 0 0 / 16px 16px;
  box-shadow: 0 8px 32px rgb(0 0 0 / 0.5);
}
.caption {
  display: flex;
  gap: 8px;
  max-width: 92vw;
  color: #fff;
  font-size: var(--ds-text-sm, 14px);
}
.name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: var(--ds-weight-medium, 500);
}
.details {
  flex: none;
  opacity: 0.75;
  font-variant-numeric: tabular-nums;
}
.close {
  position: absolute;
  top: 8px;
  right: 12px;
  width: 36px;
  height: 36px;
  border: 1px solid rgb(255 255 255 / 0.4);
  border-radius: var(--ds-radius-full, 999px);
  background: rgb(0 0 0 / 0.5);
  color: #fff;
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
}
.close:hover {
  background: rgb(0 0 0 / 0.75);
}
.close:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px rgb(255 255 255 / 0.6);
}
</style>
