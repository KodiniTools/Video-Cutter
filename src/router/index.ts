import {
  createRouter,
  createWebHistory,
  type RouteRecordRaw,
  type Router,
  type RouterHistory,
} from 'vue-router'
import ClassicEditorPage from '@/pages/ClassicEditorPage.vue'
import { isTimelineEditorEnabled } from '@/lib/featureFlags'

/**
 * Routen der App.
 *  - `/`       bisheriger Editor (unverändert, bleibt Standard bis zur Gleichwertigkeit)
 *  - `/editor` neuer Timeline-Editor (Beta) – nur erreichbar, wenn freigeschaltet
 * Unbekannte Adressen führen zum bisherigen Editor.
 */
export const routes: RouteRecordRaw[] = [
  { path: '/', name: 'classic', component: ClassicEditorPage },
  {
    path: '/editor',
    name: 'timeline',
    // Eigener Chunk: belastet den bisherigen Editor nicht.
    component: () => import('@/pages/TimelineEditorPage.vue'),
    beforeEnter: () => (isTimelineEditorEnabled() ? true : { name: 'classic' }),
  },
  { path: '/:pathMatch(.*)*', redirect: '/' },
]

/** Router erzeugen; `history` ist für Tests austauschbar (Memory-History). */
export function createAppRouter(
  history: RouterHistory = createWebHistory(import.meta.env.BASE_URL),
): Router {
  return createRouter({ history, routes })
}
