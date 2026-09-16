/**
 * Anchoring: finding a commented stretch of text again after the document
 * has been edited, and saying so honestly when it cannot be found.
 */
import { describe, expect, it } from 'vitest'
import {
  anchorFromQuote,
  anchorTextFromMarkdown,
  createAnchor,
  editDistance,
  normalizeText,
  resolveAnchor,
  type IAnchor,
} from '../src/anchors'

/** An anchor on the first occurrence of `quote` after `from`. */
function anchorOn(text: string, quote: string, from = 0): IAnchor {
  const start = text.indexOf(quote, from)
  if (start === -1) throw new Error(`fixture: "${quote}" not in text`)
  return createAnchor(text, start, start + quote.length)
}

/** The text an anchor resolves to, or null when detached. */
function resolvedText(text: string, anchor: IAnchor): string | null {
  const found = resolveAnchor(text, anchor)
  return found.status === 'anchored' ? text.slice(found.start, found.end) : null
}

const DOC = [
  'Release plan',
  'We ship the audio host on Friday after the soak test passes.',
  'Risks',
  'The licensing service must be reachable, or activation stalls.',
].join('\n')

describe('createAnchor', () => {
  it('records the quote, its context and its position', () => {
    const anchor = anchorOn(DOC, 'the soak test')
    expect(anchor.exact).toBe('the soak test')
    expect(DOC.endsWith(anchor.prefix, anchor.start)).toBe(true)
    expect(anchor.prefix.length).toBe(32)
    expect(DOC.startsWith(anchor.suffix, anchor.end)).toBe(true)
  })

  it('trims whitespace a selection dragged along', () => {
    const start = DOC.indexOf('Risks') - 1
    const anchor = createAnchor(DOC, start, start + 7)
    expect(anchor.exact).toBe('Risks')
  })

  it('refuses an empty range', () => {
    expect(() => createAnchor(DOC, 4, 4)).toThrow(RangeError)
    expect(() => createAnchor('a   b', 1, 4)).toThrow(RangeError)
  })
})

describe('resolveAnchor', () => {
  it('finds an exact match where it was', () => {
    const anchor = anchorOn(DOC, 'licensing service')
    const found = resolveAnchor(DOC, anchor)
    expect(found).toMatchObject({
      status: 'anchored',
      method: 'exact',
      start: anchor.start,
      end: anchor.end,
    })
  })

  it('disambiguates a repeated phrase by its context', () => {
    const text =
      'First, run the tests locally before pushing anything.\n' +
      'Second, deploy to staging and run the tests again there.'
    const second = anchorOn(text, 'run the tests', text.indexOf('Second'))
    // A position hint that points at the FIRST occurrence, as it would after
    // the first paragraph was rewritten: context has to win over position.
    const misleading = { ...second, start: 11, end: 24 }
    const found = resolveAnchor(text, misleading)
    expect(found.status).toBe('anchored')
    if (found.status !== 'anchored') return
    expect(found.start).toBe(text.lastIndexOf('run the tests'))
  })

  it('follows the text when something is inserted before it', () => {
    const anchor = anchorOn(DOC, 'activation stalls')
    const edited =
      'A new introduction paragraph that pushes everything down.\n\n' + DOC
    const found = resolveAnchor(edited, anchor)
    expect(found.status).toBe('anchored')
    if (found.status !== 'anchored') return
    expect(edited.slice(found.start, found.end)).toBe('activation stalls')
    expect(found.start).toBe(edited.indexOf('activation stalls'))
  })

  it('survives whitespace differences between surfaces', () => {
    const anchor = anchorOn(DOC, 'Risks\nThe licensing')
    const reflowed = DOC.replace('Risks\n', 'Risks\n\n   ')
    expect(resolvedText(reflowed, anchor)).toBe('Risks\n\n   The licensing')
  })

  it('re-anchors text that was lightly edited', () => {
    const anchor = anchorOn(DOC, 'We ship the audio host on Friday')
    const edited = DOC.replace('on Friday', 'on Thursday')
    const found = resolveAnchor(edited, anchor)
    expect(found.status).toBe('anchored')
    if (found.status !== 'anchored') return
    expect(found.method).not.toBe('exact')
    expect(edited.slice(found.start, found.end)).toBe(
      'We ship the audio host on Thursday',
    )
  })

  it('re-anchors a light edit even without surviving context', () => {
    const text =
      'The licensing service must be reachable, or activation stalls.'
    const anchor = {
      ...anchorOn(text, 'service must be reachable'),
      prefix: '',
      suffix: '',
    }
    const edited =
      'The licensing service must stay reachable, or activation stalls.'
    expect(resolvedText(edited, anchor)).toBe('service must stay reachable')
  })

  it('detaches, and does not throw or guess, when the text is deleted', () => {
    const anchor = anchorOn(DOC, 'The licensing service must be reachable')
    const edited = DOC.replace(
      'The licensing service must be reachable, or activation stalls.',
      '',
    )
    expect(resolveAnchor(edited, anchor)).toEqual({ status: 'detached' })
    // Detached is not lost: the same anchor matches again if the text returns.
    expect(resolveAnchor(DOC, anchor).status).toBe('anchored')
  })

  it('does not move a short quote onto an unrelated occurrence', () => {
    const text = 'Ship on Friday. Nothing else is planned for this week at all.'
    const anchor = anchorOn(text, 'Friday')
    const edited =
      'Unrelated notes about the office. Pizza is on Friday for everyone who stays.'
    expect(resolveAnchor(edited, anchor).status).toBe('detached')
  })

  it('stays fast on a large document', () => {
    const big = 'lorem ipsum dolor sit amet '.repeat(20_000)
    const anchor = {
      exact: 'a sentence that is not in the document at all',
      prefix: '',
      suffix: '',
      start: 250_000,
      end: 250_046,
    }
    const t0 = performance.now()
    expect(resolveAnchor(big, anchor).status).toBe('detached')
    expect(performance.now() - t0).toBeLessThan(2000)
  })
})

describe('anchorFromQuote', () => {
  it('anchors a unique quote', () => {
    const found = anchorFromQuote(DOC, { exact: 'soak test' })
    expect(found.ok).toBe(true)
    if (found.ok) expect(found.anchor.start).toBe(DOC.indexOf('soak test'))
  })

  it('refuses an ambiguous quote until context narrows it', () => {
    const text = 'run the tests. Then run the tests again.'
    expect(anchorFromQuote(text, { exact: 'run the tests' })).toEqual({
      ok: false,
      reason: 'ambiguous',
      count: 2,
    })
    const narrowed = anchorFromQuote(text, {
      exact: 'run the tests',
      prefix: 'Then',
    })
    expect(narrowed.ok).toBe(true)
    if (narrowed.ok) expect(narrowed.anchor.start).toBe(20)
    const bySuffix = anchorFromQuote(text, {
      exact: 'run the tests',
      suffix: 'again',
    })
    expect(bySuffix.ok && bySuffix.anchor.start).toBe(20)
  })

  it('refuses a quote that is not there', () => {
    expect(anchorFromQuote(DOC, { exact: 'on Saturday' })).toMatchObject({
      ok: false,
      reason: 'not_found',
    })
  })

  it('accepts a quote copied from the markdown source', () => {
    const text = anchorTextFromMarkdown('We **must** ship `v2` today.')
    const found = anchorFromQuote(text, { exact: 'We **must** ship `v2`' })
    expect(found.ok).toBe(true)
    if (found.ok) expect(found.anchor.exact).toBe('We must ship v2')
  })
})

describe('anchorTextFromMarkdown', () => {
  it('keeps the words and drops the syntax', () => {
    const md = [
      '# Title',
      '',
      '> [!NOTE]',
      '> A **bold** and _italic_ [link](https://x.y) note.',
      '',
      '- [ ] a task with `code`',
      '1. numbered',
      '',
      '| a | b |',
      '| --- | --- |',
      '| c | d |',
      '',
      '```ts',
      'const x = 1',
      '```',
      '![alt](attachment:123)',
    ].join('\n')
    const text = normalizeText(anchorTextFromMarkdown(md)).text.trim()
    expect(text).toBe(
      'Title A bold and italic link note. a task with code numbered a b c d const x = 1',
    )
  })
})

describe('long anchors (a whole block)', () => {
  const block =
    'Stagewright loads every plugin in its own process, so a crash in one ' +
    'instrument never takes the whole performance down with it. The host ' +
    'restarts the plugin, restores its last saved state, and reconnects its ' +
    'audio and MIDI routing before the next bar. Performers see a short ' +
    'notice rather than silence, and the set list carries on from where it ' +
    'was. This is the property the architecture exists to protect.'
  const text = `Intro paragraph.\n${block}\nClosing paragraph.`

  it('re-anchors a lightly edited block', () => {
    const anchor = anchorOn(text, block)
    const edited = text
      .replace('never takes', 'never brings')
      .replace('short notice', 'brief notice')
    // With context, and without it (the fuzzy path on its own).
    for (const candidate of [anchor, { ...anchor, prefix: '', suffix: '' }]) {
      const found = resolveAnchor(edited, candidate)
      expect(found.status).toBe('anchored')
      if (found.status !== 'anchored') return
      const match = edited.slice(found.start, found.end)
      expect(match).toMatch(/^Stagewright loads/)
      expect(match).toMatch(/to protect\.$/)
    }
    const fuzzy = resolveAnchor(edited, { ...anchor, prefix: '', suffix: '' })
    expect(fuzzy).toMatchObject({ method: 'fuzzy' })
  })

  it('detaches a block that was deleted', () => {
    const anchor = anchorOn(text, block)
    expect(resolveAnchor(text.replace(block, ''), anchor).status).toBe(
      'detached',
    )
  })
})

describe('editDistance', () => {
  it('matches the textbook values and respects its bound', () => {
    expect(editDistance('kitten', 'sitting')).toBe(3)
    expect(editDistance('', 'abc')).toBe(3)
    expect(editDistance('same', 'same')).toBe(0)
    expect(editDistance('kitten', 'sitting', 1)).toBe(2)
  })
})
