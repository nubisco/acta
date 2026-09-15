/**
 * OAuth 2.1 authorization server for the MCP endpoint.
 *
 * Acta's own tokens are pasted into a header, which every CLI accepts and no
 * connector UI does. ChatGPT and the claude.ai custom connector speak the MCP
 * authorization spec instead: discover this server through RFC 9728/8414
 * metadata, self-register (RFC 7591), send the person through
 * /oauth/authorize with PKCE, exchange the code at /oauth/token. Adding a
 * connector without this gets "Couldn't determine how this server signs in",
 * because a bare 401 says nothing about how to try again.
 *
 * Deliberately small: public clients only, so there is no client secret to
 * store; S256 PKCE only; exact redirect_uri matching; one scope. Codes are
 * single-use and live five minutes, access tokens an hour, refresh tokens
 * rotate on every use. Every secret is stored hashed, like auth_token.
 *
 * The tokens issued here act as the consenting member and carry read and
 * write, never admin, matching personal access tokens. Administration takes a
 * browser session and a deliberate visit; a credential living in someone
 * else's client is not that.
 */

import { newId } from '@nubisco/acta-shared'
import type { ISqlDriver } from '../db'
import { now } from './ctx'
import { sha256Hex, type IAuthedActor } from './auth'

export const OAUTH_SCOPE = 'acta'
const CODE_TTL_MS = 5 * 60 * 1000
const ACCESS_TTL_MS = 60 * 60 * 1000
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000

/** Prefixes, so a leaked string is recognisable on sight and by a scanner. */
const ACCESS_PREFIX = 'acta_mcp_'
const REFRESH_PREFIX = 'acta_ref_'
const CODE_PREFIX = 'acta_code_'

export const OAUTH_CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers':
    'Content-Type, Authorization, MCP-Protocol-Version',
}

function randomSecret(prefix: string): string {
  const bytes = new Uint8Array(24)
  crypto.getRandomValues(bytes)
  return (
    prefix +
    Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  )
}

/** PKCE: base64url(SHA-256(verifier)), unpadded, per RFC 7636. */
export async function s256Challenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(verifier),
  )
  let binary = ''
  for (const b of new Uint8Array(digest)) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** https for the world, plain http only for localhost tooling. */
export function acceptableRedirect(uri: string): boolean {
  try {
    const u = new URL(uri)
    if (u.protocol === 'https:') return true
    return (
      u.protocol === 'http:' &&
      (u.hostname === 'localhost' || u.hostname === '127.0.0.1')
    )
  } catch {
    return false
  }
}

export interface IOauthClient {
  id: string
  name: string
  redirect_uris: string
}

export async function clientById(
  db: ISqlDriver,
  id: string,
): Promise<IOauthClient | null> {
  if (!id) return null
  const rows = await db.query<IOauthClient>(
    'SELECT id, name, redirect_uris FROM oauth_client WHERE id = ?',
    [id],
  )
  return rows[0] ?? null
}

/**
 * Exact match, never a prefix.
 *
 * "Starts with the registered URI" is the classic open redirect: a client
 * registering https://good.example lets an attacker send the code to
 * https://good.example.evil.test.
 */
export function redirectAllowed(client: IOauthClient, uri: string): boolean {
  try {
    return (JSON.parse(client.redirect_uris) as string[]).includes(uri)
  } catch {
    return false
  }
}

// ── Discovery ───────────────────────────────────────────────────────────────

/** RFC 9728: where this resource's authorization server lives. */
export function protectedResourceMetadata(origin: string): unknown {
  return {
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
    bearer_methods_supported: ['header'],
    scopes_supported: [OAUTH_SCOPE],
  }
}

/**
 * RFC 8414. Served at /.well-known/oauth-authorization-server and also at
 * /.well-known/openid-configuration: this is not an OpenID provider, it mints
 * no id tokens and publishes no JWKS, but real clients try OIDC discovery
 * first and treat whatever answers 200 as authoritative. The endpoints are the
 * same either way, so both doors give the same answer rather than one door
 * giving a 404 that ends the handshake.
 */
export function authorizationServerMetadata(origin: string): unknown {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [OAUTH_SCOPE],
  }
}

// ── Registration ────────────────────────────────────────────────────────────

export async function registerClient(
  db: ISqlDriver,
  body: { redirect_uris?: unknown; client_name?: unknown },
): Promise<
  | { ok: true; id: string; name: string; uris: string[] }
  | { ok: false; error: string; description: string }
> {
  const uris = Array.isArray(body.redirect_uris)
    ? body.redirect_uris.filter((u): u is string => typeof u === 'string')
    : []
  if (uris.length === 0 || !uris.every(acceptableRedirect)) {
    return {
      ok: false,
      error: 'invalid_redirect_uri',
      description: 'redirect_uris must be https URLs, or http on localhost',
    }
  }
  const id = newId('oac')
  const name =
    (typeof body.client_name === 'string' && body.client_name.trim()) ||
    'Unnamed client'
  await db.run(
    'INSERT INTO oauth_client (id, name, redirect_uris, created_at) VALUES (?, ?, ?, ?)',
    [id, name.slice(0, 120), JSON.stringify(uris), now()],
  )
  return { ok: true, id, name, uris }
}

// ── Authorize ───────────────────────────────────────────────────────────────

export interface IAuthorizeParams {
  clientId: string
  clientName: string
  redirectUri: string
  state: string
  codeChallenge: string
}

export type TAuthorizeCheck =
  | { ok: true; p: IAuthorizeParams }
  /** Refuse in place: the redirect target is not proven, so following it is unsafe. */
  | { ok: false; kind: 'refuse'; message: string }
  /** Safe to report at the client's registered redirect. */
  | { ok: false; kind: 'redirect'; to: string }

/**
 * Validates far enough to know whether reporting the error by redirect is
 * safe. An unknown client or an unregistered redirect_uri must never be
 * answered with a redirect to the URI that was asked for.
 */
export async function validateAuthorize(
  db: ISqlDriver,
  get: (k: string) => string,
): Promise<TAuthorizeCheck> {
  const client = await clientById(db, get('client_id'))
  const redirectUri = get('redirect_uri')
  if (!client || !redirectAllowed(client, redirectUri)) {
    return {
      ok: false,
      kind: 'refuse',
      message: 'Unknown client, or a redirect_uri it did not register',
    }
  }
  const fail = (error: string): TAuthorizeCheck => {
    const to = new URL(redirectUri)
    to.searchParams.set('error', error)
    if (get('state')) to.searchParams.set('state', get('state'))
    return { ok: false, kind: 'redirect', to: to.href }
  }
  if (get('response_type') !== 'code') return fail('unsupported_response_type')
  if (!get('code_challenge') || get('code_challenge_method') !== 'S256') {
    return fail('invalid_request')
  }
  return {
    ok: true,
    p: {
      clientId: client.id,
      clientName: client.name,
      redirectUri,
      state: get('state'),
      codeChallenge: get('code_challenge'),
    },
  }
}

/** Mints the one-time code. Returns the URL to send the browser to. */
export async function issueCode(
  db: ISqlDriver,
  p: IAuthorizeParams,
  workspaceId: string,
  actorId: string,
): Promise<string> {
  const code = randomSecret(CODE_PREFIX)
  await db.run(
    `INSERT INTO oauth_code
       (code_hash, workspace_id, client_id, actor_id, redirect_uri, code_challenge, scope, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      await sha256Hex(code),
      workspaceId,
      p.clientId,
      actorId,
      p.redirectUri,
      p.codeChallenge,
      OAUTH_SCOPE,
      now() + CODE_TTL_MS,
      now(),
    ],
  )
  const to = new URL(p.redirectUri)
  if (p.state) to.searchParams.set('state', p.state)
  to.searchParams.set('code', code)
  return to.href
}

// ── Token ───────────────────────────────────────────────────────────────────

export interface ITokenPair {
  access_token: string
  token_type: 'Bearer'
  expires_in: number
  refresh_token: string
  scope: string
}

async function mintPair(
  db: ISqlDriver,
  row: {
    workspaceId: string
    clientId: string
    actorId: string
    scope: string
  },
): Promise<ITokenPair> {
  const access = randomSecret(ACCESS_PREFIX)
  const refresh = randomSecret(REFRESH_PREFIX)
  await db.run(
    `INSERT INTO oauth_token
       (id, workspace_id, client_id, actor_id, access_hash, refresh_hash, scope,
        access_expires_at, refresh_expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      newId('oat'),
      row.workspaceId,
      row.clientId,
      row.actorId,
      await sha256Hex(access),
      await sha256Hex(refresh),
      row.scope,
      now() + ACCESS_TTL_MS,
      now() + REFRESH_TTL_MS,
      now(),
    ],
  )
  return {
    access_token: access,
    token_type: 'Bearer',
    expires_in: Math.floor(ACCESS_TTL_MS / 1000),
    refresh_token: refresh,
    scope: row.scope,
  }
}

export type TTokenResult =
  { ok: true; pair: ITokenPair } | { ok: false; error: string }

/** grant_type=authorization_code. Every check here fails open if omitted. */
export async function exchangeCode(
  db: ISqlDriver,
  get: (k: string) => string,
): Promise<TTokenResult> {
  const rows = await db.query<{
    code_hash: string
    workspace_id: string
    client_id: string
    actor_id: string
    redirect_uri: string
    code_challenge: string
    scope: string
    expires_at: number
    used_at: number | null
  }>(
    `SELECT code_hash, workspace_id, client_id, actor_id, redirect_uri,
            code_challenge, scope, expires_at, used_at
       FROM oauth_code WHERE code_hash = ?`,
    [await sha256Hex(get('code'))],
  )
  const row = rows[0]
  if (!row || row.used_at !== null || row.expires_at <= now()) {
    return { ok: false, error: 'invalid_grant' }
  }
  if (row.client_id !== get('client_id'))
    return { ok: false, error: 'invalid_grant' }
  // The redirect_uri is repeated here so a code minted for one target cannot
  // be redeemed while claiming another.
  if (row.redirect_uri !== get('redirect_uri')) {
    return { ok: false, error: 'invalid_grant' }
  }
  // The proof. Without this the code alone is enough, which is the whole
  // reason PKCE exists for public clients.
  if ((await s256Challenge(get('code_verifier'))) !== row.code_challenge) {
    return { ok: false, error: 'invalid_grant' }
  }

  await db.run('UPDATE oauth_code SET used_at = ? WHERE code_hash = ?', [
    now(),
    row.code_hash,
  ])
  return {
    ok: true,
    pair: await mintPair(db, {
      workspaceId: row.workspace_id,
      clientId: row.client_id,
      actorId: row.actor_id,
      scope: row.scope,
    }),
  }
}

/** grant_type=refresh_token. Rotates, so the presented token dies here. */
export async function refreshToken(
  db: ISqlDriver,
  get: (k: string) => string,
): Promise<TTokenResult> {
  const rows = await db.query<{
    id: string
    client_id: string
    scope: string
    refresh_expires_at: number
    revoked_at: number | null
  }>(
    `SELECT id, client_id, scope, refresh_expires_at, revoked_at
       FROM oauth_token WHERE refresh_hash = ?`,
    [await sha256Hex(get('refresh_token'))],
  )
  const row = rows[0]
  if (!row || row.revoked_at !== null || row.refresh_expires_at <= now()) {
    return { ok: false, error: 'invalid_grant' }
  }
  if (get('client_id') && get('client_id') !== row.client_id) {
    return { ok: false, error: 'invalid_grant' }
  }

  const access = randomSecret(ACCESS_PREFIX)
  const refresh = randomSecret(REFRESH_PREFIX)
  await db.run(
    `UPDATE oauth_token
        SET access_hash = ?, refresh_hash = ?, access_expires_at = ?,
            refresh_expires_at = ?, rotated_at = ?
      WHERE id = ?`,
    [
      await sha256Hex(access),
      await sha256Hex(refresh),
      now() + ACCESS_TTL_MS,
      now() + REFRESH_TTL_MS,
      now(),
      row.id,
    ],
  )
  return {
    ok: true,
    pair: {
      access_token: access,
      token_type: 'Bearer',
      expires_in: Math.floor(ACCESS_TTL_MS / 1000),
      refresh_token: refresh,
      scope: row.scope,
    },
  }
}

// ── Resource side ───────────────────────────────────────────────────────────

/**
 * Resolve an OAuth access token to the member it acts as.
 *
 * Returns the same shape resolveToken() does, so everything downstream (the
 * MCP endpoint, the REST API, attribution in the audit trail) treats a
 * connector exactly like the person who approved it. Scopes are read and
 * write with no admin, matching a personal access token.
 */
export async function resolveOauthToken(
  db: ISqlDriver,
  token: string,
): Promise<IAuthedActor | null> {
  if (!token.startsWith(ACCESS_PREFIX)) return null
  const rows = await db.query<{
    id: string
    workspace_id: string
    actor_id: string
    access_expires_at: number
    revoked_at: number | null
    actor_kind: 'human' | 'agent' | 'system'
    handle: string
    role: 'admin' | 'member'
    on_behalf_of: string | null
    disabled: number
    email: string | null
  }>(
    `SELECT t.id, t.workspace_id, t.actor_id, t.access_expires_at, t.revoked_at,
            a.kind AS actor_kind, a.handle, a.role, a.on_behalf_of, a.disabled, a.email
       FROM oauth_token t JOIN actor a ON a.id = t.actor_id
      WHERE t.access_hash = ?`,
    [await sha256Hex(token)],
  )
  const r = rows[0]
  if (!r || r.revoked_at !== null || r.disabled === 1) return null
  if (r.access_expires_at <= now()) return null
  await db.run('UPDATE oauth_token SET last_used_at = ? WHERE id = ?', [
    now(),
    r.id,
  ])
  return {
    id: r.actor_id,
    kind: r.actor_kind,
    handle: r.handle,
    role: r.role,
    onBehalfOf: r.on_behalf_of ?? undefined,
    // Never admin. A connector holds this token; administration should take a
    // browser session, the same rule personal access tokens follow.
    scopes: ['read', 'write'],
    tokenKind: 'personal',
    workspaceId: r.workspace_id,
    email: r.email ?? undefined,
  }
}
