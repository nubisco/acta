/**
 * URL safety.
 *
 * Anywhere a link is built from stored data, the scheme is the boundary. A
 * link attachment's URL is whatever somebody sent to the API, and `z.url()`
 * accepts `javascript:` because it is a valid URL. Rendering one into an
 * href is stored XSS: the script runs on Acta's origin, with the session.
 */
import { describe, expect, it } from 'vitest'
import { safeUrl } from '@/lib/safeUrl'

describe('safeUrl', () => {
  it('allows the schemes a link is meant to use', () => {
    expect(safeUrl('https://example.test/a')).toBe('https://example.test/a')
    expect(safeUrl('http://example.test/a')).toBe('http://example.test/a')
    expect(safeUrl('mailto:someone@example.test')).toBe(
      'mailto:someone@example.test',
    )
  })

  it('allows our own served paths', () => {
    expect(safeUrl('/api/v1/attachments/att_1')).toBe(
      '/api/v1/attachments/att_1',
    )
    expect(safeUrl('#section')).toBe('#section')
  })

  it('refuses every scheme that executes', () => {
    for (const url of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      '  javascript:alert(1)  ',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
    ]) {
      expect(safeUrl(url), url).toBeNull()
    }
  })

  it('is not fooled by whitespace inside the scheme', () => {
    // A prefix check on the string defeats itself here, because a browser
    // strips these characters before reading the scheme. Parsing as a URL is
    // what makes this safe rather than a guess.
    for (const url of [
      'java\nscript:alert(1)',
      'java\tscript:alert(1)',
      'java\0script:alert(1)',
    ]) {
      expect(safeUrl(url), JSON.stringify(url)).toBeNull()
    }
  })

  it('refuses a protocol-relative URL, which is not a relative path', () => {
    // `//evil.test` inherits the page's scheme and leaves the site, which is
    // never what a caller passing a served path means.
    expect(safeUrl('//evil.test/x')).toBeNull()
  })

  it('refuses nothing at all', () => {
    expect(safeUrl('')).toBeNull()
    expect(safeUrl(null)).toBeNull()
    expect(safeUrl(undefined)).toBeNull()
  })
})
