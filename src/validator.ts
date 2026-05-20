// ─────────────────────────────────────────────────────────────────────────────
//  validator.ts — Validación de session_id (UUID v4)
//  El desktop genera session_ids como UUID v4 estándar.
//  Esta regex valida formato EXACTO para evitar inyección en logs.
// ─────────────────────────────────────────────────────────────────────────────

const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Valida que un valor sea un string UUID v4 válido.
 * Sirve como type guard: si retorna true, TS lo trata como string.
 */
export function isValidSessionId(id: unknown): id is string {
  return typeof id === 'string' && UUID_V4_REGEX.test(id);
}
