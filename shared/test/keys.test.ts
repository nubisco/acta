import { describe, expect, it } from 'vitest'
import { isBoardKey, isDocSlug, parseItemKey, slugify } from '../src/keys'

describe('keys', () => {
  it('validates board keys', () => {
    expect(isBoardKey('SW')).toBe(true)
    expect(isBoardKey('DOOD')).toBe(true)
    expect(isBoardKey('X')).toBe(false)
    expect(isBoardKey('TOOLONG')).toBe(false)
    expect(isBoardKey('sw')).toBe(false)
  })

  it('parses item keys', () => {
    expect(parseItemKey('SW-142')).toEqual({ board: 'SW', seq: 142 })
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
