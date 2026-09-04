#!/usr/bin/env bash
# Build the Acta Docker image from local artifacts (dev links @nubisco/ui from
# the sibling checkout, so the SPA must be built where that link resolves).
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> building web SPA"
pnpm -C web build

echo "==> bundling server"
rm -rf server/dist
(cd server && bun build src/index.ts --target=bun --outdir=dist)

echo "==> docker build"
docker build -t ghcr.io/nubisco/acta:latest .

echo "done: ghcr.io/nubisco/acta:latest"
