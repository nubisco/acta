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

A token from your provider says who someone is. It does not say which workspace
is theirs, so on its own it never creates a member. Sign-in lands a person:

1. in the workspace an invitation they are accepting is for, when the address
   they signed in as is the one invited;
2. otherwise in a workspace they are already a member of;
3. otherwise nowhere, with `not_a_member`.

`ACTA_OIDC_AUTO_PROVISION=true` changes step 3: anyone your provider vouches
for becomes a member of this instance's workspace on first sign-in. It is off by
default. Turn it on only when the provider already decides who may reach Acta
(you limited the client to certain users or groups when you registered it), and
never when the provider lets anyone sign up.

One exception keeps a fresh install usable: when the instance's workspace has
no administrator at all, the first person to sign in becomes it. Set
`ACTA_ADMIN_EMAIL` to close that window on an instance strangers can reach.

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

## Invitations

Nobody joins a workspace because an admin typed their address. An admin
invites them under **Settings, People**, and they join when they accept, which
proves the address is theirs:

- **Behind a provider**, accepting sends them through it, and the address they
  sign in as must be the one invited. A forwarded link does not let somebody
  else in.
- **With one-time codes**, the link itself is the proof: it was only ever sent
  to that address, which is the same proof a code is. It works once.

An instance with email configured sends the link to the invitee and never shows
it to the admin, because on a code-only instance holding the link is enough to
join. An instance with no email shows the link to the admin to pass on by hand.
Links expire after 7 days, inviting the same address again replaces the old
link, and an admin can revoke one at any time. Until they accept, the person is
not a member, cannot be mentioned or assigned, and is sent nothing else.

The API is `POST /api/v1/invitations` (`POST /api/v1/members` is the old name
and does the same), `GET /api/v1/invitations` and
`DELETE /api/v1/invitations/:id`, all admin only. The invitee's side is
`GET /api/v1/auth/invitations/:token` and
`POST /api/v1/auth/invitations/:token/accept`.

## Removing someone: the provider's webhook is account-wide

`membership.removed` from the provider (see
[Provider webhooks](/developers/configuration#provider-webhooks)) disables the
person in **every** workspace on the instance and revokes every credential they
hold. It means "this account may no longer use Acta here", which is an
account-level ban. It must never be used to model "removed from one workspace":
removing someone from a single workspace is an action inside Acta, an admin
disabling them under **Settings, People**.

## Suspending a workspace

An operator can shut a workspace without deleting anything by setting
`workspace.suspended_at` in the database. Every authenticated request into it,
and its ingest endpoint, then answers `403 workspace suspended`, and no
reminder is emailed from it. Clearing the column restores it. There is
deliberately no route for this: it is an operator's act, not a workspace
setting.

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
