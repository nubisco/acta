/**
 * Inline maths detection, on its own.
 *
 * A lone `$` is ordinary prose: a price, `$PATH`, `$0` in a shell script. The
 * whole risk in this feature is a detector loose enough to read two dollars in
 * a sentence as a formula, which is wrong on screen and, because the editor
 * round-trips through the same rule, a rewrite of the author's line in the
 * file.
 *
 * The rule is documented at the top of `lib/math.ts`. This is that rule as
 * cases, with the false positives first, because those are the ones that
 * matter.
 */
import { describe, expect, it } from 'vitest'
import { findInlineMath, guardMathDelimiters } from '@/lib/math'

/** The formulas found in a line, as the text between the delimiters. */
function formulas(line: string): string[] {
  return findInlineMath(line).map(([start, end]) => line.slice(start + 1, end))
}

describe('what is not a formula', () => {
  it('two prices in a sentence', () => {
    // The closing candidate has a space in front of it, so it cannot close,
    // and there is no other dollar to try.
    expect(formulas('It costs $5 and $10.')).toEqual([])
    expect(formulas('They charge $100 and I charge $200.')).toEqual([])
    expect(formulas('Refund of $5.')).toEqual([])
  })

  it('a hyphenated price range', () => {
    // Here the second dollar DOES pass the space rule, because a hyphen sits
    // in front of it. It is rejected by the digit after it.
    expect(formulas('Between $5-$10 depending on the day.')).toEqual([])
    expect(formulas('$5-$10')).toEqual([])
  })

  it('a shell variable', () => {
    expect(formulas('Add it to $PATH first.')).toEqual([])
    expect(formulas('Export $PATH and $HOME before running it.')).toEqual([])
    expect(formulas('Use $1 for the first argument.')).toEqual([])
  })

  it('a dollar with space against either delimiter', () => {
    expect(formulas('a $ b $ c')).toEqual([])
    expect(formulas('a $x $ b')).toEqual([])
    expect(formulas('a $ x$ b')).toEqual([])
  })

  it('an empty pair', () => {
    expect(formulas('a $$ b')).toEqual([])
  })

  it('a formula that would have to span a line break', () => {
    expect(formulas('open $here\nand close$ there')).toEqual([])
  })

  it('an escaped dollar', () => {
    expect(formulas('a \\$x\\$ b')).toEqual([])
  })
})

describe('what is a formula', () => {
  it('the ordinary case', () => {
    expect(formulas('The identity $e^{i\\pi} + 1 = 0$ is pretty.')).toEqual([
      'e^{i\\pi} + 1 = 0',
    ])
  })

  it('a single symbol', () => {
    expect(formulas('Let $x$ be even.')).toEqual(['x'])
  })

  it('two on one line, kept apart', () => {
    expect(formulas('Both $a$ and $b$ hold.')).toEqual(['a', 'b'])
  })

  it('one that starts with a digit, which prices do not reach', () => {
    // Rule 4 is what separates this from `$5 and $10`: the closing dollar
    // here has a character other than a space in front of it.
    expect(formulas('So $2x + 1$ is odd.')).toEqual(['2x + 1'])
  })
})

/**
 * Escaping on the way back out.
 *
 * markdown-it drops the backslash from `\$` while parsing, so without this the
 * literal an author escaped on purpose is written back bare and read as a
 * formula on the next open: a save that changed what the document says.
 */
describe('delimiters are put back', () => {
  it('escapes a pair that would be read back as a formula', () => {
    expect(guardMathDelimiters('a $x$ b')).toBe('a \\$x\\$ b')
  })

  it('escapes `$$` opening a line', () => {
    expect(guardMathDelimiters('$$\nx\n$$')).toBe('\\$\\$\nx\n\\$\\$')
  })

  it('leaves prose that is not a formula completely alone', () => {
    for (const line of [
      'It costs $5 and $10.',
      'Add it to $PATH first.',
      'Between $5-$10 today.',
      'No dollars here at all.',
    ]) {
      expect(guardMathDelimiters(line), line).toBe(line)
    }
  })
})
