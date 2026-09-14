# Install

Acta is one process. It serves the API, the MCP endpoint and the web app from
a single port, and keeps everything in SQLite plus a directory of attachments.
There is no separate database server, queue or cache to run.

## With Docker

The quickest route. Create a `docker-compose.yml`:

```yaml
services:
  acta:
    image: ghcr.io/nubisco/acta:latest
    pull_policy: always
    container_name: acta
    restart: unless-stopped
    ports:
      - '4460:4460'
    environment:
      TZ: Europe/Lisbon
      ACTA_WORKSPACE: Acme
      # The first administrator. Required when signing in with email codes,
      # because somebody has to be able to invite everyone else.
      ACTA_ADMIN_EMAIL: you@example.com
      ACTA_ADMIN_HANDLE: you
      ACTA_ADMIN_NAME: Your Name
    volumes:
      - acta-data:/data
    healthcheck:
      test:
        - CMD
        - bun
        - -e
        - "fetch('http://localhost:4460/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
      interval: 30s
      timeout: 5s

volumes:
  acta-data:
```

Then:

```sh
docker compose up -d
```

Acta is on <http://localhost:4460>. Sign in with the admin email you set; by
default the one-time code is **printed to the container log**:

```sh
docker compose logs -f acta
```

::: warning The default code sender is for getting started
`[acta] OTP for you@example.com: 123456` in the log means anyone who can read
your logs can sign in as anyone. Before you let other people in, either
configure an email sender or put an
[identity provider](/developers/authentication) in front.
:::

### Data

Everything lives in the `/data` volume: `acta.sqlite` and an `attachments/`
directory. Back up the volume and you have backed up Acta. Stop the container
first, or copy the SQLite file with `sqlite3 .backup` rather than `cp`, so you
do not capture a half-written page.

## Behind a reverse proxy

Acta sets `Secure` on its session cookie, so it must be reached over HTTPS from
anywhere but localhost. A minimal Caddy config:

```text
acta.example.com {
  reverse_proxy localhost:4460
}
```

Set `ACTA_BASE_URL=https://acta.example.com` so links in outbound
notifications point somewhere that works.

## On Cloudflare Workers

Acta also runs on Workers with D1 for the database and R2 for attachments.
This is how the hosted instance runs. `server/wrangler.toml` in the repository
is a working example; the parts that matter are:

```toml
name = "acta"
main = "src/worker.ts"
compatibility_date = "2026-08-01"

[assets]
directory = "../web/dist"
binding = "ASSETS"
run_worker_first = true
html_handling = "none"
not_found_handling = "none"

[[d1_databases]]
binding = "DB"
database_name = "acta"
database_id = "..."

[[r2_buckets]]
binding = "ATTACHMENTS"
bucket_name = "acta-attachments"
```

`run_worker_first` and `html_handling = "none"` are both load-bearing: the
worker has to see every request in order to hand a signed-out visitor to your
identity provider before any HTML is served.

Build the SPA and deploy:

```sh
pnpm -C web build
pnpm -C server exec wrangler deploy
```

The schema migrates itself on first request, so there is no migration step to
run. See [Configuration](/developers/configuration) for the variables.

## From source

Requires [Bun](https://bun.sh) and pnpm.

```sh
git clone https://github.com/nubisco/acta
cd acta
pnpm install
pnpm dev            # server on :4460, web dev server on :5173
```

For a production build outside Docker:

```sh
pnpm build
ACTA_DATA_DIR=./data ACTA_WEB_DIST=./web/dist bun server/dist/index.js
```

## Upgrading

Pull the new image and restart. Acta migrates its own schema on boot: new
tables are created, new columns added, and the few changes SQLite cannot make
in place are applied behind a guard so they run exactly once.

```sh
docker compose pull && docker compose up -d
```

Take a backup first. Migrations are tested against databases in the old shape,
but a backup is cheaper than trust.
