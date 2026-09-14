/**
 * External SSO (vendor-neutral): the instance redirects to a configured
 * identity provider, which returns a signed RS256 JWT to the callback; the
 * token is verified against the issuer's JWKS and mapped to a workspace
 * member. Works with any IdP implementing this contract; local email OTP
 * remains available when unconfigured.
 *
 * Contract:
 *   authorize: 302 to `${authorizeUrl}?app_id=&redirect_uri=&state=`
 *   callback:  `?token=<JWT>&state=<echoed>` or `?error=<code>`
 *   JWT:       RS256, kid in header, JWKS at `${issuer}/.well-known/jwks.json`,
 *              claims: sub, email, name?, role?, iss, exp.
 */

export interface ISsoConfig {
  issuer: string
  authorizeUrl: string
  appId: string
  /** Create members on first login (the IdP gates who gets a token). */
  autoProvision: boolean
  /** Shown on the sign-in button. */
  label: string
}

export function ssoConfigFromEnv(
  env: Record<string, string | undefined>,
): ISsoConfig | null {
  const issuer = env.ACTA_SSO_ISSUER?.replace(/\/$/, '')
  const appId = env.ACTA_SSO_APP_ID
  if (!issuer || !appId) return null
  return {
    issuer,
    appId,
    authorizeUrl: env.ACTA_SSO_AUTHORIZE_URL ?? `${issuer}/api/auth/sso`,
    autoProvision: env.ACTA_SSO_AUTO_PROVISION !== 'false',
    label: env.ACTA_SSO_LABEL ?? 'single sign-on',
  }
}

export interface ISsoClaims {
  sub: string
  email: string
  name?: string
  role?: string
  iat: number
  exp: number
  iss: string
  /** OIDC id_tokens only: the client the token was minted for. */
  aud?: string | string[]
  /** OIDC id_tokens only: binds the token to one sign-in attempt. */
  nonce?: string
  [key: string]: unknown
}

interface IJwkKey {
  kid: string
  kty: string
  alg: string
  use: string
  n: string
  e: string
}

interface IJwtHeader {
  alg: string
  kid?: string
}

function base64urlDecode(input: string): ArrayBuffer {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/')
  const padLen = (4 - (padded.length % 4)) % 4
  const b64 = padded + '='.repeat(padLen)
  const binary = atob(b64)
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
  return bytes.buffer as ArrayBuffer
}

function base64urlToUtf8(input: string): string {
  return new TextDecoder().decode(new Uint8Array(base64urlDecode(input)))
}

export class JwksVerifier {
  private readonly issuer: string
  private readonly jwksUri: string
  private readonly cacheTtlMs: number
  private readonly fetchImpl: typeof fetch
  private jwksCache: { keys: IJwkKey[]; fetchedAt: number } | null = null
  private importedKeys: Map<string, CryptoKey> = new Map()

  constructor(
    issuer: string,
    opts: {
      cacheTtlMs?: number
      fetchImpl?: typeof fetch
      /**
       * Where the keys actually live. The handover contract fixes this at
       * `${issuer}/.well-known/jwks.json`, but an OIDC provider names it in
       * its discovery document and is under no obligation to put it there:
       * Entra and Auth0 both serve keys from a different path.
       */
      jwksUri?: string
    } = {},
  ) {
    this.issuer = issuer.replace(/\/$/, '')
    this.jwksUri = opts.jwksUri ?? `${this.issuer}/.well-known/jwks.json`
    this.cacheTtlMs = opts.cacheTtlMs ?? 300_000
    // Bound, not merely stored. `this.fetchImpl(...)` below would otherwise
    // call fetch with the verifier as `this`, and workerd refuses to run its
    // global fetch with any `this` but globalThis: "Illegal invocation".
    // Node and bun ignore `this` entirely, so this failed only in production,
    // only for SSO, with the reason swallowed by a bare catch. Binding here
    // covers an injected fetch too, which is otherwise the same trap one
    // constructor argument away.
    this.fetchImpl = (opts.fetchImpl ?? globalThis.fetch).bind(globalThis)
  }

  private async fetchJwks(): Promise<IJwkKey[]> {
    const now = Date.now()
    if (this.jwksCache && now - this.jwksCache.fetchedAt < this.cacheTtlMs) {
      return this.jwksCache.keys
    }
    const res = await this.fetchImpl(this.jwksUri)
    if (!res.ok) throw new Error(`Failed to fetch JWKS: ${res.status}`)
    const data = (await res.json()) as { keys: IJwkKey[] }
    this.jwksCache = { keys: data.keys, fetchedAt: now }
    this.importedKeys.clear()
    return data.keys
  }

  private async getVerifyKey(kid: string): Promise<CryptoKey> {
    const cached = this.importedKeys.get(kid)
    if (cached) return cached
    const keys = await this.fetchJwks()
    let jwk = keys.find((k) => k.kid === kid)
    if (!jwk) {
      // Key rotation: refetch once before giving up.
      this.jwksCache = null
      jwk = (await this.fetchJwks()).find((k) => k.kid === kid)
      if (!jwk) throw new Error(`No JWKS key found for kid: ${kid}`)
    }
    const key = await crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    )
    this.importedKeys.set(jwk.kid, key)
    return key
  }

  async verify(token: string): Promise<ISsoClaims> {
    const parts = token.split('.')
    if (parts.length !== 3) throw new Error('Malformed JWT')
    const [headerB64, payloadB64, signatureB64] = parts as [
      string,
      string,
      string,
    ]

    const header = JSON.parse(base64urlToUtf8(headerB64)) as IJwtHeader
    if (header.alg !== 'RS256')
      throw new Error(`Unsupported algorithm: ${header.alg}`)
    if (!header.kid) throw new Error('JWT missing kid')

    const key = await this.getVerifyKey(header.kid)
    const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`)
    const signature = base64urlDecode(signatureB64)

    const valid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      key,
      signature,
      signingInput,
    )
    if (!valid) throw new Error('JWT signature verification failed')

    const claims = JSON.parse(base64urlToUtf8(payloadB64)) as ISsoClaims
    const now = Math.floor(Date.now() / 1000)
    if (claims.exp < now) throw new Error('JWT expired')
    if (claims.iss !== this.issuer)
      throw new Error(`JWT issuer mismatch: expected ${this.issuer}`)
    if (!claims.email) throw new Error('JWT missing email claim')
    return claims
  }
}
