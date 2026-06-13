// ─────────────────────────────────────────────────────────────────────────────
//  session-store.ts — Gestión de sesiones en RAM
//
//  Todo el estado del relay vive aquí: sessions Map, identifyTimeouts WeakMap,
//  y las operaciones CRUD sobre sesiones.
//
//  ¿Por qué Map y no objeto?
//    Map tiene O(1) en get/set/delete y no tiene prototype.
//    Para 10k sesiones, Map es la estructura correcta.
//
//  ¿Por qué WeakMap para timeouts?
//    ws.data está tipado con SessionData. Guardar un Timer ahí rompe el tipo.
//    WeakMap permite asociar datos externos sin modificar el tipo.
//    Además, cuando el socket se GC, WeakMap limpia solo.
// ─────────────────────────────────────────────────────────────────────────────

import type { Session, MonolithSocket } from './types';
import { log } from './logger';
import { metrics } from './metrics';
import {
  MAX_SESSIONS,
  SESSION_PAIRING_TTL_MS,
  SESSION_PAIRED_TTL_MS,
  QUEUE_MAX_SIZE,
} from './config';

/** Map<session_id, Session> — todo el estado en RAM. */
const sessions = new Map<string, Session>();

/** Set<session_id> — sesiones revocadas (no permitir reconexión). */
const revokedSessions = new Set<string>();

/** WeakMap para los timeouts de identificación de cada socket. */
const identifyTimeouts = new WeakMap<MonolithSocket, Timer>();

// ─── Estado de pulso por sesión (cache para que el companion lo consulte vía HTTP) ───

/**
 * Estado del pulso en una sesión. Escribido por el desktop vía HTTP POST /state.
 * El companion lo lee cada 5s vía GET /state para detectar cambios sin
 * necesidad de mantener un WebSocket nativo.
 */
export interface PulseState {
  isActive: boolean;
  isPaused: boolean;
  modo: string;
  fase: string;
  taskTitle: string;
  subtaskTitle: string;
  proyectoNombre: string;
  metaNombre: string;
  timerDuration: number;
  sessionStartTime: number;
  totalPausedTime: number;
  pauseStartTime: number;
  lastUpdate: number;
}

const pulseStates = new Map<string, PulseState>();

export function getPulseState(sessionId: string): PulseState | undefined {
  return pulseStates.get(sessionId);
}

export function setPulseState(sessionId: string, state: PulseState): void {
  pulseStates.set(sessionId, state);
}

export function clearPulseState(sessionId: string): void {
  pulseStates.delete(sessionId);
}

// ─── Getters ─────────────────────────────────────────────────────────────────

export function getSession(sessionId: string): Session | undefined {
  return sessions.get(sessionId);
}

export function getSessionCounts(): { total: number; waiting: number; paired: number } {
  let waiting = 0;
  let paired = 0;
  for (const s of sessions.values()) {
    if (s.status === 'paired') paired++;
    else if (s.status === 'waiting') waiting++;
  }
  return { total: sessions.size, waiting, paired };
}

export function getSessionSize(): number {
  return sessions.size;
}

export function hasReachedMaxSessions(): boolean {
  return sessions.size >= MAX_SESSIONS;
}

// ─── Timeouts de identificación ─────────────────────────────────────────────

export function getIdentifyTimeout(ws: MonolithSocket): Timer | undefined {
  return identifyTimeouts.get(ws);
}

export function setIdentifyTimeout(ws: MonolithSocket, timer: Timer): void {
  identifyTimeouts.set(ws, timer);
}

export function clearIdentifyTimeout(ws: MonolithSocket): void {
  const timer = identifyTimeouts.get(ws);
  if (timer) {
    clearTimeout(timer);
    identifyTimeouts.delete(ws);
  }
}

// ─── CRUD de sesiones ───────────────────────────────────────────────────────

/**
 * Crea una nueva sesión en estado 'waiting'.
 * Retorna la sesión creada, o null si se alcanzó MAX_SESSIONS.
 */
export function createSession(sessionId: string): Session | null {
  if (hasReachedMaxSessions()) {
    log('max_sessions_reached', `session=${sessionId}`);
    return null;
  }

  const session: Session = {
    sockets: new Set(),
    createdAt: Date.now(),
    pairedAt: null,
    expiresAt: Date.now() + SESSION_PAIRING_TTL_MS,
    status: 'waiting',
    messageQueue: [],
    rateLimitTokens: 20,
    lastTokenRefill: Date.now(),
  };
  sessions.set(sessionId, session);
  log('session_created', `session=${sessionId}`);
  return session;
}

/**
 * Marca una sesión como 'paired' y extiende su TTL.
 */
export function pairSession(session: Session, sessionId: string): void {
  const now = Date.now();
  session.pairedAt = now;
  session.expiresAt = now + SESSION_PAIRED_TTL_MS;
  session.status = 'paired';
  log('session_paired', `session=${sessionId}`);
}

/**
 * Agrega un socket a una sesión.
 */
export function addSocketToSession(session: Session, ws: MonolithSocket): void {
  session.sockets.add(ws);
}

/**
 * Remueve un socket de una sesión.
 * Si la sesión queda vacía, la elimina del Map.
 * Retorna true si la sesión fue eliminada.
 */
export function removeSocketFromSession(session: Session, sessionId: string, ws: MonolithSocket): boolean {
  session.sockets.delete(ws);
  if (session.sockets.size === 0) {
    sessions.delete(sessionId);
    log('session_cleaned', `session=${sessionId}`);
    return true;
  }
  return false;
}

/**
 * Elimina una sesión del Map y cierra sus sockets.
 */
export function deleteSession(sessionId: string, session: Session): void {
  for (const ws of session.sockets) {
    try {
      ws.send(JSON.stringify({ type: 'server_shutdown', reason: 'Session expired' }));
    } catch { /* ignorar */ }
    ws.close(4007, 'Session expired');
  }
  session.sockets.clear();
  sessions.delete(sessionId);
}

// ─── Cola de mensajes ───────────────────────────────────────────────────────

/**
 * Encola un mensaje en la sesión. Si la cola está llena, descarta
 * el más viejo (FIFO drop) e incrementa metrics.messagesDropped.
 */
export function enqueueMessage(session: Session, data: string | Buffer): void {
  if (session.messageQueue.length < QUEUE_MAX_SIZE) {
    session.messageQueue.push({ data, timestamp: Date.now() });
    metrics.messagesQueued++;
  } else {
    session.messageQueue.shift();
    session.messageQueue.push({ data, timestamp: Date.now() });
    metrics.messagesDropped++;
  }
}

/**
 * Drena la cola de mensajes hacia el socket especificado.
 * Usa cork() de Bun para agrupar múltiples sends en un syscall.
 */
export function drainQueue(session: Session, targetSocket: MonolithSocket): void {
  if (session.messageQueue.length === 0) return;

  log('draining_queue', `queued=${session.messageQueue.length}`);
  for (const queued of session.messageQueue) {
    if (targetSocket.readyState === WebSocket.OPEN) {
      try {
        targetSocket.cork(() => targetSocket.send(queued.data));
      } catch { targetSocket.terminate(); }
    }
  }
  session.messageQueue = [];
}

// ─── Limpieza periódica ─────────────────────────────────────────────────────

/**
 * Barre todas las sesiones y elimina las expiradas.
 * Se ejecuta cada CLEANUP_INTERVAL_MS.
 *
 * ¿Por qué no confiar solo en el TTL?
 *   Un cliente puede enviar join y desaparecer sin cerrar el socket.
 *   La sesión quedaría 'waiting' para siempre sin este cleanup.
 */
export function cleanupExpiredSessions(): void {
  const now = Date.now();
  let cleaned = 0;

  for (const [sessionId, session] of sessions) {
    if (now >= session.expiresAt || session.status === 'expired') {
      deleteSession(sessionId, session);
      cleaned++;
    }
  }

  if (cleaned > 0) {
    log('cleanup_completed', `removed=${cleaned} remaining=${sessions.size}`);
  }
}

// ─── Iteración para graceful shutdown ───────────────────────────────────────

/**
 * Itera sobre todas las sesiones para notificar server_shutdown.
 */
export function forEachSession(fn: (sessionId: string, session: Session) => void): void {
  for (const [sessionId, session] of sessions) {
    fn(sessionId, session);
  }
}

// ─── Sesiones revocadas ────────────────────────────────────────────────────

export function isSessionRevoked(sessionId: string): boolean {
  return revokedSessions.has(sessionId);
}

export function markSessionRevoked(sessionId: string): void {
  revokedSessions.add(sessionId);
}

export function unmarkSessionRevoked(sessionId: string): void {
  revokedSessions.delete(sessionId);
}
