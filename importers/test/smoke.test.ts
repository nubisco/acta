import { describe, expect, it } from 'bun:test'
import { isBoardKey } from '@nubisco/acta-shared'

describe('importers package', () => {
  it('links the shared package', () => {
    expect(isBoardKey('SW')).toBe(true)
  })
})
