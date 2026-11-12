/**
 * Basis-URL des Backends.
 * - Produktion: VITE_API_BASE=/video-cutter -> Aufrufe unter /video-cutter/api/*
 * - Entwicklung: leer lassen, Vite proxyt /api auf den Dev-Server.
 */
export const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? ''
