/**
 * Standard OpenID Connect: authorization code with PKCE, against any
 * compliant provider.
 *
 * Acta already had "SSO", but its contract was `callback?token=<JWT>`: the
 * provider hands over a signed assertion directly. Nothing off the shelf does
 * that. Keycloak, Auth0, Okta, Entra and Google all return `?code=` and
 * expect a token exchange, so an adopter running any of them could not use
 * the feature at all and was left with email codes. That is the gap this
 * closes; `core/sso.ts` stays for the handover contract.
 *
 * Everything here is discovery-driven. The provider's
 * /.well-known/openid-configuration names its authorization, token and JWKS
 * endpoints, so the only configuration is an issuer and a client.
 */

import { JwksVerifier, type ISsoClaims } from './sso'

export interface IOidcConfig {
  issuer: string
  clientId: string
  /**
   * Omitted for public clients. PKCE is what actually protects the exchange;
   * a secret is an additional factor that only a server-side client can keep,
   * and Acta is one, so set it whenever the provider issues one.
   */
  clientSecret?: string
  scopes: string[]
  /** Create members on first login. The provider gates who gets that far. */
  autoProvision: boolean
  /** Shown on the sign-in button, e.g. "Okta" or "your company account". */
  label: string
}

export function oidcConfigFromEnv(
  env: Record<string, string | undefined>,
): IOidcConfig | null {
  const issuer = env.ACTA_OIDC_ISSUER?.replace(/\/$/, '')
  const clientId = env.ACTA_OIDC_CLIENT_ID
  if (!issuer || !clientId) return null
  return {
    issuer,
    clientId,
    clientSecret: env.ACTA_OIDC_CLIENT_SECRET,
    // `openid` is mandatory and `email` is not optional for us: the email is
    // how a token is mapped to a member, so a provider configured without it
    // would authenticate people Acta then cannot place.
    scopes: (env.ACTA_OIDC_SCOPES ?? 'openid email profile').split(/\s+/),
    autoProvision: env.ACTA_OIDC_AUTO_PROVISION !== 'false',
    label: env.ACTA_OIDC_LABEL ?? 'single sign-on',
  }
}

interface IDiscovery {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  jwks_uri: string
}

/** PKCE pair plus the replay guards, held in a cookie between the two legs. */
export interface IOidcHandshake {
  state: string
  nonce: string
  verifier: string
}

function randomUrlSafe(bytes = 32): string {
  const buf = new Uint8Array(bytes)
  crypto.getRandomValues(buf)
  return base64url(buf)
}

function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(verifier),
  )
  return base64url(new Uint8Array(digest))
}

export class OidcClient {
  private readonly config: IOidcConfig
  private readonly fetchImpl: typeof fetch
  private readonly cacheTtlMs: number
  private discovery: { doc: IDiscovery; fetchedAt: number } | null = null
  private verifier: JwksVerifier | null = null

  constructor(
    config: IOidcConfig,
    opts: { fetchImpl?: typeof fetch; cacheTtlMs?: number } = {},
  ) {
    this.config = config
    this.cacheTtlMs = opts.cacheTtlMs ?? 3_600_000
    // Bound for the same reason JwksVerifier binds: workerd refuses to run
    // its global fetch with any `this` but globalThis, and an unbound store
    // fails only in production.
    this.fetchImpl = (opts.fetchImpl ?? globalThis.fetch).bind(globalThis)
  }

  private async discover(): Promise<IDiscovery> {
    const age = this.discovery ? Date.now() - this.discovery.fetchedAt : null
    if (this.discovery && age !== null && age < this.cacheTtlMs) {
      return this.discovery.doc
    }
    const url = `${this.config.issuer}/.well-known/openid-configuration`
    const res = await this.fetchImpl(url)
    if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status} ${url}`)
    const doc = (await res.json()) as IDiscovery
    for (const field of [
      'authorization_endpoint',
      'token_endpoint',
      'jwks_uri',
    ] as const) {
      if (!doc[field]) throw new Error(`OIDC discovery missing ${field}`)
    }
    // The issuer in the document is the one id_tokens will claim, and a
    // mismatch here is a misconfigured or hijacked discovery URL rather than
    // a login failure, so it is worth refusing loudly at this point.
    if (doc.issuer && doc.issuer.replace(/\/$/, '') !== this.config.issuer) {
      throw new Error(
        `OIDC issuer mismatch: configured ${this.config.issuer}, document says ${doc.issuer}`,
      )
    }
    this.discovery = { doc, fetchedAt: Date.now() }
    this.verifier = null
    return doc
  }

  /** The URL to send the browser to, plus the handshake to remember. */
  async authorizeUrl(
    redirectUri: string,
  ): Promise<{ url: string; handshake: IOidcHandshake }> {
    const doc = await this.discover()
    const handshake: IOidcHandshake = {
      state: randomUrlSafe(16),
      nonce: randomUrlSafe(16),
      verifier: randomUrlSafe(32),
    }
    const url = new URL(doc.authorization_endpoint)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('client_id', this.config.clientId)
    url.searchParams.set('redirect_uri', redirectUri)
    url.searchParams.set('scope', this.config.scopes.join(' '))
    url.searchParams.set('state', handshake.state)
    url.searchParams.set('nonce', handshake.nonce)
    url.searchParams.set('code_challenge', await s256(handshake.verifier))
    url.searchParams.set('code_challenge_method', 'S256')
    return { url: url.toString(), handshake }
  }

  /**
   * Exchange the code and verify the id_token. Returns the claims in the same
   * shape the handover contract produces, so the caller's member mapping does
   * not care which mode signed the person in.
   */
  async exchange(
    code: string,
    redirectUri: string,
    handshake: IOidcHandshake,
  ): Promise<ISsoClaims> {
    const doc = await this.discover()
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: this.config.clientId,
      code_verifier: handshake.verifier,
    })
    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    }
    // client_secret_basic is what providers advertise first and the only one
    // some accept; the id and secret are form-encoded per RFC 6749 §2.3.1
    // before being base64'd, which matters for secrets containing +, / or =.
    if (this.config.clientSecret) {
      const pair = `${encodeURIComponent(this.config.clientId)}:${encodeURIComponent(this.config.clientSecret)}`
      headers.authorization = `Basic ${btoa(pair)}`
    }
    const res = await this.fetchImpl(doc.token_endpoint, {
      method: 'POST',
      headers,
      body: body.toString(),
    })
    const payload = (await res.json().catch(() => ({}))) as {
      id_token?: string
      error?: string
      error_description?: string
    }
    if (!res.ok) {
      throw new Error(
        `Token exchange failed (${res.status}): ${payload.error_description ?? payload.error ?? 'no detail'}`,
      )
    }
    if (!payload.id_token) throw new Error('Token response carried no id_token')

    if (!this.verifier) {
      this.verifier = new JwksVerifier(this.config.issuer, {
        jwksUri: doc.jwks_uri,
        fetchImpl: this.fetchImpl,
      })
    }
    const claims = await this.verifier.verify(payload.id_token)

    // Audience and nonce are what make this token ours and this exchange
    // ours. Without the audience check an id_token minted for a different
    // client at the same issuer would be accepted; without the nonce check a
    // token captured from an earlier login could be replayed into this one.
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
    if (!aud.includes(this.config.clientId)) {
      throw new Error(`id_token audience is not ${this.config.clientId}`)
    }
    if (claims.nonce !== handshake.nonce) {
      throw new Error('id_token nonce does not match this sign-in')
    }
    return claims
  }
}
