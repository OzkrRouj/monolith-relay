# Monolith Relay

WebSocket relay server for Monolith Desktop <-> Companion sync. Messages are end-to-end encrypted — the relay only forwards bytes between paired peers. Zero dependencies (pure Bun runtime).

## Architecture

```
Desktop ──WS──> Monolith Relay ──WS──> Companion
                    |
               /state HTTP API
                    |
          (Pulse state cache)
```

- **Sessions:** Two devices (desktop + companion) share a session identified by a UUID v4.
- **Pairing:** First device joins (waiting). Second device joins (paired). Both get `session_paired`.
- **Forwarding:** Messages from one peer are forwarded to the other. If the peer is offline, messages queue (FIFO, max 1000).
- **State API:** Desktop publishes pulse state via HTTP POST `/state`. Companion reads it via GET `/state` (for widget refresh without WebSocket).
- **Reconnection:** If a device reconnects with the same `device_id`, the old socket is replaced (code 4014).
- **Revocation:** A device can send `revoke` to unlink the session permanently.
- **Unlink:** A device can send `unlink` to gracefully disconnect without revoking.

## Quick Start

```
bun install
bun run dev       # development with --watch
bun run start     # production
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3005` | Relay listening port |
| `STATE_AUTH_SECRET` | `''` | If set, HTTP `/state` requires `X-Monolith-Secret` header |

## Deployment (Dokploy)

1. Push this repo to GitHub.
2. In Dokploy, create a new service -> point to the repo.
3. Set environment variables: `PORT=3005`, `STATE_AUTH_SECRET=<your-secret>`.
4. Expose port 3005 (Traefik handles SSL termination).

## Protocol

### Join

Client sends immediately after WebSocket connects:

```json
{ "type": "join", "session_id": "<uuid-v4>", "device_id": "<unique-per-device>", "version": 1 }
```

### Relay messages (server -> client)

| Type | When |
|------|------|
| `session_paired` | Second device joined or first device joined (waiting) |
| `peer_connected` | Peer (re)connected |
| `peer_disconnected` | Peer disconnected |
| `peer_revoked` | Session revoked by the other peer |
| `device_unlinked` | Peer sent `unlink` |
| `server_shutdown` | Server shutting down (graceful) |

### Client messages

| Type | Action |
|------|--------|
| `join` | Identify and create/join session |
| `unlink` | Graceful disconnect without revocation |
| `revoke` | Permanently revoke the session (other peer gets `peer_revoked`) |

All other messages are transparently forwarded to the peer.

## HTTP Endpoints

### `GET /health`

Returns server status, version, session counts, and metrics.

### `GET /state?sessionId=<uuid>`

Returns the cached pulse state for a session (if `STATE_AUTH_SECRET` is set, requires `X-Monolith-Secret` header).

### `POST /state`

Desktop publishes pulse state for a session.

## License

MIT
