import { describe, expect, it } from 'bun:test'
import { isSpaceKey } from '@nubisco/acta-shared'

describe('importers package', () => {
  it('links the shared package', () => {
    expect(isSpaceKey('SW')).toBe(true)
  })
})
