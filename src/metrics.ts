// ─────────────────────────────────────────────────────────────────────────────
//  metrics.ts — Contadores globales de métricas
//  Se exponen vía el endpoint /health.
// ─────────────────────────────────────────────────────────────────────────────

import type { Metrics } from './types';

export const metrics: Metrics = {
  messagesForwarded: 0,
  messagesQueued: 0,
  messagesDropped: 0,
  connectionsTotal: 0,
};
