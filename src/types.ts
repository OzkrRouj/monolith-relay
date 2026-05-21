// ─────────────────────────────────────────────────────────────────────────────
//  types.ts — Tipos compartidos del relay
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Datos que Bun asocia a cada socket WebSocket.
 * sessionId se setea en handleJoin(), hasta entonces es ''.
 */
export interface SessionData {
  sessionId: string;
}

/**
 * Representa una sesión entre dos dispositivos (desktop + companion).
 *
 * sockets:       Set de hasta 2 WebSockets
 * createdAt:     Timestamp de cuando el primer socket unió
 * pairedAt:      Timestamp de cuando el segundo socket unió (null si waiting)
 * expiresAt:     Timestamp de expiración
 * status:        waiting | paired | expired
 * messageQueue:  Cola FIFO para mensajes cuando un peer se desconecta
 * rateLimitTokens:    Tokens disponibles (token bucket)
 * lastTokenRefill:    Último refill del token bucket
 */
export interface Session {
  sockets: Set<ServerWebSocket<SessionData>>;
  createdAt: number;
  pairedAt: number | null;
  expiresAt: number;
  status: 'waiting' | 'paired' | 'expired';
  messageQueue: Array<{ data: string | Buffer; timestamp: number }>;
  rateLimitTokens: number;
  lastTokenRefill: number;
}

/** Tipo abreviado para ServerWebSocket con datos tipados. */
export type MonolithSocket = ServerWebSocket<SessionData>;

/** Mensajes internos que el relay envía a los peers (no confundir con mensajes E2E). */
export interface RelayMessage {
  type: 'peer_connected' | 'peer_disconnected' | 'peer_unlinked' | 'device_unlinked' | 'peer_revoked' | 'session_paired' | 'server_shutdown';
  session_id?: string;
  paired_at?: string;
  expires_at?: string;
  code?: number;
  reason?: string;
}

/** Contadores de métricas globales. */
export interface Metrics {
  messagesForwarded: number;
  messagesQueued: number;
  messagesDropped: number;
  connectionsTotal: number;
}
