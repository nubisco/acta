/**
 * Workspace-relative links.
 *
 * Every route moved under a workspace segment, so a bare `/b/SU` is no longer
 * a valid destination. This is the one function standing between that and
 * eighteen call sites, which makes it worth pinning.
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { setWorkspaceSlug } from '@/api/client'
import { wpath } from '@/lib/paths'

describe('wpath', () => {
  beforeEach(() => setWorkspaceSlug(''))

  it('prefixes the current workspace', () => {
    setWorkspaceSlug('nubisco')
    expect(wpath('/b/SU')).toBe('/nubisco/b/SU')
    expect(wpath('/docs/handbook')).toBe('/nubisco/docs/handbook')
    expect(wpath('/')).toBe('/nubisco/')
  })

  it('leaves paths alone before a workspace is chosen', () => {
    // The login and picker screens render before any workspace exists, and a
    // link there must not gain an empty segment.
    expect(wpath('/settings')).toBe('/settings')
  })

  it('tolerates a path with no leading slash', () => {
    setWorkspaceSlug('acme')
    expect(wpath('docs')).toBe('/acme/docs')
  })

  it('follows a workspace switch', () => {
    setWorkspaceSlug('nubisco')
    expect(wpath('/activity')).toBe('/nubisco/activity')
    setWorkspaceSlug('acme')
    expect(wpath('/activity')).toBe('/acme/activity')
  })
})
