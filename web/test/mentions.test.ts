/**
 * A mention has to BE a mention.
 *
 * The typeahead inserted plain `@handle`, which is prose that looks like one:
 * extractRefs only sees the bracketed form, the reader only renders that as a
 * mention, and only that reaches the link table. So the text looked right in
 * the editor and notified nobody, which is the worst shape a bug can take.
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

  // What the typeahead used to insert. Kept as a test because the editor
  // rendered it identically to the reader's plain text, so nothing else
  // would have caught it.
  it('is not a reference when written as bare prose', () => {
    expect(extractRefs('please look @ivan')).toEqual([])
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
