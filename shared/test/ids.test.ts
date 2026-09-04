import { describe, expect, it } from 'vitest'
import { idTime, isId, newId, ulid } from '../src/ids'

describe('ids', () => {
  it('creates prefixed, sortable, parseable ids', () => {
    const t = 1756000000000
    const id = newId('itm', t)
    expect(id).toMatch(/^itm_[0-9a-hjkmnp-tv-z]{26}$/)
    expect(isId(id)).toBe(true)
    expect(isId(id, 'itm')).toBe(true)
    expect(isId(id, 'doc')).toBe(false)
    expect(idTime(id)).toBe(t)
  })

  it('sorts by creation time', () => {
    const a = newId('evt', 1000)
    const b = newId('evt', 2000)
    expect(a < b).toBe(true)
  })

  it('generates unique ids', () => {
    const seen = new Set(Array.from({ length: 1000 }, () => ulid()))
    expect(seen.size).toBe(1000)
  })
})
