/**
 * The document chrome's reading of the markdown: stats and the outline.
 *
 * The stats test is the specification of what "a word" means here, written
 * out against a document that has every kind of thing the count has to see
 * past. If a change to the parser moves one of these numbers, the documented
 * rule in lib/docText.ts has to move with it.
 */
import { describe, expect, it } from 'vitest'
import {
  activeHeadingIndex,
  countWords,
  documentOutline,
  documentStats,
  outlineTree,
  readableBlocks,
  tocWorthShowing,
  TOC_MIN_WORDS,
} from '@/lib/docText'

const MIXED = [
  '# Deploy **guide**',
  '',
  'Run the `make deploy` target, then check [the dashboard](https://example.com/dash).',
  '',
  '- [ ] Tell the team',
  '- [x] Tag the release',
  '',
  '> [!NOTE] Heads up',
  '> Rollbacks take $O(n)$ time.',
  '',
  '```sh',
  'make deploy ENV=production',
  'echo done and dusted with plenty of words here',
  '```',
  '',
  '```mermaid',
  'graph TD; Start --> Finish',
  '```',
  '',
  '$$',
  'E = mc^2 + \\text{several words of maths source}',
  '$$',
  '',
  '| Region | Owner |',
  '| --- | --- |',
  '| EU | Ana |',
  '',
  '![a picture with a long alt text](attachment:abc){align=center}',
  '',
  ':::details More detail',
  '',
  'Hidden until opened.',
  '',
  ':::',
  '',
  'See [[doc:runbook|the runbook]] and [[OPS-12]].',
  '',
].join('\n')

describe('document stats', () => {
  it('reads only what a reader reads', () => {
    expect(readableBlocks(MIXED)).toEqual([
      'Deploy guide',
      'Run the make deploy target, then check the dashboard.',
      'Tell the team',
      'Tag the release',
      'Heads up Rollbacks take time.',
      'Region',
      'Owner',
      'EU',
      'Ana',
      'More detail',
      'Hidden until opened.',
      'See the runbook and OPS-12.',
    ])
  })

  it('gives the documented counts for code, maths and markdown syntax', () => {
    const stats = documentStats(MIXED)
    // 2 + 9 + 3 + 3 + 5 + 4 table cells + 2 + 3 + 5. Nothing from the shell
    // fence, the mermaid fence, the $$ block, the inline $O(n)$, the image
    // alt text, the link URL or any marker.
    expect(stats.words).toBe(36)
    expect(stats.characters).toBe(
      readableBlocks(MIXED).reduce((sum, block) => sum + block.length, 0),
    )
    expect(stats.characters).toBe(196)
    expect(stats.readingMinutes).toBe(1)
  })

  it('rounds reading time up at 238 words a minute', () => {
    expect(documentStats('word '.repeat(238)).readingMinutes).toBe(1)
    expect(documentStats('word '.repeat(239)).readingMinutes).toBe(2)
    expect(documentStats('').readingMinutes).toBe(0)
    expect(documentStats('```\ncode only\n```').words).toBe(0)
  })

  it('does not count punctuation on its own, and counts CJK by character', () => {
    expect(countWords('one - two | three')).toBe(3)
    expect(countWords('日本語 text')).toBe(4)
  })
})

describe('document outline', () => {
  const NESTED = [
    '## Intro',
    '### Background',
    '#### Detail',
    '## Setup',
    '#### Skipped a level',
    '# Top',
    '## Setup',
  ].join('\n\n')

  it('nests by level, relative rather than absolute', () => {
    const outline = documentOutline(NESTED)
    expect(outline.map((e) => [e.text, e.depth])).toEqual([
      ['Intro', 0],
      ['Background', 1],
      ['Detail', 2],
      ['Setup', 0],
      // Straight under an h2: one step in, not an empty indent and then one.
      ['Skipped a level', 1],
      ['Top', 0],
      ['Setup', 1],
    ])
    const tree = outlineTree(outline)
    expect(tree.map((n) => n.text)).toEqual(['Intro', 'Setup', 'Top'])
    expect(tree[0].children[0].children[0].text).toBe('Detail')
    expect(tree[2].children[0].text).toBe('Setup')
  })

  it('uses the same slugs the reader anchors headings with', () => {
    const slugs = documentOutline(NESTED).map((e) => e.slug)
    // A repeated heading gets `~2`, exactly as sectionMap and the API do.
    expect(slugs.filter((s) => s.startsWith('setup'))).toEqual([
      'setup',
      'setup~2',
    ])
  })

  it('shows headings without their markdown', () => {
    expect(documentOutline('## Using **bold** and `code`')[0].text).toBe(
      'Using bold and code',
    )
  })

  it('ignores heading-like lines inside code fences', () => {
    expect(documentOutline('```\n# not a heading\n```\n\n# Real')).toHaveLength(
      1,
    )
  })

  it('is hidden on a short document', () => {
    const three = '# A\n\n## B\n\n## C\n\nA few words.'
    const outline = documentOutline(three)
    expect(tocWorthShowing(outline, documentStats(three).words, three)).toBe(
      false,
    )
    // Two headings is never enough, however long the page.
    const two = documentOutline('# A\n\n## B')
    expect(tocWorthShowing(two, 5000, '# A\n\n## B')).toBe(false)
    // Enough prose, or enough page, and it earns its place.
    expect(tocWorthShowing(outline, TOC_MIN_WORDS, three)).toBe(true)
    const longCode = `${three}\n\n\`\`\`\n${'x\n'.repeat(60)}\`\`\``
    expect(
      tocWorthShowing(
        documentOutline(longCode),
        documentStats(longCode).words,
        longCode,
      ),
    ).toBe(true)
  })
})

describe('active heading', () => {
  it('is the last heading scrolled past the threshold', () => {
    expect(activeHeadingIndex([200, 900, 1600], 96)).toBe(-1)
    expect(activeHeadingIndex([40, 700, 1400], 96)).toBe(0)
    expect(activeHeadingIndex([-600, 90, 800], 96)).toBe(1)
  })

  it('is the last heading on screen once the page cannot scroll further', () => {
    expect(
      activeHeadingIndex([-900, 20, 500], 96, {
        atBottom: true,
        viewportHeight: 800,
      }),
    ).toBe(2)
  })
})
