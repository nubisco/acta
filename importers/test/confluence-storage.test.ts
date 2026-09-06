import { describe, expect, it } from 'bun:test'
import { storageToMarkdown } from '../src/confluence/storage'

const OPTS = {
  resolvePage: (title: string) =>
    title === 'The Nubisco Manual' ? 'manual/the-nubisco-manual' : null,
  trelloBoards: { PZWcHkir: 'SW' },
}

function md(xml: string): string {
  return storageToMarkdown(xml, OPTS).markdown
}

describe('storageToMarkdown: base constructs', () => {
  it('converts paragraphs and headings h1-h6', () => {
    expect(md('<h1>One</h1><p>Text.</p><h6>Deep</h6>')).toBe(
      '# One\n\nText.\n\n###### Deep',
    )
  })

  it('converts inline marks', () => {
    expect(
      md(
        '<p><strong>b</strong> <em>i</em> <code>c()</code> <s>gone</s> <u>u</u></p>',
      ),
    ).toBe('**b** *i* `c()` ~~gone~~ u')
  })

  it('converts nested lists (ul inside ol and vice versa)', () => {
    expect(
      md('<ul><li>One<ul><li>Nested</li></ul></li><li>Two</li></ul>'),
    ).toBe('- One\n  - Nested\n- Two')
    expect(
      md('<ol><li>First<ul><li>Sub</li></ul></li><li>Second</li></ol>'),
    ).toBe('1. First\n   - Sub\n2. Second')
  })

  it('converts external links, keeps text', () => {
    expect(md('<p><a href="https://nubisco.io">the site</a></p>')).toBe(
      '[the site](https://nubisco.io)',
    )
  })

  it('converts tables to GFM with header row and escaped pipes', () => {
    expect(
      md(
        '<table><tbody><tr><th>Role</th><th>Owner</th></tr><tr><td>CEO</td><td>a|b</td></tr></tbody></table>',
      ),
    ).toBe('| Role | Owner |\n| --- | --- |\n| CEO | a\\|b |')
  })

  it('converts hr and blockquote', () => {
    expect(md('<hr /><blockquote><p>Quoted.</p></blockquote>')).toBe(
      '---\n\n> Quoted.',
    )
  })

  it('decodes entities and preserves CDATA', () => {
    expect(md('<p>caf&#233; &amp; more&nbsp;here</p>')).toBe('café & more here')
  })

  it('renders task lists as GFM checkboxes', () => {
    expect(
      md(
        '<ac:task-list><ac:task><ac:task-status>complete</ac:task-status><ac:task-body>Done thing</ac:task-body></ac:task><ac:task><ac:task-status>incomplete</ac:task-status><ac:task-body>Open thing</ac:task-body></ac:task></ac:task-list>',
      ),
    ).toBe('- [x] Done thing\n- [ ] Open thing')
  })
})

describe('storageToMarkdown: macros', () => {
  it('maps panels to callouts with the title param', () => {
    expect(
      md(
        '<ac:structured-macro ac:name="info"><ac:parameter ac:name="title">Read me</ac:parameter><ac:rich-text-body><p>Body.</p></ac:rich-text-body></ac:structured-macro>',
      ),
    ).toBe('> [!INFO] Read me\n> Body.')
    expect(
      md(
        '<ac:structured-macro ac:name="warning"><ac:rich-text-body><p>Careful.</p></ac:rich-text-body></ac:structured-macro>',
      ),
    ).toBe('> [!WARNING]\n> Careful.')
    expect(
      md(
        '<ac:structured-macro ac:name="note"><ac:rich-text-body><p>Note.</p></ac:rich-text-body></ac:structured-macro>',
      ),
    ).toBe('> [!NOTE]\n> Note.')
  })

  it('maps expand to :::details', () => {
    expect(
      md(
        '<ac:structured-macro ac:name="expand"><ac:parameter ac:name="title">Phase 1</ac:parameter><ac:rich-text-body><p>Hidden.</p></ac:rich-text-body></ac:structured-macro>',
      ),
    ).toBe(':::details Phase 1\nHidden.\n:::')
  })

  it('handles expand nested inside a panel (prefixed lines)', () => {
    expect(
      md(
        '<ac:structured-macro ac:name="note"><ac:rich-text-body><p>Careful.</p><ac:structured-macro ac:name="expand"><ac:parameter ac:name="title">More</ac:parameter><ac:rich-text-body><p>Hidden.</p></ac:rich-text-body></ac:structured-macro></ac:rich-text-body></ac:structured-macro>',
      ),
    ).toBe('> [!NOTE]\n> Careful.\n>\n> :::details More\n> Hidden.\n> :::')
  })

  it('maps code macros to fenced blocks with language', () => {
    expect(
      md(
        '<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">ts</ac:parameter><ac:plain-text-body><![CDATA[const a = 1 < 2]]></ac:plain-text-body></ac:structured-macro>',
      ),
    ).toBe('```ts\nconst a = 1 < 2\n```')
  })

  it('maps panel divs to callouts by data-panel-type', () => {
    expect(md('<div data-type="panel" data-panel-type="info"><p>I.</p></div>')).toBe(
      '> [!INFO]\n> I.',
    )
    expect(md('<div data-type="panel" data-panel-type="tip"><p>T.</p></div>')).toBe(
      '> [!TIP]\n> T.',
    )
    expect(
      md('<div data-type="panel" data-panel-type="success"><p>S.</p></div>'),
    ).toBe('> [!TIP]\n> S.')
    expect(md('<div data-type="panel" data-panel-type="note"><p>N.</p></div>')).toBe(
      '> [!NOTE]\n> N.',
    )
    expect(
      md('<div data-type="panel" data-panel-type="warning"><p>W.</p></div>'),
    ).toBe('> [!WARNING]\n> W.')
    expect(
      md('<div data-type="panel" data-panel-type="error"><p>E.</p></div>'),
    ).toBe('> [!WARNING]\n> E.')
  })

  it('defaults custom or untyped panel divs to NOTE', () => {
    expect(
      md('<div data-type="panel-custom" data-panel-type="x"><p>C.</p></div>'),
    ).toBe('> [!NOTE]\n> C.')
    expect(md('<div data-type="panel"><p>P.</p></div>')).toBe('> [!NOTE]\n> P.')
  })

  it('keeps non-panel divs as flat containers', () => {
    expect(md('<div class="wrap"><p>a</p><p>b</p></div>')).toBe('a\n\nb')
  })

  it('preserves unknown macros as NOTE callouts and reports them', () => {
    const result = storageToMarkdown(
      '<ac:structured-macro ac:name="jira"><ac:rich-text-body><p>PROJ-1</p></ac:rich-text-body></ac:structured-macro>',
      OPTS,
    )
    expect(result.markdown).toBe(
      '> [!NOTE] Unmapped Confluence macro: jira\n> PROJ-1',
    )
    expect(result.issues.unknownMacros).toEqual(['jira'])
  })
})

describe('storageToMarkdown: references', () => {
  it('maps ri:page links to [[doc:slug]] and aliases custom text', () => {
    expect(
      md(
        '<p><ac:link><ri:page ri:content-title="The Nubisco Manual" /></ac:link></p>',
      ),
    ).toBe('[[doc:manual/the-nubisco-manual]]')
    expect(
      md(
        '<p><ac:link><ri:page ri:content-title="The Nubisco Manual" /><ac:plain-text-link-body><![CDATA[the manual]]></ac:plain-text-link-body></ac:link></p>',
      ),
    ).toBe('[[doc:manual/the-nubisco-manual|the manual]]')
  })

  it('reports unresolved page links but still emits a slugified ref', () => {
    const result = storageToMarkdown(
      '<p><ac:link><ri:page ri:content-title="Missing Page" /></ac:link></p>',
      OPTS,
    )
    expect(result.markdown).toBe('[[doc:missing-page]]')
    expect(result.issues.unresolvedLinks).toEqual(['page "Missing Page"'])
  })

  it('maps known Trello board urls to [[board:KEY]]', () => {
    expect(
      md(
        '<p><a href="https://trello.com/b/PZWcHkir/stagewright">https://trello.com/b/PZWcHkir/stagewright</a></p>',
      ),
    ).toBe('[[board:SW]]')
    expect(
      md(
        '<p><a href="https://trello.com/b/PZWcHkir/stagewright">the board</a></p>',
      ),
    ).toBe('[[board:SW|the board]]')
  })

  it('keeps unknown Trello board urls as links and reports them', () => {
    const result = storageToMarkdown(
      '<p><a href="https://trello.com/b/zzzzzzzz/other">other</a></p>',
      OPTS,
    )
    expect(result.markdown).toBe('[other](https://trello.com/b/zzzzzzzz/other)')
    expect(result.issues.unresolvedLinks).toHaveLength(1)
  })

  it('converts external images and skips attachment images with a report line', () => {
    expect(
      md(
        '<p><ac:image ac:alt="logo"><ri:url ri:value="https://img.test/logo.png" /></ac:image></p>',
      ),
    ).toBe('![logo](https://img.test/logo.png)')
    const result = storageToMarkdown(
      '<p><ac:image><ri:attachment ri:filename="shot.png" /></ac:image></p>',
      OPTS,
    )
    expect(result.markdown).toBe('')
    expect(result.issues.skippedAttachments).toEqual(['shot.png'])
  })
})

describe('storageToMarkdown: layout and structure', () => {
  it('flattens layout sections into plain blocks', () => {
    expect(
      md(
        '<ac:layout><ac:layout-section><ac:layout-cell><p>Left.</p></ac:layout-cell><ac:layout-cell><p>Right.</p></ac:layout-cell></ac:layout-section></ac:layout>',
      ),
    ).toBe('Left.\n\nRight.')
  })

  it('survives self-closing macros and stray whitespace between blocks', () => {
    const result = storageToMarkdown(
      '<p>a</p>\n  \n<ac:structured-macro ac:name="toc" />\n<p>b</p>',
      OPTS,
    )
    expect(result.markdown).toContain('a')
    expect(result.markdown).toContain('b')
    expect(result.issues.unknownMacros).toEqual(['toc'])
  })

  it('converts br to a line break inside a paragraph', () => {
    expect(md('<p>one<br />two</p>')).toBe('one\ntwo')
  })
})
