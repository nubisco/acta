/**
 * Colour detection.
 *
 * This runs on every code span in every document, so a false positive is a
 * meaningless coloured dot beside something that was never a colour. The
 * cases that matter are the near misses.
 */
import { describe, expect, it } from 'vitest'
import { isDarkColor, parseColor } from '@/components/decorations/colors'

describe('parseColor', () => {
  it('accepts the forms people actually write', () => {
    for (const value of [
      '#fff',
      '#FFF',
      '#69bb63',
      '#69BB63',
      '#69bb63ff',
      '#abcd',
      'rgb(105, 187, 99)',
      'rgb(105 187 99)',
      'rgba(105, 187, 99, 0.5)',
      'rgb(105 187 99 / 50%)',
      'hsl(210, 50%, 40%)',
      'hsl(210deg 50% 40%)',
      'hsla(210, 50%, 40%, 0.2)',
    ]) {
      expect(parseColor(value), value).toBe(value)
    }
  })

  it('trims, because a code span often carries a space', () => {
    expect(parseColor('  #69bb63  ')).toBe('#69bb63')
  })

  it('refuses things that merely start with a hash', () => {
    // Every one of these appears in ordinary technical writing, and each
    // would otherwise get a swatch.
    for (const value of [
      '#include',
      '#1',
      '#12345',
      '#1234567',
      '#ggg',
      '#',
      'rgb',
      'rgb()',
      'hsl(foo)',
      'red',
      'transparent',
      '#69bb63 and more',
      'color: #69bb63',
    ]) {
      expect(parseColor(value), value).toBeNull()
    }
  })

  it('refuses anything long enough to be prose', () => {
    expect(parseColor('#' + 'a'.repeat(200))).toBeNull()
  })
})

describe('isDarkColor', () => {
  it('measures luma for the hex forms', () => {
    expect(isDarkColor('#000000')).toBe(true)
    expect(isDarkColor('#ffffff')).toBe(false)
    expect(isDarkColor('#000')).toBe(true)
    expect(isDarkColor('#fff')).toBe(false)
    // Green reads light because luma weights green most heavily, which is
    // the point of using luma rather than averaging the channels.
    expect(isDarkColor('#00ff00')).toBe(false)
    expect(isDarkColor('#0000ff')).toBe(true)
  })

  it('ignores the alpha channel rather than guessing at it', () => {
    expect(isDarkColor('#00000000')).toBe(true)
  })

  it('declines to answer for functional colours', () => {
    // A real answer needs a CSS parser. Null means "use the default border",
    // which is legible either way, rather than a wrong guess.
    expect(isDarkColor('rgb(0, 0, 0)')).toBeNull()
  })
})
