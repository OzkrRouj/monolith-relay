# ─────────────────────────────────────────────────────────────────────────────
#  Dockerfile — Monolith Relay Server
#  Base: oven/bun:1.2-alpine
#  Runtime: Bun 1.2+  •  Zero dependencies
#
#  ¿Por qué oven/bun:alpine y no compilar a binario?
#    alpine es la imagen oficial más pequeña de Bun (~80MB).
#    Compilar con `bun build --compile` agregaría un paso sin
#    reducir significativamente el tamaño (el binario incluye
#    el runtime Bun completo, ~50MB). alpine ya es mínima.
#
#  ¿Por qué no alpine sin Bun y copiar el binario compilado?
#    Porque necesitaríamos Bun para compilar en el CI/CD.
#    Con multi-stage: builder (bun build --compile) → runtime
#    (alpine + binario). Para un relay de 400 líneas, la
#    imagen final sería ~55MB vs ~80MB — no vale la complejidad
#    extra. Si en el futuro el relay crece, se puede optimizar.
#
#  ¿Por qué USER bun?
#    La imagen oven/bun:alpine ya incluye el usuario `bun`
#    (uid 1000). No necesita ser creado. Correr como root
#    es mala práctica: si un atacante compromete el proceso,
#    tiene control total del contenedor.
#
#  ¿Por qué HEALTHCHECK?
#    Docker y Dokploy usan HEALTHCHECK para saber si el
#    contenedor responde. Si el relay se cuelga (no responde
#    en el puerto 3001), Docker lo reinicia automáticamente.
#    El endpoint /health devuelve 200 OK solo si el relay
#    está procesando requests.
#
#  ¿Por qué STOPSIGNAL SIGTERM?
#    Docker envía SIGTERM por defecto. Bun lo maneja para
#    un graceful shutdown. SIGKILL no da tiempo a notificar
#    a los peers.
# ─────────────────────────────────────────────────────────────────────────────

FROM oven/bun:1.2-alpine

# Etiquetas para identificación en Dokploy
LABEL maintainer="Monolith Sync <contact@ozkr.dev>"
LABEL description="Monolith Relay Server — WebSocket relay for Desktop ↔ Companion sync"
LABEL version="1.0.0"

# Puerto del relay (Traefik proxies WSS :443 → WS :3001)
EXPOSE 3001

# Usar el usuario no-root incluido en la imagen de Bun
USER bun

# Directorio de trabajo
WORKDIR /app

# Copiar todo el código fuente (estructura multi-archivo)
COPY src/ .

# Health check: cada 30s, timeout 5s, espera 5s al inicio, 3 fallos seguidos = unhealthy
# ¿Por qué wget y no curl?
#   wget viene preinstalado en alpine. curl no. Agregar curl
#   sería instalar un paquete solo para el health check.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3005/health || exit 1

# Docker envía SIGTERM por defecto — Bun lo maneja en el código
STOPSIGNAL SIGTERM

# Ejecutar el relay
# ¿Por qué CMD y no ENTRYPOINT?
#   CMD permite override en docker run sin cambiar el binario.
#   ENTRYPOINT fijaría el binario y CMD sería argumento.
#   Para un relay, CMD es suficiente.
CMD ["bun", "run", "relay.ts"]
