import {
  createRouter,
  createWebHistory,
  type RouteRecordRaw,
  type Router,
  type RouterHistory,
} from 'vue-router'
import TimelineEditorPage from '@/pages/TimelineEditorPage.vue'

/**
 * Routen der App.
 *  - `/`        Editor mit Timeline (Standard)
 *  - `/classic` bisheriger Editor (bleibt erreichbar, eigener Chunk)
 *  - `/editor`  frühere Adresse des Timeline-Editors, leitet auf `/` um
 * Unbekannte Adressen führen zum Editor.
 */
export const routes: RouteRecordRaw[] = [
  { path: '/', name: 'timeline', component: TimelineEditorPage },
  {
    path: '/classic',
    name: 'classic',
    // Eigener Chunk: belastet den Editor nicht.
    component: () => import('@/pages/ClassicEditorPage.vue'),
  },
  { path: '/editor', redirect: '/' },
  { path: '/:pathMatch(.*)*', redirect: '/' },
]

/** Router erzeugen; `history` ist für Tests austauschbar (Memory-History). */
export function createAppRouter(
  history: RouterHistory = createWebHistory(import.meta.env.BASE_URL),
): Router {
  return createRouter({ history, routes })
}
