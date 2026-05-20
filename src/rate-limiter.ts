// ─────────────────────────────────────────────────────────────────────────────
//  rate-limiter.ts — Token bucket por conexión
//
//  Cada sesión tiene un token bucket que limita a RATE_LIMIT_MSGS_PER_SEC
//  mensajes por segundo, con un burst máximo de RATE_LIMIT_BURST.
//
//  ¿Token bucket y no sliding window?
//    Token bucket permite ráfagas cortas (burst) mientras limita el promedio.
//    Para un relay es ideal: 20 mensajes al reconectar es normal,
//    pero 200 msg/s sostenido no lo es. Sliding window es más justo
//    pero más costoso (requiere array de timestamps por conexión).
//
//  Fórmula: tokens = min(burst, tokens + Δt * rate / 1000)
// ─────────────────────────────────────────────────────────────────────────────

import type { Session } from './types';
import { RATE_LIMIT_MSGS_PER_SEC, RATE_LIMIT_BURST } from './config';

/**
 * Refill de tokens basado en tiempo transcurrido desde el último mensaje.
 * Se llama en cada mensaje entrante.
 */
function refillTokens(session: Session, now: number): void {
  const elapsed = now - session.lastTokenRefill;
  const tokensToAdd = Math.floor(elapsed * RATE_LIMIT_MSGS_PER_SEC / 1000);
  if (tokensToAdd > 0) {
    session.rateLimitTokens = Math.min(
      RATE_LIMIT_BURST,
      session.rateLimitTokens + tokensToAdd,
    );
    session.lastTokenRefill = now;
  }
}

/**
 * Intenta consumir un token del bucket de la sesión.
 * Retorna true si hay tokens disponibles, false si se excedió el límite.
 */
export function consumeToken(session: Session): boolean {
  const now = Date.now();
  refillTokens(session, now);
  if (session.rateLimitTokens > 0) {
    session.rateLimitTokens--;
    return true;
  }
  return false;
}
