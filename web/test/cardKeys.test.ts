/**
 * Card keys written as plain text open the card (Jose, 2026-10-08: wherever
 * the inspector mentions a card, it should be clickable).
 */
import { describe, expect, it } from 'vitest'
import MarkdownIt from 'markdown-it'
import { cardKeysPlugin, splitCardKeys } from '@/lib/cardKeys'

const SPACES = new Set(['CM', 'ST'])

describe('finding card keys in text', () => {
  it('cuts text into words and the keys of spaces that exist', () => {
    expect(
      splitCardKeys('moved here from the archived CM-23, see ST-4.', SPACES),
    ).toEqual([
      { text: 'moved here from the archived ' },
      { key: 'CM-23' },
      { text: ', see ' },
      { key: 'ST-4' },
      { text: '.' },
    ])
  })

  it('leaves alone what only looks like a key', () => {
    for (const text of [
      'UTF-8 and ISO-9001',
      'xCM-2 and CM-2x',
      'https://x.y/CM-2',
      'a-CM-2',
    ])
      expect(splitCardKeys(text, SPACES)).toEqual([{ text }])
  })

  it('leaves a [[ref]] to the pass that draws it', () => {
    expect(splitCardKeys('see [[CM-2]] and CM-3', SPACES)).toEqual([
      { text: 'see [[CM-2]] and ' },
      { key: 'CM-3' },
    ])
  })
})

describe('card keys in markdown', () => {
  const md = new MarkdownIt({ linkify: true })
  md.use(cardKeysPlugin, () => SPACES)

  it('turns a key in prose into a button that opens it', () => {
    expect(md.renderInline('blocked by CM-25 today')).toBe(
      'blocked by <button type="button" class="md__ref md__ref--bare" data-ref-type="item" data-ref="CM-25">CM-25</button> today',
    )
  })

  it('does not touch a key in code or inside a link', () => {
    expect(md.renderInline('`CM-25`')).toBe('<code>CM-25</code>')
    expect(md.renderInline('[CM-25](https://x.y)')).toBe(
      '<a href="https://x.y">CM-25</a>',
    )
  })
})
