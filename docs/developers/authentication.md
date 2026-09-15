# Authentication

Acta has no passwords. There are three ways someone can prove who they are,
and one of them is almost certainly the one you want.

|                                               | Use it when                                                                                |
| --------------------------------------------- | ------------------------------------------------------------------------------------------ |
| [Email one-time codes](#email-one-time-codes) | Small instance, no identity provider, or you are just getting started                      |
| [OpenID Connect](#openid-connect)             | You have Keycloak, Auth0, Okta, Entra, Google Workspace, or anything else that speaks OIDC |
| [JWT handover](#jwt-handover-legacy)          | You already built against Acta's original contract                                         |

## Email one-time codes

The default, and the only option if you configure nothing. Someone enters
their email, Acta sends a six-digit code, they enter it, they are in.

Only known member emails receive a code, and the response is identical either
way, so the form cannot be used to discover who has an account.

### The sender

Out of the box the code is **written to the server log**:

```
[acta] OTP for you@example.com: 123456
```

That is deliberate for a first boot on a laptop and unacceptable for anything
else: whoever can read your logs can sign in as anyone. Configure a real
sender before other people use the instance, or move to a provider.

### Seeding the first member

Nobody can sign in until an actor with their email exists. Set
`ACTA_ADMIN_EMAIL` on first boot, and that person can then invite everyone else
from **Settings → People**.

## OpenID Connect

The standard authorization-code flow with PKCE. Acta discovers everything else
from your provider, so the configuration is an issuer and a client.

### 1. Register Acta with your provider

Create a **web application** (confidential client) with:

- **Redirect URI**: `https://acta.example.com/api/v1/auth/sso/callback`
- **Grant type**: authorization code
- **Scopes**: `openid`, `email`, `profile`

Your provider will give you a client id and, unless it is a public client, a
secret.

### 2. Configure Acta

```sh
ACTA_OIDC_ISSUER=https://keycloak.example.com/realms/acme
ACTA_OIDC_CLIENT_ID=acta
ACTA_OIDC_CLIENT_SECRET=...
ACTA_OIDC_LABEL=Acme SSO
```

The issuer is whatever hosts `/.well-known/openid-configuration`. Acta reads
the authorization, token and JWKS endpoints from that document, so providers
that serve their keys from an unusual path work without special-casing.

Check it before restarting:

```sh
curl -s https://keycloak.example.com/realms/acme/.well-known/openid-configuration | jq
```

### 3. Restart

Configuring a provider **turns one-time codes off**, and a signed-out visitor
is redirected to the provider before any HTML is served, so there is no
sign-in page to flash past. `GET /api/v1/auth/config` reports the result:

```json
{ "sso": true, "otp": false, "sso_label": "Acme SSO" }
```

### Provider specifics

| Provider           | Issuer looks like                                    |
| ------------------ | ---------------------------------------------------- |
| Keycloak           | `https://host/realms/<realm>`                        |
| Auth0              | `https://<tenant>.eu.auth0.com/`                     |
| Okta               | `https://<tenant>.okta.com/oauth2/default`           |
| Microsoft Entra ID | `https://login.microsoftonline.com/<tenant-id>/v2.0` |
| Google Workspace   | `https://accounts.google.com`                        |

Google does not send `email` unless the scope is requested, which is why
`email` is in the default scope list. Acta refuses a sign-in whose token
carries no email, because the email is how a token becomes a member.

### Who gets in

`ACTA_OIDC_AUTO_PROVISION=true` (the default) means anyone your provider
vouches for becomes a member on first sign-in. That is usually right: the
provider is already deciding who may reach Acta, and you configured which
users or groups may use the client when you registered it.

Set it to `false` to require that members are created in Acta first. Someone
unknown then gets `not_a_member` rather than an account.

If the token carries a `role` claim of `admin`, that member is created as an
administrator.

### What is checked

Every sign-in verifies:

- **State**, bound to an `httpOnly` cookie, so the callback must belong to a
  sign-in this browser started.
- **PKCE (S256)**, so an intercepted authorization code cannot be exchanged by
  anyone but this browser.
- **Signature**, against the JWKS named in the discovery document, with one
  refetch on an unknown key id so provider key rotation does not lock you out.
- **Issuer**, **expiry**, **audience** (the token was minted for your client
  and not another at the same provider), and **nonce** (the token belongs to
  this sign-in rather than an earlier one).

A failure sends the person to `/login?error=sso_token`. The reason is written
to the server log and never to the browser, because telling an attacker which
half of a check failed is telling them how to pass it.

::: tip Locked out
If a provider misconfiguration leaves nobody able to sign in, set
`ACTA_OTP_FALLBACK=true` and restart. Codes come back alongside the provider,
and `/login?code=1` reaches the form. Turn it off once you are back in.
:::

## JWT handover (legacy)

Acta's original contract, which predates its OIDC support. The provider
authenticates the person and redirects back with a signed JWT in the query
string rather than an authorization code:

```
GET ${authorizeUrl}?app_id=...&redirect_uri=...&state=...
→  /api/v1/auth/sso/callback?token=<JWT>&state=<echoed>
```

The JWT must be RS256 with a `kid` in its header, verifiable against
`${issuer}/.well-known/jwks.json`, and carry `sub`, `email`, `iss` and `exp`,
optionally `name` and `role`.

No off-the-shelf provider does this, so in practice it means an identity
service written for it. It remains supported and unchanged. If both are
configured, OIDC wins.

## Access tokens

Separately from signing in, a member can mint **personal access tokens** from
**Settings → Your account**. These act as that person, with their role, for
the API and [the MCP endpoint](/developers/mcp). They never carry administrator rights
and cannot mint further tokens, so administration always requires a real
session.

**Agent tokens** are different: an administrator mints them from
**Settings → Automation**, and each gets its own actor, so an agent's work is
attributed to the agent rather than to a person.

**Connected applications** are the third kind, and the only one nobody pastes
anywhere: a connector that signed in through OAuth holds a grant rather than a
token. Those are listed under **Settings → Your account** and can be revoked
per application, which cuts every grant that application holds at once.
