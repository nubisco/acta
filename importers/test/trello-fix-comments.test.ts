import { describe, expect, it } from 'bun:test'
import { parseImportedComment } from '../src/trello/run'

describe('parseImportedComment', () => {
  it('splits author, date and body', () => {
    expect(
      parseImportedComment(
        '**[imported]** Ivan Marjanovic · 2026-08-28T09:00:00.000Z:\n\nShipping this week.',
      ),
    ).toEqual({
      author: 'Ivan Marjanovic',
      date: '2026-08-28T09:00:00.000Z',
      rest: 'Shipping this week.',
    })
  })

  it('keeps separators inside author and body intact', () => {
    expect(
      parseImportedComment(
        '**[imported]** a · b · 2026-01-01T00:00:00.000Z:\n\nx · y:\n\nz',
      ),
    ).toEqual({
      author: 'a · b',
      date: '2026-01-01T00:00:00.000Z',
      rest: 'x · y:\n\nz',
    })
  })

  it('returns an empty rest for prefix-only bodies', () => {
    expect(
      parseImportedComment('**[imported]** a · 2026-01-01T00:00:00.000Z:\n\n'),
    ).toEqual({ author: 'a', date: '2026-01-01T00:00:00.000Z', rest: '' })
  })

  it('rejects bodies without the prefix or with a malformed header', () => {
    expect(parseImportedComment('plain human comment')).toBeNull()
    expect(parseImportedComment('**[imported]** no separator\n\nx')).toBeNull()
    expect(
      parseImportedComment('prefixed **[imported]** a · b:\n\nx'),
    ).toBeNull()
  })
})
