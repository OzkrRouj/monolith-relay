// ─────────────────────────────────────────────────────────────────────────────
//  relay.ts — Entrypoint del relay
//
//  Define el servidor Bun.serve(), los handlers de WebSocket
//  (open, message, close, error), el endpoint /health, el cleanup
//  periódico y el graceful shutdown.
//
//  El resto de la lógica vive en archivos separados:
//    config.ts        — Constantes
//    types.ts         — Interfaces
//    logger.ts        — Logging JSON
//    metrics.ts       — Contadores
//    validator.ts     — Validación UUID
//    rate-limiter.ts  — Token bucket
//    session-store.ts — CRUD de sesiones + cola
//    handlers/
//      join.ts        — Join handler
//      forward.ts     — Forward handler
// ─────────────────────────────────────────────────────────────────────────────

import { PORT, IDENTIFY_TIMEOUT_MS, PROTOCOL_VERSION } from './config';
import type { SessionData, RelayMessage } from './types';
import { log } from './logger';
import { metrics } from './metrics';
import { consumeToken } from './rate-limiter';
import {
  getSession,
  getSessionCounts,
  getIdentifyTimeout,
  setIdentifyTimeout,
  clearIdentifyTimeout,
  removeSocketFromSession,
  cleanupExpiredSessions,
  forEachSession,
} from './session-store';
import { handleJoin } from './handlers/join';
import { forwardMessage } from './handlers/forward';
import { CLEANUP_INTERVAL_MS } from './config';

const server = Bun.serve<SessionData>({
  port: PORT,

  websocket: {
    maxPayloadLength: 64 * 1024,
    idleTimeout: 0,
    sendPings: true,
    backpressureLimit: 1024 * 1024,
    closeOnBackpressureLimit: true,

    // ── Conexión nueva ──
    open(ws) {
      metrics.connectionsTotal++;
      log('connection_open', `remote=${ws.remoteAddress}`);

      const timeout = setTimeout(() => {
        if (!ws.data.sessionId) {
          log('connection_timeout', `remote=${ws.remoteAddress}`);
          ws.close(4001, 'Identification timeout');
        }
      }, IDENTIFY_TIMEOUT_MS);

      setIdentifyTimeout(ws, timeout);
    },

    // ── Mensaje recibido ──
    message(ws, rawData) {
      if (!ws.data.sessionId) {
        handleJoin(ws, rawData);
        return;
      }

      const session = getSession(ws.data.sessionId);
      if (!session) {
        ws.close(4009, 'Session not found');
        return;
      }

      if (!consumeToken(session)) {
        log('rate_limit_exceeded', `session=${ws.data.sessionId}`);
        ws.close(4005, 'Rate limit exceeded');
        return;
      }

      forwardMessage(ws, rawData);
    },

    // ── Cierre de conexión ──
    close(ws, code, reason) {
      metrics.connectionsTotal--;
      clearIdentifyTimeout(ws);

      const sessionId = ws.data.sessionId;
      if (!sessionId) {
        log('connection_closed_unidentified', `remote=${ws.remoteAddress} code=${code}`);
        return;
      }

      const session = getSession(sessionId);
      if (!session) {
        log('connection_closed_no_session', `session=${sessionId} code=${code}`);
        return;
      }

      log('connection_closed', `session=${sessionId} code=${code} reason=${reason}`);

      // Notificar al peer que su contraparte desconectó
      const peerMsg: RelayMessage = {
        type: 'peer_disconnected',
        code,
        reason: reason?.toString() ?? '',
      };
      const payload = JSON.stringify(peerMsg);

      for (const peer of session.sockets) {
        if (peer !== ws && peer.readyState === WebSocket.OPEN) {
          try { peer.send(payload); } catch { peer.terminate(); }
        }
      }

      removeSocketFromSession(session, sessionId, ws);
    },

    // ── Error en el socket ──
    error(ws, error) {
      log('socket_error', `session=${ws.data.sessionId || 'unknown'} error=${error.message}`);
      ws.terminate();
    },
  },

  // ── HTTP fetch (WebSocket upgrade + health check) ──
  fetch(req, server) {
    const url = new URL(req.url);

    if (url.pathname === '/health') {
      const counts = getSessionCounts();
      return new Response(
        JSON.stringify({
          status: 'ok',
          version: PROTOCOL_VERSION,
          uptime: Math.floor(process.uptime()),
          sessions: counts,
          connections: metrics.connectionsTotal,
          metrics: {
            messagesForwarded: metrics.messagesForwarded,
            messagesQueued: metrics.messagesQueued,
            messagesDropped: metrics.messagesDropped,
          },
          timestamp: new Date().toISOString(),
        }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    }

    const upgraded = server.upgrade(req, { data: { sessionId: '' } });
    if (upgraded) return undefined;
    return new Response('This server only accepts WebSocket connections', { status: 426 });
  },
});

log('server_start', `port=${PORT} protocol_version=${PROTOCOL_VERSION}`);

// ─── Limpieza periódica ──────────────────────────────────────────────────────
setInterval(cleanupExpiredSessions, CLEANUP_INTERVAL_MS);

// ─── Graceful shutdown ──────────────────────────────────────────────────────

process.on('SIGTERM', () => {
  log('shutdown', 'SIGTERM received, closing all sessions');

  forEachSession((sessionId, session) => {
    const msg = JSON.stringify({ type: 'server_shutdown' } satisfies RelayMessage);
    for (const ws of session.sockets) {
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(msg); } catch { /* ignorar */ }
      }
    }
  });

  setTimeout(() => {
    server.stop(true);
    log('shutdown', 'Server stopped');
    process.exit(0);
  }, 500);
});

process.on('SIGINT', () => {
  log('shutdown', 'SIGINT received');
  process.exit(0);
});
