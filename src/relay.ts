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
  setPulseState,
  clearPulseState as clearPulseStateInStore,
  markSessionRevoked,
} from './session-store';
import { handleJoin } from './handlers/join';
import { forwardMessage } from './handlers/forward';
import { CLEANUP_INTERVAL_MS, STATE_AUTH_SECRET } from './config';
import { getPulseState, setPulseState, clearPulseStateInStore } from './session-store';

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

      // Detectar mensajes de control antes de rate limit
      try {
        const text = typeof rawData === 'string' ? rawData : new TextDecoder().decode(rawData);
        const msg = JSON.parse(text);

        if (msg.type === 'unlink') {
          log('peer_unlink_requested', `session=${ws.data.sessionId}`);
          const unlinkMsg: RelayMessage = { type: 'device_unlinked', session_id: ws.data.sessionId };
          const payload = JSON.stringify(unlinkMsg);
          for (const peer of session.sockets) {
            if (peer !== ws && peer.readyState === WebSocket.OPEN) {
              try { peer.send(payload); } catch { peer.terminate(); }
            }
          }
          clearIdentifyTimeout(ws);
          removeSocketFromSession(session, ws.data.sessionId, ws);
          ws.close(4011, 'Unlinked');
          return;
        }

        if (msg.type === 'revoke') {
          log('device_revoked', `session=${ws.data.sessionId}`);
          markSessionRevoked(ws.data.sessionId);
          const revokeMsg: RelayMessage = { type: 'peer_revoked' };
          const payload = JSON.stringify(revokeMsg);
          for (const peer of session.sockets) {
            if (peer !== ws && peer.readyState === WebSocket.OPEN) {
              try { peer.send(payload); } catch { peer.terminate(); }
            }
          }
          for (const peer of session.sockets) {
            if (peer !== ws) {
              peer.close(4012, 'Device revoked');
            }
          }
          return;
        }
      } catch { /* continuar con flujo normal */ }

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

      // Si es un reemplazo intencional (4014), no notificar al peer
      // El join handler ya envió peer_connected con el nuevo socket
      if (code !== 4014) {
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
      }

      removeSocketFromSession(session, sessionId, ws);
    },

    // ── Error en el socket ──
    error(ws, error) {
      log('socket_error', `session=${ws.data.sessionId || 'unknown'} error=${error.message}`);
      ws.terminate();
    },
  },

  // ── HTTP fetch (WebSocket upgrade + health + state) ──
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

    // ── GET /state?sessionId=X ───────────────────────────────────────────
    // El companion consulta el estado de pulso del desktop vía HTTP.
    // Permite al widget nativo refrescarse sin abrir la app.
    if (req.method === 'GET' && url.pathname === '/state') {
      const sessionId = url.searchParams.get('sessionId');
      if (!sessionId) {
        return new Response('Missing sessionId', { status: 400 });
      }
      if (STATE_AUTH_SECRET) {
        const auth = req.headers.get('X-Monolith-Secret');
        if (auth !== STATE_AUTH_SECRET) {
          return new Response('Unauthorized', { status: 401 });
        }
      }
      const state = getPulseState(sessionId);
      return new Response(
        JSON.stringify({ ok: true, state: state ?? null }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    }

    // ── POST /state ──────────────────────────────────────────────────────
    // El desktop publica el estado de pulso actual.
    // El companion lo consulta para detectar cambios y refrescar el widget.
    if (req.method === 'POST' && url.pathname === '/state') {
      if (STATE_AUTH_SECRET) {
        const auth = req.headers.get('X-Monolith-Secret');
        if (auth !== STATE_AUTH_SECRET) {
          return new Response('Unauthorized', { status: 401 });
        }
      }
      try {
        const body = await req.json() as {
          session_id?: string;
          state?: {
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
          } | null;
        };
        if (!body.session_id) {
          return new Response('Missing session_id', { status: 400 });
        }
        if (body.state === null) {
          clearPulseStateInStore(body.session_id);
          log('pulse_state_cleared', `session=${body.session_id}`);
        } else if (body.state) {
          setPulseState(body.session_id, {
            ...body.state,
            lastUpdate: Date.now(),
          });
          log('pulse_state_updated', `session=${body.session_id} active=${body.state.isActive}`);
        }
        return new Response(JSON.stringify({ ok: true }), {
          headers: { 'Content-Type': 'application/json' },
        });
      } catch (e) {
        log('state_post_error', `error=${(e as Error).message}`);
        return new Response('Bad request', { status: 400 });
      }
    }

    const upgraded = server.upgrade(req, { data: { sessionId: '', deviceId: '' } });
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
