// ─────────────────────────────────────────────────────────────────────────────
//  forward.ts — Reenvío de mensajes entre peers
//
//  Cuando un socket ya identificado envía un mensaje:
//    1. Buscar el peer en la sesión
//    2. Si está conectado y su buffer no tiene backpressure → enviar directo
//    3. Si no hay peer o hay error → encolar
//    4. Si la cola está llena → FIFO drop
//
//  ¿Por qué encolar y no descartar?
//    Para desconexiones breves (< 1 minuto), la cola permite no perder mensajes.
//    Si descartáramos, la companion pediría un snapshot completo cada vez que
//    se desconecta 1 segundo — mucho más pesado que los deltas perdidos.
// ─────────────────────────────────────────────────────────────────────────────

import type { MonolithSocket } from '../types';
import { metrics } from '../metrics';
import { getSession, enqueueMessage } from '../session-store';

/**
 * Reenvía un mensaje del emisor al peer de la sesión.
 * Si el peer no está disponible, encola el mensaje.
 */
export function forwardMessage(ws: MonolithSocket, rawData: string | Buffer): void {
  const session = getSession(ws.data.sessionId);
  if (!session) {
    ws.close(4009, 'Session not found');
    return;
  }

  // Buscar el peer (el otro socket de la sesión)
  let peer: MonolithSocket | null = null;
  for (const s of session.sockets) {
    if (s !== ws) { peer = s; break; }
  }

  if (!peer) {
    // No hay peer — encolar
    enqueueMessage(session, rawData);
    return;
  }

  if (peer.readyState !== WebSocket.OPEN) {
    // Peer conectado pero no OPEN — cerrarlo y encolar
    peer.terminate();
    session.sockets.delete(peer);
    enqueueMessage(session, rawData);
    return;
  }

  // Peer conectado y listo — enviar directo con cork()
  try {
    // cork() agrupa el send en el buffer de salida y lo envía
    // en un solo syscall. Para relays con alto throughput,
    // esto reduce syscalls significativamente.
    peer.cork(() => peer.send(rawData));
    metrics.messagesForwarded++;
  } catch {
    // Si el envío falla (backpressure, error interno), encolar
    enqueueMessage(session, rawData);
  }
}
