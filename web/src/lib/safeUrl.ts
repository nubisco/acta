/**
 * URLs that are safe to put in an `href` or a `src`.
 *
 * A URL that arrives as data is not automatically safe to navigate to.
 * `javascript:`, `data:` and `vbscript:` all execute, and `z.url()` accepts
 * every one of them, because they are valid URLs. Vue's `:href` binding does
 * not filter them either, and neither does string interpolation into markup.
 *
 * markdown-it does filter them, which is why a `[x](javascript:...)` written
 * in a document has never been a problem. The risk is anywhere we build a
 * link ourselves from stored data and bypass it.
 *
 * An allowlist, so a scheme nobody has thought about is refused rather than
 * permitted. Relative URLs pass, because that is what our own served paths
 * are.
 */

const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

/**
 * The URL if it is safe to link to, otherwise null.
 *
 * Null rather than a sanitised string, so the caller has to decide what to
 * render instead of silently producing a link that goes nowhere.
 */
export function safeUrl(value: string | null | undefined): string | null {
  const url = (value ?? '').trim()
  if (!url) return null

  /*
   * Control characters come out before anything is decided.
   *
   * A browser strips tabs, newlines and NULs while reading a scheme, so
   * `java\0script:alert(1)` navigates as `javascript:`. Parsing it as-is has
   * the opposite effect: `java\0script:` is not a valid scheme, so it is read
   * as a relative path, resolves against the base, and comes back looking
   * like a safe https URL. Testing the cleaned string is what closes that.
   */
  // eslint-disable-next-line no-control-regex -- the point is control chars.
  const cleaned = url.replace(/[\u0000-\u001F\u007F]/g, '')
  if (!cleaned) return null

  // Protocol-relative first: `//evil.test` starts with `/` but inherits the
  // page's scheme and leaves the site, which is not what a caller passing a
  // served path means.
  if (cleaned.startsWith('//')) return null

  // Our own paths, and references within the current document.
  if (
    cleaned.startsWith('/') ||
    cleaned.startsWith('./') ||
    cleaned.startsWith('../') ||
    cleaned.startsWith('#') ||
    cleaned.startsWith('?')
  )
    return cleaned

  try {
    // Parsed rather than prefix-matched, so the protocol is read the way a
    // browser reads it.
    const parsed = new URL(cleaned, 'https://acta.invalid/')
    return SAFE_PROTOCOLS.has(parsed.protocol) ? cleaned : null
  } catch {
    return null
  }
}
