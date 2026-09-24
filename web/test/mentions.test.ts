/**
 * A mention has to BE a mention.
 *
 * This file used to assert that `@ivan` was prose and only `[[@ivan]]` was a
 * mention, and the fix at the time was to make the typeahead write brackets.
 * That left the case its own header warns about: text that looks right and
 * notifies nobody. Nobody uses the typeahead. In our own workspace not one
 * mention was ever bracketed, so every mention ever written was the bug.
 *
 * Both forms are references now. What stops prose becoming a mention is no
 * longer the brackets, it is the two rules below: the shape has to be a
 * handle rather than an address, a domain or code, and it has to name
 * somebody the workspace knows.
 */
import { describe, expect, it } from 'vitest'
import { extractRefs } from '@nubisco/acta-shared'

describe('mention syntax', () => {
  it('is extracted as an actor reference', () => {
    const refs = extractRefs('please look [[@ivan]] and [[@daniela]]')
    expect(refs.map((r) => [r.type, r.target])).toEqual([
      ['actor', 'ivan'],
      ['actor', 'daniela'],
    ])
  })

  it('is extracted when written the way people type it', () => {
    const refs = extractRefs('please look @ivan and @daniela')
    expect(refs.map((r) => [r.type, r.target])).toEqual([
      ['actor', 'ivan'],
      ['actor', 'daniela'],
    ])
    expect(refs.every((r) => r.bare)).toBe(true)
  })

  it('does not read an address, a domain, a URL or code as one', () => {
    expect(extractRefs('write to ivan@nubisco.io')).toEqual([])
    expect(extractRefs('mail us @nubisco.io')).toEqual([])
    expect(extractRefs('see https://x.com/@ivan')).toEqual([])
    expect(extractRefs('use `@ivan` in the template')).toEqual([])
  })

  it('counts a bracketed mention once, not twice', () => {
    expect(extractRefs('[[@ivan]]').map((r) => r.target)).toEqual(['ivan'])
  })
})

describe('what the @ typeahead writes', () => {
  it('inserts the bracketed form', async () => {
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync('src/components/editor/suggestions.ts', 'utf8'),
    )
    // Read from source rather than driving tiptap: the failure mode was a
    // one-line template, and the assertion should name it exactly.
    expect(src).toContain('inserter(`[[@${a.handle}]] `)')
    expect(src).not.toContain('inserter(`@${a.handle} `)')
  })
})
