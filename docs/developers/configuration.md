# Configuration

Everything is an environment variable. Nothing is required to boot, but an
instance with no `ACTA_ADMIN_EMAIL` and no identity provider has no way for
anyone to sign in.

## Core

| Variable         | Default     | What it does                                                                                                                         |
| ---------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `ACTA_WORKSPACE` | `Workspace` | The workspace name. Its slug becomes the URL segment.                                                                                |
| `ACTA_DATA_DIR`  | `./data`    | Where `acta.sqlite` and `attachments/` live. Not used on Workers.                                                                    |
| `ACTA_PORT`      | `4460`      | Listen port. Not used on Workers.                                                                                                    |
| `ACTA_WEB_DIST`  | _unset_     | Directory of the built SPA. Without it the server serves the API only.                                                               |
| `ACTA_BASE_URL`  | _unset_     | Acta's public address. Used to turn a card key into a link in outbound messages; everything works without it, just without the link. |

## The first administrator

| Variable            | Default                | What it does                          |
| ------------------- | ---------------------- | ------------------------------------- |
| `ACTA_ADMIN_EMAIL`  | _unset_                | Seeds an administrator on first boot. |
| `ACTA_ADMIN_HANDLE` | derived from the email | Their `@handle`.                      |
| `ACTA_ADMIN_NAME`   | the handle             | Their display name.                   |

These matter when you sign in with one-time codes, because otherwise nobody can
administer anything. With an identity provider configured they are optional:
no admin is seeded, and the first person the provider vouches for becomes the
administrator of the empty workspace. That promotion only ever happens into a
vacuum, so it cannot be used to escalate later.

## Identity

See [Authentication](/developers/authentication) for the whole picture.

### OpenID Connect (recommended)

| Variable                   | Default                | What it does                                                                             |
| -------------------------- | ---------------------- | ---------------------------------------------------------------------------------------- |
| `ACTA_OIDC_ISSUER`         | _unset_                | Your provider's issuer URL. Setting this and a client id turns OIDC on.                  |
| `ACTA_OIDC_CLIENT_ID`      | _unset_                | The client you registered for Acta.                                                      |
| `ACTA_OIDC_CLIENT_SECRET`  | _unset_                | Omit for a public client; PKCE still protects the exchange.                              |
| `ACTA_OIDC_SCOPES`         | `openid email profile` | `email` is not optional: the email is how a token becomes a member.                      |
| `ACTA_OIDC_AUTO_PROVISION` | `true`                 | Create a member on first sign-in. Set `false` to require that members are invited first. |
| `ACTA_OIDC_LABEL`          | `single sign-on`       | What the sign-in button calls your provider, e.g. `Okta`.                                |

### One-time codes

| Variable            | Default | What it does                                                  |
| ------------------- | ------- | ------------------------------------------------------------- |
| `ACTA_OTP_FALLBACK` | `false` | Keep email codes available _alongside_ a configured provider. |

With no provider configured, codes are the only way in and are always on.

::: danger Think before enabling the fallback
A second door beside your provider means an account the provider has disabled
can still sign in. Turn it on deliberately, for example to keep a way back in
while you are setting the provider up, and turn it off afterwards.
:::

### JWT handover (legacy)

The contract Acta had before it spoke OIDC: the provider redirects back with a
signed JWT rather than an authorization code. Keep using it if you already
have; prefer OIDC for anything new, and note that OIDC wins if both are set.

| Variable                  | Default                  | What it does                                       |
| ------------------------- | ------------------------ | -------------------------------------------------- |
| `ACTA_SSO_ISSUER`         | _unset_                  | Issuer, also where the JWKS is fetched from.       |
| `ACTA_SSO_APP_ID`         | _unset_                  | The app identifier sent to the authorize endpoint. |
| `ACTA_SSO_AUTHORIZE_URL`  | `${issuer}/api/auth/sso` | Where to send the browser.                         |
| `ACTA_SSO_AUTO_PROVISION` | `true`                   | As above.                                          |
| `ACTA_SSO_LABEL`          | `single sign-on`         | As above.                                          |

### Provider webhooks

A provider that keeps its own record of who your members are can push changes
to Acta between sign-ins: an avatar that was replaced, or a person who was
removed from the app. Without this, removing someone at the provider stops
them signing in again but leaves what they already hold working, their session
until it expires and any personal or agent token indefinitely.

| Variable                  | Default | What it does                                                                      |
| ------------------------- | ------- | --------------------------------------------------------------------------------- |
| `PLATFORM_WEBHOOK_SECRET` | _unset_ | Shared secret each delivery is signed with. Unset means the endpoint answers 404. |

Register this URL with your provider, substituting your own host:

```
https://acta.nubisco.io/api/v1/platform/webhook
```

Deliveries are `POST`s carrying `X-Nubisco-Signature: sha256=<hex>`, an
HMAC-SHA256 of the raw body under the secret. Acta verifies the signature
before parsing, refuses anything more than five minutes old, and answers 2xx
to events it does not act on. Delivery is best effort and never retried, so
nothing depends on it: sign-in refreshes the avatar too, and every token
expires on its own.

On Cloudflare Workers this is a secret, not a var:

```sh
wrangler secret put PLATFORM_WEBHOOK_SECRET
```

## Notification email

Acta tells people about work they are part of in the bell. If a notification
has been sitting there unread for longer than that person's own setting, it
also reaches them by email, as one digest rather than one message per
notification. Opening the bell is what stops it, so a morning spent in Acta
sends nothing at all.

Both of these are optional. Without a key nothing is emailed and the bell is
the whole feature, which is the self-hosted default rather than a broken
state.

| Variable              | Default | What it does                                                                                                                                                                                                                                                          |
| --------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ACTA_RESEND_API_KEY` | _unset_ | [Resend](https://resend.com) API key. Unset means no email is ever sent.                                                                                                                                                                                              |
| `ACTA_EMAIL_FROM`     | _unset_ | The From address, for example `Acta <notifications@example.com>`. Required alongside the key, and there is no default: a sender baked into an open-source product is the wrong one on every instance of it that is not ours. Must be verified in your Resend account. |

`ACTA_BASE_URL` matters here too: without it the digest has no links in it,
because a link that lands somewhere other than the thing being described is
worse than no link.

On Cloudflare Workers the key is a secret, not a var:

```sh
wrangler secret put ACTA_RESEND_API_KEY
```

### The sweep

Two things are driven by time rather than by somebody writing: a due date
arriving, and a notification going unread long enough to be worth an email.
Both run in one sweep.

- **On Cloudflare** a cron trigger runs it every five minutes. It is declared
  in `server/wrangler.toml` under `[triggers]`, and the Worker's `scheduled`
  handler is what receives it.
- **On Bun or Docker** the same function runs on a one-minute interval from
  `server/src/index.ts`. Nothing to configure.

Both call `notificationSweep`, so the two deployments have the same feature.
Every step in it is idempotent, which is what makes a retried cron or a
second isolate harmless: due-date events are keyed on the card and the date,
and a reminder is stamped in the same statement that selects it.

## Importer variables

Used by the [migration CLIs](/developers/migrate-trello), not by the server.

| Variable                                                      | What it does                                             |
| ------------------------------------------------------------- | -------------------------------------------------------- |
| `ACTA_URL`                                                    | The Acta instance to write to.                           |
| `ACTA_TOKEN`                                                  | A token with write access.                               |
| `ACTA_TRACE`                                                  | Set to anything to log every request the importer makes. |
| `TRELLO_KEY`, `TRELLO_TOKEN`                                  | Trello API credentials, for fetching boards live.        |
| `CONFLUENCE_BASE`, `CONFLUENCE_EMAIL`, `CONFLUENCE_API_TOKEN` | Confluence credentials, for fetching spaces live.        |

## Health

`GET /healthz` returns `{"ok": true, "service": "acta", "ts": ...}` without
touching the database. It answers while the database is broken, which is what
you want from a liveness probe and not what you want from a readiness one.
