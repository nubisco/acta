/**
 * The platform avatar a person carries into Acta.
 *
 * The provider puts a public URL in the OIDC `picture` claim and in the
 * `user.updated` webhook. An absent claim means "no avatar", as does a null in
 * the webhook. Both fall back to initials in the UI.
 *
 * The value ends up as an <img src> on every Acta page, so it is checked
 * rather than trusted: only an address on the issuer's own origin under
 * `/api/avatars/` is kept. The token and the webhook are both signed, so this
 * is not the line of defence against forgery. It stops a provider change or a
 * misconfiguration from pointing every Acta page at some third-party host.
 */
export function acceptedPicture(
  value: unknown,
  issuer: string | undefined,
): string | null {
  if (typeof value !== 'string' || value === '' || !issuer) return null
  let url: URL
  let origin: string
  try {
    url = new URL(value)
    origin = new URL(issuer).origin
  } catch {
    return null
  }
  if (url.origin !== origin) return null
  if (!url.pathname.startsWith('/api/avatars/')) return null
  // Credentials in the URL would be sent by the browser on every page that
  // renders the avatar, and would sit in Acta's database in plain text.
  if (url.username || url.password) return null
  return url.toString()
}

/**
 * Whether sign-in goes through Nubisco Platform, which is what decides whether
 * the account menu shows account actions, Profile and the platform lockup. An
 * instance running against its own identity provider has neither page, and per
 * AGENTS.md must not be told about infrastructure it is not using.
 *
 * Parsed, never matched as a substring. `includes('nubisco.io')` would accept
 * an issuer at `platform.nubisco.io.example.com` or `evilnubisco.io`, and
 * comparing the hostname itself does not.
 */
export function isNubiscoPlatform(issuer: string | undefined): boolean {
  if (!issuer) return false
  try {
    const host = new URL(issuer).hostname.toLowerCase()
    return host === 'nubisco.io' || host.endsWith('.nubisco.io')
  } catch {
    return false
  }
}
