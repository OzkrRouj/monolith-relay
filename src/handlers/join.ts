// ─────────────────────────────────────────────────────────────────────────────
//  join.ts — Handler del mensaje inicial "join"
//
//  El cliente DEBE enviar este mensaje inmediatamente después de conectar:
//    { "type": "join", "session_id": "uuid-v4", "version": 1 }
//
//  Si no lo hace en IDENTIFY_TIMEOUT_MS, se cierra la conexión.
//
//  Flujo:
//    1. Validar versión del protocolo
//    2. Validar session_id (UUID v4)
//    3. Crear sesión o unirse a existente
//    4. Si hay 2 sockets → pairing (notificar + drenar cola)
//    5. Si hay 1 socket → waiting
// ─────────────────────────────────────────────────────────────────────────────

import type { MonolithSocket } from '../types';
import type { RelayMessage } from '../types';
import { log } from '../logger';
import { isValidSessionId } from '../validator';
import { PROTOCOL_VERSION } from '../config';
import {
  clearIdentifyTimeout,
  getSession,
  createSession,
  pairSession,
  addSocketToSession,
  removeSocketFromSession,
  enqueueMessage,
  drainQueue,
  isSessionRevoked,
} from '../session-store';

/**
 * Procesa el mensaje de join de un cliente WebSocket.
 */
export function handleJoin(ws: MonolithSocket, rawData: string | Buffer): void {
  // 1. Limpiar timeout de identificación
  clearIdentifyTimeout(ws);

  // 2. Parsear JSON
  let msg: unknown;
  try {
    const text = typeof rawData === 'string' ? rawData : new TextDecoder().decode(rawData);
    msg = JSON.parse(text);
  } catch {
    ws.close(4003, 'Invalid JSON');
    return;
  }

  if (!msg || typeof msg !== 'object') {
    ws.close(4003, 'Invalid join message');
    return;
  }

  const join = msg as Record<string, unknown>;

  if (join.type !== 'join') {
    ws.close(4003, 'First message must be join');
    return;
  }

  // 3. Validar versión del protocolo
  const version = Number(join.version);
  if (version !== PROTOCOL_VERSION) {
    log('protocol_version_mismatch', `expected=${PROTOCOL_VERSION} received=${version}`);
    ws.close(4008, `Protocol version mismatch. Expected ${PROTOCOL_VERSION}, got ${version}`);
    return;
  }

  // 4. Validar session_id
  const sessionId = join.session_id;
  if (!isValidSessionId(sessionId)) {
    log('invalid_session_id', `remote=${ws.remoteAddress}`);
    ws.close(4004, 'Invalid session ID');
    return;
  }

  // 5. Verificar que la sesión no esté revocada
  if (isSessionRevoked(sessionId)) {
    log('session_revoked_rejected', `session=${sessionId}`);
    ws.close(4013, 'Session revoked');
    return;
  }

  // 6. Asignar session_id al socket (Bun data)
  ws.data = { sessionId };

  // 7. Buscar o crear sesión
  let session = getSession(sessionId);

  if (!session) {
    session = createSession(sessionId);
    if (!session) {
      // createSession ya emitió 'max_sessions_reached'
      ws.close(4006, 'Server full');
      return;
    }
  } else if (session.status === 'expired') {
    log('session_expired_rejected', `session=${sessionId}`);
    ws.close(4007, 'Session expired');
    return;
  } else if (session.sockets.size >= 2) {
    // Intentar reemplazar sockets muertos (readyState !== OPEN)
    let replaced = false;
    for (const existing of session.sockets) {
      if (existing.readyState !== WebSocket.OPEN) {
        log('replacing_dead_socket', `session=${sessionId}`);
        session.sockets.delete(existing);
        addSocketToSession(session, ws);
        replaced = true;

        // Si la sesión ya estaba paired, notificar reconexión al peer
        if (session.status === 'paired') {
          const connMsg: RelayMessage = { type: 'peer_connected', session_id: sessionId };
          const connPayload = JSON.stringify(connMsg);
          for (const s of session.sockets) {
            if (s !== ws && s.readyState === WebSocket.OPEN) {
              try { s.send(connPayload); } catch { s.terminate(); }
            }
          }
          drainQueue(session, ws);
        }
        break;
      }
    }
    if (!replaced) {
      log('session_full', `session=${sessionId}`);
      ws.close(4010, 'Session already has maximum peers');
      return;
    }
  }

  // 7. Agregar socket a la sesión
  addSocketToSession(session, ws);

  // 8. Si ahora hay 2 sockets → pairing completo
  if (session.sockets.size === 2) {
    pairSession(session, sessionId);

    // Notificar a AMBOS peers que el pairing se completó
    const pairMsg: RelayMessage = {
      type: 'session_paired',
      session_id: sessionId,
      paired_at: new Date(session.pairedAt!).toISOString(),
      expires_at: new Date(session.expiresAt).toISOString(),
    };
    const pairPayload = JSON.stringify(pairMsg);

    for (const s of session.sockets) {
      if (s.readyState === WebSocket.OPEN) {
        try { s.send(pairPayload); } catch { s.terminate(); }
      }
    }

    // Notificar peer_connected al socket que RECIÉN llegó
    const connMsg: RelayMessage = { type: 'peer_connected', session_id: sessionId };
    const connPayload = JSON.stringify(connMsg);

    for (const s of session.sockets) {
      if (s.readyState === WebSocket.OPEN) {
        try { s.send(connPayload); } catch { s.terminate(); }
      }
    }

    // 9. Drenar cola de mensajes acumulados
    // El socket que NO es el que recién llegó (ws) es quien debe
    // recibir los mensajes acumulados. Pero en realidad drenamos
    // hacia AMBOS por si alguno se perdió mensajes.
    drainQueue(session, ws);

  } else {
    // Solo 1 socket → waiting
    log('session_waiting', `session=${sessionId}`);
    const waitingMsg: RelayMessage = {
      type: 'session_paired',
      session_id: sessionId,
      paired_at: '',
      expires_at: new Date(session.expiresAt).toISOString(),
    };
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify(waitingMsg)); } catch { ws.terminate(); }
    }
  }
}
