import { describe, expect, it } from 'vitest'
import {
  applySectionEdit,
  extractRefs,
  parseEmbedQuery,
  parseFrontmatter,
  sectionMap,
  sectionText,
  serializeFrontmatter,
} from '../src/markdown'

const DOC = `# Intro

Hello.

## Getting started

Steps here.

\`\`\`md
# not a heading
\`\`\`

## Getting started

Duplicate heading.

# Outro

Bye.
`

describe('sectionMap', () => {
  it('maps sections with duplicate suffixes and skips fenced headings', () => {
    const sections = sectionMap(DOC)
    expect(sections.map((s) => s.slug)).toEqual([
      'intro',
      'getting-started',
      'getting-started~2',
      'outro',
    ])
    const intro = sections[0]
    expect(intro.level).toBe(1)
    expect(sectionText(DOC, sections[1])).toContain('Steps here.')
    expect(sectionText(DOC, sections[1])).toContain('# not a heading')
  })

  it('applies section edits', () => {
    const sections = sectionMap(DOC)
    const edited = applySectionEdit(
      DOC,
      sections[2],
      '## Getting started\n\nRewritten.',
      'replace',
    )
    expect(edited).toContain('Rewritten.')
    expect(edited).not.toContain('Duplicate heading.')
    expect(edited).toContain('Steps here.')
    expect(edited).toContain('Bye.')
  })
})

describe('frontmatter', () => {
  it('round-trips', () => {
    const raw = `---\nid: doc_x\ntitle: Vision\ntags: [handbook, core]\n---\nBody\n`
    const parsed = parseFrontmatter(raw)
    expect(parsed.frontmatter.title).toBe('Vision')
    expect(parsed.frontmatter.tags).toEqual(['handbook', 'core'])
    expect(parsed.body).toBe('Body\n')
    expect(serializeFrontmatter(parsed)).toBe(raw)
  })

  it('passes through bodies without frontmatter', () => {
    expect(parseFrontmatter('Hello').body).toBe('Hello')
  })
})

describe('extractRefs', () => {
  it('extracts all reference kinds and skips code', () => {
    const body = [
      'See [[SW-142]] and [[board:DOOD]] and [[doc:manual/vision|the vision]].',
      'Ping [[@josesilva]].',
      '`[[SW-1]]` is code, and so is:',
      '```',
      '[[SW-2]]',
      '```',
      '![[query: board=SUP state=open]]',
    ].join('\n')
    const refs = extractRefs(body)
    expect(refs.map((r) => [r.type, r.target])).toEqual([
      ['item', 'SW-142'],
      ['board', 'DOOD'],
      ['doc', 'manual/vision'],
      ['actor', 'josesilva'],
      ['query', 'board=SUP state=open'],
    ])
    expect(refs[2].alias).toBe('the vision')
  })
})

describe('parseEmbedQuery', () => {
  it('accepts the fixed grammar only', () => {
    expect(parseEmbedQuery('board=SUP state=open')).toEqual({
      board: 'SUP',
      state: 'open',
    })
    expect(parseEmbedQuery('bogus=1')).toBeNull()
    expect(parseEmbedQuery('state=weird')).toBeNull()
  })
})
