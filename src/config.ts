// ─────────────────────────────────────────────────────────────────────────────
//  config.ts — Constantes del relay
//  Todas las variables de configuración en un solo lugar.
//  Los valores se pueden overridear con variables de entorno.
// ─────────────────────────────────────────────────────────────────────────────

/** Puerto del relay. Traefik proxies WSS :443 → WS :3001. */
export const PORT = Number(process.env.PORT) || 3005;

/**
 * Versión del protocolo de join. Incrementar cuando cambie el
 * formato de los mensajes. El relay rechaza clientes con versión
 * diferente (close code 4008).
 */
export const PROTOCOL_VERSION = 1;

/** Tiempo máximo para completar el pairing (desde que el primer socket conecta). */
export const SESSION_PAIRING_TTL_MS = 5 * 60 * 1000;

/** Tiempo de vida de una sesión pareada. El usuario re-escannea el QR después. */
export const SESSION_PAIRED_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** Máximo de sesiones simultáneas en RAM. */
export const MAX_SESSIONS = 10_000;

/** Tamaño máximo de un mensaje individual (64KB). Los deltas de Monolith son <1KB. */
export const MAX_MSG_BYTES = 64 * 1024;

/** Tiempo máximo para que un cliente se identifique después de conectar el WebSocket. */
export const IDENTIFY_TIMEOUT_MS = 10_000;

/** Límite de mensajes por segundo POR CONEXIÓN (token bucket). */
export const RATE_LIMIT_MSGS_PER_SEC = 120;

/** Ráfaga máxima de mensajes consecutivos permitida (token bucket). */
export const RATE_LIMIT_BURST = 20;

/** Tamaño máximo de la cola de mensajes por sesión (FIFO drop cuando se llena). */
export const QUEUE_MAX_SIZE = 1000;

/** Intervalo de limpieza de sesiones expiradas (60 segundos). */
export const CLEANUP_INTERVAL_MS = 60_000;
