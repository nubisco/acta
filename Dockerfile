# Acta self-host image. The SPA and the server bundle are built OUTSIDE the
# image (scripts/build-image.sh) because dev consumes @nubisco/ui via a local
# pnpm link; the image only ships runtime artifacts.
# An exact Bun, never a floating tag: a floating tag hides which runtime an
# image ships, and a cached layer can keep serving an old one. Bump it on a Bun
# security release and rebuild.
FROM oven/bun:1.4.4-slim

WORKDIR /app

COPY server/dist/index.js ./server.js
COPY web/dist ./web

ENV ACTA_DATA_DIR=/data \
    ACTA_WEB_DIST=/app/web \
    ACTA_PORT=4460 \
    TZ=Europe/Lisbon

VOLUME /data
EXPOSE 4460

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD bun -e "fetch('http://localhost:4460/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

CMD ["bun", "server.js"]
