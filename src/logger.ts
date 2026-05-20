// ─────────────────────────────────────────────────────────────────────────────
//  logger.ts — Logging estructurado en JSON
//  Los logs en JSON son parseables automáticamente por Dokploy.
//  Formato: {"t":"ISO","event":"nombre","detail":"..."}
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Emite un log estructurado en JSON a stdout.
 *
 * @param event  - Nombre del evento (sin espacios, kebab-case)
 * @param detail - Descripción opcional (key=value, separado por espacio)
 */
export function log(event: string, detail?: string): void {
  console.log(JSON.stringify({
    t: new Date().toISOString(),
    event,
    detail: detail ?? '',
  }));
}
