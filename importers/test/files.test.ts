import { describe, expect, it } from 'bun:test'
import { parseStorage } from '../src/confluence/storage'
import {
  attachmentRefs,
  findLinks,
  htmlToMarkdown,
  planMarkdownExport,
  planPageTree,
  readFrontmatter,
  relativePath,
  rewriteLinks,
  safeAssetName,
  splitByHeadings,
  titleFromFilename,
  titleToFilename,
  uniqueName,
  writeFrontmatter,
} from '../src/files'

describe('links', () => {
  it('finds images and links, with attribute blocks and titles', () => {
    const found = findLinks(
      'A ![logo](attachment:att_1 "Logo"){align=center} and [site](https://x.io).',
    )
    expect(found).toHaveLength(2)
    expect(found[0]).toMatchObject({
      image: true,
      text: 'logo',
      target: 'attachment:att_1',
      title: '"Logo"',
      attrs: '{align=center}',
    })
    expect(found[1]).toMatchObject({ image: false, target: 'https://x.io' })
  })

  it('leaves code, formulas and references alone', () => {
    const source = [
      '```md',
      '![not](attachment:att_code)',
      '```',
      '',
      'Inline `![no](attachment:att_span)` here.',
      '',
      '$$',
      '![nope](attachment:att_math)',
      '$$',
      '',
      '![[query:status]] and [[doc:x]]',
      '',
      '![yes](attachment:att_real)',
    ].join('\n')
    expect(attachmentRefs(source)).toEqual(['att_real'])
  })

  it('reads angle-bracket and escaped targets', () => {
    expect(findLinks('![a](<my file.png>)')[0].target).toBe('my file.png')
    expect(findLinks('![a](shot\\(1\\).png)')[0].target).toBe('shot(1).png')
  })

  it('rewrites only what the callback changes', () => {
    const source = '> ![a](attachment:att_1)\n\n[keep](https://x.io)'
    const out = rewriteLinks(source, (match) =>
      match.target === 'attachment:att_1' ? '![a](files/a.png)' : null,
    )
    expect(out).toBe('> ![a](files/a.png)\n\n[keep](https://x.io)')
  })
})

describe('frontmatter', () => {
  it('round-trips a title that would otherwise be misread', () => {
    for (const title of [
      'Plain',
      'Colon: here',
      '[bracketed]',
      '"quoted"',
      '- dash',
    ])
      expect(
        readFrontmatter(`${writeFrontmatter({ title })}body`).meta.title,
      ).toBe(title)
  })

  it('carries tags and order and strips the block from the body', () => {
    const text = `${writeFrontmatter({ title: 'T', tags: ['a', 'b'], order: 3 })}Body.`
    const read = readFrontmatter(text)
    expect(read.meta).toEqual({ title: 'T', tags: ['a', 'b'], order: 3 })
    expect(read.body).toBe('Body.')
  })

  it('treats a file without a block as all body', () => {
    expect(readFrontmatter('---\nnot closed').body).toBe('---\nnot closed')
  })
})

describe('paths', () => {
  it('computes relative paths between folders', () => {
    expect(relativePath('', 'attachments/a.png')).toBe('attachments/a.png')
    expect(relativePath('A/B', 'attachments/a.png')).toBe(
      '../../attachments/a.png',
    )
    expect(relativePath('A', 'A/x.png')).toBe('x.png')
  })

  it('makes names safe and unique', () => {
    expect(safeAssetName('Screen Shot (2).PNG')).toBe('Screen-Shot-2.png')
    expect(titleToFilename('a/b: c?')).toBe('a-b- c-')
    const taken = new Set<string>()
    expect(uniqueName('a.png', taken)).toBe('a.png')
    expect(uniqueName('A.png', taken)).toBe('A-2.png')
  })

  it('removes the id Notion appends to names', () => {
    expect(
      titleFromFilename('Roadmap 0123456789abcdef0123456789abcdef.md'),
    ).toBe('Roadmap')
  })
})

describe('splitByHeadings', () => {
  const doc = [
    'Intro.',
    '# One',
    'a',
    '## One.one',
    'b',
    '```',
    '# in code',
    '```',
    ':::details T',
    '# in toggle',
    ':::',
    '# Two',
    'c',
  ].join('\n')

  it('nests pages by level and keeps structure inside fences and toggles', () => {
    const tree = splitByHeadings(doc, 2, 'Root')
    expect(tree.title).toBe('Root')
    expect(tree.body).toBe('Intro.')
    expect(tree.children.map((c) => c.title)).toEqual(['One', 'Two'])
    expect(tree.children[0].children[0].title).toBe('One.one')
    expect(tree.children[0].children[0].body).toContain('# in code')
    expect(tree.children[0].children[0].body).toContain('# in toggle')
  })

  it('keeps deeper headings in the page', () => {
    const tree = splitByHeadings(doc, 1, 'Root')
    expect(tree.children[0].body).toContain('## One.one')
  })

  it('cleans inline markup out of titles', () => {
    expect(
      splitByHeadings('# The **bold** `code` [link](x)\n\nx', 1, 'R').title,
    ).toBe('The bold code link')
  })
})

describe('planPageTree', () => {
  it('reads the export layout, index files and ordering', () => {
    const tree = planPageTree([
      { path: 'B.md', markdown: '---\ntitle: Bee\norder: 2\n---\n\nb' },
      { path: 'A.md', markdown: '---\ntitle: Ay\norder: 1\n---\n\na' },
      { path: 'A/Child.md', markdown: '# Child title\n\nc' },
      { path: 'Folder/index.md', markdown: 'folder body' },
      { path: 'Folder/Leaf.md', markdown: 'leaf' },
    ])
    expect(tree.map((p) => p.title)).toEqual(['Ay', 'Bee', 'Folder'])
    expect(tree[0].children[0]).toMatchObject({
      title: 'Child title',
      body: 'c',
    })
    expect(tree[2]).toMatchObject({ body: 'folder body' })
    expect(tree[2].children.map((p) => p.title)).toEqual(['Leaf'])
  })

  it('keeps an opening heading when the title came from frontmatter', () => {
    const [page] = planPageTree([
      { path: 'x.md', markdown: '---\ntitle: X\n---\n\n# Heading\n\nBody' },
    ])
    expect(page.body).toBe('# Heading\n\nBody')
  })
})

describe('planMarkdownExport', () => {
  it('writes attachments beside the pages and reports what it cannot resolve', () => {
    const plan = planMarkdownExport(
      [
        {
          slug: 'root',
          title: 'Root',
          body: '![a](attachment:att_1)\n\n![b](attachment:att_gone)',
          children: [
            {
              slug: 'root/kid',
              title: 'Kid',
              body: '![a](attachment:att_1)',
              children: [],
            },
          ],
        },
      ],
      (id) => (id === 'att_1' ? { kind: 'file', filename: 'a b.png' } : null),
    )
    const texts = Object.fromEntries(
      plan.files
        .filter((f) => 'text' in f.content)
        .map((f) => [f.path, (f.content as { text: string }).text]),
    )
    expect(texts['Root.md']).toContain('![a](attachments/a-b.png)')
    expect(texts['Root.md']).toContain('![b](attachment:att_gone)')
    expect(texts['Root/Kid.md']).toContain('![a](../attachments/a-b.png)')
    expect(plan.assetCount).toBe(1)
    expect(plan.unresolved).toEqual([{ slug: 'root', id: 'att_gone' }])
  })
})

describe('htmlToMarkdown', () => {
  const md = (html: string) => htmlToMarkdown(parseStorage(html)).markdown

  it('maps the common block and inline constructs', () => {
    expect(md('<h2>T</h2><p>a <b>b</b> <i>c</i> <code>d</code></p>')).toBe(
      '## T\n\na **b** *c* `d`',
    )
    expect(md('<ul><li>one<ul><li>two</li></ul></li></ul>')).toBe(
      '- one\n\n  - two',
    )
    expect(md('<details><summary>S</summary><p>body</p></details>')).toBe(
      ':::details S\nbody\n:::',
    )
  })

  it('escapes text that markdown would read as syntax', () => {
    expect(md('<p># not a heading, *not* emphasis, $5</p>')).toBe(
      '\\# not a heading, \\*not\\* emphasis, \\$5',
    )
  })

  it('reports what it could not map', () => {
    const result = htmlToMarkdown(
      parseStorage('<h6>Deep</h6><p>x<sup>2</sup></p>'),
    )
    expect(result.markdown).toBe('**Deep**\n\nx2')
    expect(result.issues.length).toBe(2)
  })
})
