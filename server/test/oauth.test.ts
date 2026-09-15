/**
 * OAuth 2.1 for the MCP endpoint.
 *
 * The happy path is one round trip and hard to get wrong. What is worth
 * testing is every check that fails OPEN when it is missing, because none of
 * them is visible in ordinary use and a connector will work perfectly without
 * any of them:
 *
 *   - the 401 pointer, without which no connector can begin at all
 *   - exact redirect_uri matching, the classic open redirect
 *   - PKCE actually verified rather than merely accepted
 *   - codes single-use and short-lived
 *   - refresh rotation, so a captured refresh token dies on first use
 *   - tokens that never carry admin, whatever the approver's role
 */
import { beforeEach, describe, expect, it } from 'bun:test'
import type { Hono } from 'hono'
import { createApp } from '../src/app'
import { openDb, type BunSqliteDriver } from '../src/db'
import { createToken } from '../src/core/auth'
import { s256Challenge } from '../src/core/oauth'

let db: BunSqliteDriver
let app: Hono<never>
let session: string
let joseId: string

const VERIFIER = 'a'.repeat(64)
const REDIRECT = 'https://client.test/callback'

beforeEach(async () => {
  db = await openDb(':memory:')
  app = (await createApp(db, {
    bootstrap: { adminEmail: 'jose@nubisco.io', adminHandle: 'jose' },
    dataDir: `/tmp/acta-oauth-${Math.random().toString(36).slice(2)}`,
  })) as never
  const ws = (await db.query<{ id: string }>('SELECT id FROM workspace'))[0].id
  joseId = (
    await db.query<{ id: string }>("SELECT id FROM actor WHERE handle = 'jose'")
  )[0].id
  session = await createToken(db, ws, joseId, 'session', [
    'read',
    'write',
    'admin',
  ])
})

const asCookie = (): Record<string, string> => ({
  cookie: `acta_session=${session}`,
})

async function register(
  uris: string[] = [REDIRECT],
  name = 'Test Connector',
): Promise<string> {
  const res = await app.request('https://acta.test/oauth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: uris, client_name: name }),
  })
  const body = (await res.json()) as { client_id: string }
  return body.client_id
}

function authorizeUrl(
  clientId: string,
  challenge: string,
  over: Record<string, string> = {},
): string {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    state: 'st-1',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    ...over,
  })
  return `https://acta.test/oauth/authorize?${q}`
}

/** Approve and return the code from the redirect. */
async function approve(clientId: string, challenge: string): Promise<string> {
  const form = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    state: 'st-1',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    decision: 'approve',
  })
  const res = await app.request('https://acta.test/oauth/authorize', {
    method: 'POST',
    headers: {
      ...asCookie(),
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: form.toString(),
  })
  expect(res.status).toBe(302)
  return (
    new URL(res.headers.get('location') ?? '').searchParams.get('code') ?? ''
  )
}

const tokenReq = (body: Record<string, string>) =>
  app.request('https://acta.test/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  })

describe('oauth discovery', () => {
  // Without this header a connector reports that it cannot determine how the
  // server signs in, which is exactly the bug this feature exists to fix.
  it('points an unauthenticated /mcp request at the metadata', async () => {
    const res = await app.request('https://acta.test/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toBe(
      'Bearer resource_metadata="https://acta.test/.well-known/oauth-protected-resource/mcp"',
    )
  })

  it('publishes the two metadata documents', async () => {
    const pr = await (
      await app.request(
        'https://acta.test/.well-known/oauth-protected-resource/mcp',
      )
    ).json()
    expect(pr).toMatchObject({
      resource: 'https://acta.test/mcp',
      authorization_servers: ['https://acta.test'],
    })

    const as = await (
      await app.request(
        'https://acta.test/.well-known/oauth-authorization-server',
      )
    ).json()
    expect(as).toMatchObject({
      issuer: 'https://acta.test',
      authorization_endpoint: 'https://acta.test/oauth/authorize',
      token_endpoint: 'https://acta.test/oauth/token',
      registration_endpoint: 'https://acta.test/oauth/register',
      code_challenge_methods_supported: ['S256'],
    })
  })

  // Several clients try OIDC discovery first and treat a 404 as "no
  // authorization server here", ending the handshake before it starts.
  it('answers openid-configuration with the same document', async () => {
    const a = await (
      await app.request('https://acta.test/.well-known/openid-configuration')
    ).json()
    const b = await (
      await app.request(
        'https://acta.test/.well-known/oauth-authorization-server',
      )
    ).json()
    expect(a).toEqual(b)
  })
})

describe('oauth registration', () => {
  it('registers a public client', async () => {
    const res = await app.request('https://acta.test/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: [REDIRECT],
        client_name: 'Claude',
      }),
    })
    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({
      client_name: 'Claude',
      token_endpoint_auth_method: 'none',
    })
  })

  it('refuses a redirect that is neither https nor localhost', async () => {
    for (const uri of [
      'http://evil.test/cb',
      'javascript:alert(1)',
      'ftp://x/y',
    ]) {
      const res = await app.request('https://acta.test/oauth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ redirect_uris: [uri] }),
      })
      expect(res.status).toBe(400)
    }
  })

  it('allows localhost over http, which is how CLI tooling works', async () => {
    const res = await app.request('https://acta.test/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: ['http://localhost:3118/callback'],
      }),
    })
    expect(res.status).toBe(201)
  })
})

describe('oauth authorize', () => {
  it('shows consent to a signed-in member', async () => {
    const id = await register()
    const res = await app.request(
      authorizeUrl(id, await s256Challenge(VERIFIER)),
      {
        headers: asCookie(),
      },
    )
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('Test Connector')
    expect(html).toContain('@jose')
    // The person should be told what it cannot do, not only what it can.
    expect(html).toContain('cannot manage members')
  })

  // Losing the parameters on the way to sign-in is the failure the
  // server-rendered consent page exists to avoid.
  it('offers sign-in that returns to the same request', async () => {
    const id = await register()
    const res = await app.request(
      authorizeUrl(id, await s256Challenge(VERIFIER)),
    )
    const html = await res.text()
    expect(html).toContain('Sign in')
    expect(html).toContain(encodeURIComponent('/oauth/authorize?'))
    expect(html).toContain(encodeURIComponent('code_challenge'))
  })

  // An unregistered redirect must be refused in place. Reporting the error by
  // redirecting to it is how an open redirect is built.
  it('refuses an unregistered redirect_uri without redirecting to it', async () => {
    const id = await register()
    const url = authorizeUrl(id, await s256Challenge(VERIFIER), {
      redirect_uri: 'https://evil.test/steal',
    })
    const res = await app.request(url, { headers: asCookie() })
    expect(res.status).toBe(400)
    expect(res.headers.get('location')).toBeNull()
  })

  // "Starts with the registered URI" would let this through.
  it('will not accept a redirect that merely starts with a registered one', async () => {
    const id = await register(['https://client.test/callback'])
    const url = authorizeUrl(id, await s256Challenge(VERIFIER), {
      redirect_uri: 'https://client.test/callback.evil.test/x',
    })
    const res = await app.request(url, { headers: asCookie() })
    expect(res.status).toBe(400)
  })

  it('refuses a request without S256 PKCE', async () => {
    const id = await register()
    const url = authorizeUrl(id, 'plainchallenge', {
      code_challenge_method: 'plain',
    })
    const res = await app.request(url, { headers: asCookie() })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toContain('error=invalid_request')
  })

  it('reports a denial to the client rather than issuing anything', async () => {
    const id = await register()
    const form = new URLSearchParams({
      response_type: 'code',
      client_id: id,
      redirect_uri: REDIRECT,
      state: 'st-1',
      code_challenge: await s256Challenge(VERIFIER),
      code_challenge_method: 'S256',
      decision: 'deny',
    })
    const res = await app.request('https://acta.test/oauth/authorize', {
      method: 'POST',
      headers: {
        ...asCookie(),
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    })
    const to = new URL(res.headers.get('location') ?? '')
    expect(to.searchParams.get('error')).toBe('access_denied')
    expect(to.searchParams.get('code')).toBeNull()
    expect(await db.query('SELECT code_hash FROM oauth_code')).toHaveLength(0)
  })

  // A forged cross-site approval arrives without the SameSite=Lax cookie, so
  // it must die exactly where an anonymous request does.
  it('will not approve without a session', async () => {
    const id = await register()
    const form = new URLSearchParams({
      response_type: 'code',
      client_id: id,
      redirect_uri: REDIRECT,
      code_challenge: await s256Challenge(VERIFIER),
      code_challenge_method: 'S256',
      decision: 'approve',
    })
    const res = await app.request('https://acta.test/oauth/authorize', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    })
    expect(res.headers.get('location')).toContain('/oauth/authorize?')
    expect(await db.query('SELECT code_hash FROM oauth_code')).toHaveLength(0)
  })
})

describe('oauth token', () => {
  it('exchanges a code for a usable token pair', async () => {
    const id = await register()
    const code = await approve(id, await s256Challenge(VERIFIER))
    const res = await tokenReq({
      grant_type: 'authorization_code',
      code,
      client_id: id,
      redirect_uri: REDIRECT,
      code_verifier: VERIFIER,
    })
    expect(res.status).toBe(200)
    const pair = (await res.json()) as {
      access_token: string
      refresh_token: string
    }
    expect(pair.access_token.startsWith('acta_mcp_')).toBe(true)
    expect(pair.refresh_token.startsWith('acta_ref_')).toBe(true)

    const mcp = await app.request('https://acta.test/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${pair.access_token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    const body = (await mcp.json()) as { result: { tools: unknown[] } }
    expect(body.result.tools.length).toBeGreaterThan(0)
  })

  // Without this the code alone is enough, which is the entire reason PKCE
  // exists for a client that cannot keep a secret.
  it('refuses the wrong code_verifier', async () => {
    const id = await register()
    const code = await approve(id, await s256Challenge(VERIFIER))
    const res = await tokenReq({
      grant_type: 'authorization_code',
      code,
      client_id: id,
      redirect_uri: REDIRECT,
      code_verifier: 'b'.repeat(64),
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'invalid_grant' })
  })

  it('refuses a code redeemed against a different redirect_uri', async () => {
    const id = await register([REDIRECT, 'https://client.test/other'])
    const code = await approve(id, await s256Challenge(VERIFIER))
    const res = await tokenReq({
      grant_type: 'authorization_code',
      code,
      client_id: id,
      redirect_uri: 'https://client.test/other',
      code_verifier: VERIFIER,
    })
    expect(res.status).toBe(400)
  })

  it('burns the code: a second exchange fails', async () => {
    const id = await register()
    const code = await approve(id, await s256Challenge(VERIFIER))
    const args = {
      grant_type: 'authorization_code',
      code,
      client_id: id,
      redirect_uri: REDIRECT,
      code_verifier: VERIFIER,
    }
    expect((await tokenReq(args)).status).toBe(200)
    expect((await tokenReq(args)).status).toBe(400)
  })

  it('refuses an expired code', async () => {
    const id = await register()
    const code = await approve(id, await s256Challenge(VERIFIER))
    await db.run('UPDATE oauth_code SET expires_at = ?', [Date.now() - 1000])
    const res = await tokenReq({
      grant_type: 'authorization_code',
      code,
      client_id: id,
      redirect_uri: REDIRECT,
      code_verifier: VERIFIER,
    })
    expect(res.status).toBe(400)
  })

  // Rotation is what makes a captured refresh token survivable: the moment it
  // is used once, the copy in an attacker's hands is dead.
  it('rotates on refresh and kills the presented token', async () => {
    const id = await register()
    const code = await approve(id, await s256Challenge(VERIFIER))
    const first = (await (
      await tokenReq({
        grant_type: 'authorization_code',
        code,
        client_id: id,
        redirect_uri: REDIRECT,
        code_verifier: VERIFIER,
      })
    ).json()) as { access_token: string; refresh_token: string }

    const second = (await (
      await tokenReq({
        grant_type: 'refresh_token',
        refresh_token: first.refresh_token,
        client_id: id,
      })
    ).json()) as { access_token: string; refresh_token: string }
    expect(second.refresh_token).not.toBe(first.refresh_token)
    expect(second.access_token).not.toBe(first.access_token)

    const replay = await tokenReq({
      grant_type: 'refresh_token',
      refresh_token: first.refresh_token,
      client_id: id,
    })
    expect(replay.status).toBe(400)
  })

  it('refuses an unsupported grant', async () => {
    const res = await tokenReq({
      grant_type: 'password',
      username: 'x',
      password: 'y',
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'unsupported_grant_type' })
  })
})

describe('oauth tokens as an actor', () => {
  it('acts as the member who approved it, and is attributed to them', async () => {
    const id = await register()
    const code = await approve(id, await s256Challenge(VERIFIER))
    const pair = (await (
      await tokenReq({
        grant_type: 'authorization_code',
        code,
        client_id: id,
        redirect_uri: REDIRECT,
        code_verifier: VERIFIER,
      })
    ).json()) as { access_token: string }

    const me = (await (
      await app.request('https://acta.test/api/v1/auth/me', {
        headers: { authorization: `Bearer ${pair.access_token}` },
      })
    ).json()) as { handle: string; role: string; scopes: string[] }
    expect(me.handle).toBe('jose')
    // Approved by an admin, and still not an admin token.
    expect(me.role).toBe('admin')
    expect(me.scopes).not.toContain('admin')
  })

  it('cannot reach administration', async () => {
    const id = await register()
    const code = await approve(id, await s256Challenge(VERIFIER))
    const pair = (await (
      await tokenReq({
        grant_type: 'authorization_code',
        code,
        client_id: id,
        redirect_uri: REDIRECT,
        code_verifier: VERIFIER,
      })
    ).json()) as { access_token: string }

    const res = await app.request('https://acta.test/api/v1/tokens', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${pair.access_token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'a bot of my own' }),
    })
    expect(res.status).toBe(403)
  })

  it('stops working once revoked', async () => {
    const id = await register()
    const code = await approve(id, await s256Challenge(VERIFIER))
    const pair = (await (
      await tokenReq({
        grant_type: 'authorization_code',
        code,
        client_id: id,
        redirect_uri: REDIRECT,
        code_verifier: VERIFIER,
      })
    ).json()) as { access_token: string }

    await db.run('UPDATE oauth_token SET revoked_at = ?', [Date.now()])
    const res = await app.request('https://acta.test/api/v1/overview', {
      headers: { authorization: `Bearer ${pair.access_token}` },
    })
    expect(res.status).toBe(401)
  })

  it('stops working once the access token expires', async () => {
    const id = await register()
    const code = await approve(id, await s256Challenge(VERIFIER))
    const pair = (await (
      await tokenReq({
        grant_type: 'authorization_code',
        code,
        client_id: id,
        redirect_uri: REDIRECT,
        code_verifier: VERIFIER,
      })
    ).json()) as { access_token: string }

    await db.run('UPDATE oauth_token SET access_expires_at = ?', [
      Date.now() - 1,
    ])
    const res = await app.request('https://acta.test/api/v1/overview', {
      headers: { authorization: `Bearer ${pair.access_token}` },
    })
    expect(res.status).toBe(401)
  })
})

/**
 * The return path across the provider round trip.
 *
 * This is the quiet one. Everything else here fails loudly when it breaks;
 * this fails by depositing the person at the workspace home, looking like a
 * successful sign-in, with the connector's request silently gone.
 */
describe('sign-in return path', () => {
  it('refuses anything that is not a local path', async () => {
    const { safeReturnPath } = await import('../src/routes/auth')
    expect(safeReturnPath('/oauth/authorize?x=1')).toBe('/oauth/authorize?x=1')
    // Protocol-relative and absolute URLs both leave the site, which would
    // turn our own sign-in into an open redirect.
    expect(safeReturnPath('//evil.test/x')).toBeNull()
    expect(safeReturnPath('https://evil.test/x')).toBeNull()
    expect(safeReturnPath('evil.test')).toBeNull()
    expect(safeReturnPath(undefined)).toBeNull()
  })
})
