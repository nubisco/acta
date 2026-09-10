import { describe, expect, it } from 'vitest'
import { isSpaceKey, isDocSlug, parseItemKey, slugify } from '../src/keys'

describe('keys', () => {
  it('validates space keys', () => {
    expect(isSpaceKey('SW')).toBe(true)
    expect(isSpaceKey('DOOD')).toBe(true)
    expect(isSpaceKey('X')).toBe(false)
    expect(isSpaceKey('TOOLONG')).toBe(false)
    expect(isSpaceKey('sw')).toBe(false)
  })

  it('parses item keys', () => {
    expect(parseItemKey('SW-142')).toEqual({ space: 'SW', seq: 142 })
    expect(parseItemKey('SW142')).toBeNull()
  })

  it('validates doc slugs', () => {
    expect(isDocSlug('manual/vision')).toBe(true)
    expect(isDocSlug('Manual/Vision')).toBe(false)
    expect(isDocSlug('a//b')).toBe(false)
  })

  it('slugifies with diacritics and punctuation', () => {
    expect(slugify('Decisão & Delegação!')).toBe('decisao-delegacao')
    expect(slugify('Getting  Started')).toBe('getting-started')
  })
})
