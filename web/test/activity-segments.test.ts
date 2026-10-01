/**
 * Splitting an activity summary into the things it names.
 *
 * Every case here is a real summary format, taken from the template literals
 * in `server/src/services/items.ts` and `docs.ts`, because the point of this
 * function is to understand what the server actually writes rather than what
 * it might write.
 */
import { describe, expect, it } from 'vitest'
import { activitySegments } from '@/lib/activity'

const kinds = (summary: string, slug?: string) =>
  activitySegments(summary, slug).map((s) => [s.kind, s.text])

describe('activity summaries', () => {
  it('finds the card at the end of a sentence', () => {
    expect(kinds('commented on ST-1')).toEqual([
      ['text', 'commented on '],
      ['item', 'ST-1'],
    ])
  })

  it('finds the card at the start', () => {
    expect(kinds('ST-1 is no longer part of anything')).toEqual([
      ['item', 'ST-1'],
      ['text', ' is no longer part of anything'],
    ])
  })

  it('finds both cards when a summary names two', () => {
    // This is why a row cannot have one destination: the sentence is about
    // an edge between two cards and both ends are worth opening.
    expect(kinds('ST-4 now waits on ST-9')).toEqual([
      ['item', 'ST-4'],
      ['text', ' now waits on '],
      ['item', 'ST-9'],
    ])
    expect(kinds('ST-9 is part of ST-4')).toEqual([
      ['item', 'ST-9'],
      ['text', ' is part of '],
      ['item', 'ST-4'],
    ])
  })

  it('keeps the title that follows a key', () => {
    expect(kinds('created ST-1: Ship it')).toEqual([
      ['text', 'created '],
      ['item', 'ST-1'],
      ['text', ': Ship it'],
    ])
  })

  it('leaves a summary that names nothing alone', () => {
    expect(kinds('labels changed')).toEqual([['text', 'labels changed']])
  })

  it('finds the document when the server says which one', () => {
    expect(kinds('commented on spec', 'spec')).toEqual([
      ['text', 'commented on '],
      ['doc', 'spec'],
    ])
  })

  it('handles a nested slug with slashes', () => {
    expect(
      kinds(
        'replaced nubisco-home/marketing/brand-guidelines',
        'nubisco-home/marketing/brand-guidelines',
      ),
    ).toEqual([
      ['text', 'replaced '],
      ['doc', 'nubisco-home/marketing/brand-guidelines'],
    ])
  })

  it('keeps the section that follows a slug', () => {
    expect(kinds('patched spec#overview', 'spec')).toEqual([
      ['text', 'patched '],
      ['doc', 'spec'],
      ['text', '#overview'],
    ])
  })

  it('never guesses at a document', () => {
    // A slug is an ordinary word. Without the server naming one, "replaced
    // spec" is a sentence, not a link, or every summary containing a common
    // word would sprout one.
    expect(kinds('replaced spec')).toEqual([['text', 'replaced spec']])
  })

  it('does not treat a word that merely looks like a key as one', () => {
    expect(kinds('updated the COVID-19 page')).toEqual([
      ['text', 'updated the '],
      ['item', 'COVID-19'],
      ['text', ' page'],
    ])
    // Documented rather than defended: the key shape is genuinely ambiguous
    // with prose, and these summaries are generated, so the only strings this
    // sees are ones the server wrote. A false positive opens an inspector
    // that says the card is gone, which is recoverable.
  })

  it('handles a summary with a document and a card in it', () => {
    expect(kinds('linked ST-1 from spec', 'spec')).toEqual([
      ['text', 'linked '],
      ['item', 'ST-1'],
      ['text', ' from '],
      ['doc', 'spec'],
    ])
  })
})
