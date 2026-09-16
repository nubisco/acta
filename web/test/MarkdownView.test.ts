/**
 * The shared renderer for card descriptions, comments and documents.
 *
 * Two of these pin faults that shipped: single newlines being swallowed, and
 * unbreakable text escaping its column.
 */
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import MarkdownView from '@/components/MarkdownView.vue'

function render(source: string) {
  return mount(MarkdownView, { props: { source } })
}

describe('MarkdownView', () => {
  it('breaks on a single newline', () => {
    // CommonMark joins these into one paragraph. Every surface this renders
    // is typed text where a newline means a newline, which is why the
    // imported support cards read as one run-on line before this was fixed.
    const html = render('**From:** Ana\n**Email:** ana@example.com').html()
    expect(html).toContain('<br>')
    expect(html).toContain('<strong>From:</strong>')
  })

  it('renders a GitHub-style callout with its icon', () => {
    const html = render('> [!WARNING]\n> Mind the gap.').html()
    expect(html).toContain('md__callout--warning')
    expect(html).toContain('md__callout-icon')
    expect(html).toContain('Mind the gap.')
  })

  it('turns a card reference into a chip', () => {
    const html = render('See [[SU-12]] for detail.').html()
    expect(html).toContain('data-ref-type="item"')
    expect(html).toContain('data-ref="SU-12"')
  })

  it('turns a doc reference into a link, not a chip', () => {
    const html = render('See [[doc:handbook]].').html()
    expect(html).toContain('data-ref-type="doc"')
    expect(html).toContain('href="/docs/handbook"')
  })

  it('marks a mention for hydration', () => {
    const html = render('Ask [[@jose]] about it.').html()
    expect(html).toContain('md__mention')
    expect(html).toContain('data-handle="jose"')
  })

  it('leaves an unknown reference as plain text', () => {
    // Better than inventing a link to something that does not exist.
    const html = render('[[not a ref at all]]').html()
    expect(html).not.toContain('md__ref')
  })

  it('renders task lists', () => {
    const html = render('- [ ] todo\n- [x] done').html()
    expect(html).toContain('md__task')
    expect(html).toContain('type="checkbox"')
  })

  it('renders a toggle as a real disclosure', () => {
    const view = render(':::details How it works\n\nSome body text.\n\n:::')
    const el = view.element.querySelector('details')
    expect(el).not.toBeNull()
    expect(el?.querySelector('summary')?.textContent?.trim()).toBe(
      'How it works',
    )
    // Closed to begin with, which is the whole point of a toggle.
    expect(el?.hasAttribute('open')).toBe(false)
    expect(el?.textContent).toContain('Some body text.')
  })

  it('renders markdown inside a toggle rather than its source', () => {
    const view = render(':::details Steps\n\n- one\n- two\n\n:::')
    expect(view.element.querySelector('details ul li')).not.toBeNull()
    expect(view.text()).not.toContain(':::')
  })

  it('nests toggles', () => {
    const view = render(
      ':::details Outer\n\n:::details Inner\n\nDeep.\n\n:::\n\n:::',
    )
    const outer = view.element.querySelector('details')
    expect(outer?.querySelector('summary')?.textContent?.trim()).toBe('Outer')
    const inner = outer?.querySelector('details')
    expect(inner?.querySelector('summary')?.textContent?.trim()).toBe('Inner')
    expect(view.element.querySelectorAll('details').length).toBe(2)
  })

  it('still decorates what is inside a toggle', () => {
    // The callout, reference and Drive passes run over the rendered HTML, so
    // a construct inside a toggle must come out as decorated as one outside.
    const html = render(
      ':::details Detail\n\n> [!TIP]\n> Nested advice.\n\nSee [[SU-12]].\n\n:::',
    ).html()
    expect(html).toContain('md__callout--tip')
    expect(html).toContain('data-ref="SU-12"')
  })

  it('leaves an unterminated toggle as the text somebody typed', () => {
    // Half a toggle is not a toggle. Swallowing the rest of the page into a
    // block nobody closed is worse than showing the marker.
    const view = render(':::details Unclosed\n\nBody.')
    expect(view.element.querySelector('details')).toBeNull()
    expect(view.text()).toContain(':::details Unclosed')
  })

  it('does not treat a fence inside a code block as the end of a toggle', () => {
    const view = render(':::details How to close one\n\n```md\n:::\n```\n\n:::')
    expect(view.element.querySelectorAll('details').length).toBe(1)
    expect(view.element.querySelector('details pre')).not.toBeNull()
  })

  it('does not render markup smuggled through a toggle title', () => {
    const view = render(
      ':::details <img src=x onerror=alert(1)>\n\nBody.\n\n:::',
    )
    expect(view.find('img').exists()).toBe(false)
    expect(view.element.querySelector('summary')?.textContent).toContain(
      'onerror',
    )
  })

  it('does not render raw HTML from user content', () => {
    // markdown-it runs with html:false, so the markup is escaped into text.
    // The assertion is that no element was created, not that the characters
    // are absent: they are, and inert, which is the correct outcome.
    const view = render('<img src=x onerror=alert(1)>')
    expect(view.find('img').exists()).toBe(false)
    expect(view.element.querySelectorAll('*').length).toBeLessThan(4)
    expect(view.text()).toContain('onerror')
  })
})

/**
 * Image alignment and width, which is the half of this feature most people
 * see: the editor is where a picture is placed, the reader is where it is
 * looked at. A block the reader does not understand is a picture that lands
 * differently on the two surfaces and a row of braces printed under it.
 */
describe('MarkdownView image attributes', () => {
  it('gives every picture the shared image class', () => {
    const html = render('![Icon](https://example.test/a.png)').html()
    expect(html).toContain('class="md__img"')
  })

  it('aligns from the attribute block', () => {
    const html = render(
      '![Icon](https://example.test/a.png){align=center}',
    ).html()
    expect(html).toContain('md__img--center')
    // The braces are the instruction, never content.
    expect(html).not.toContain('{align=center}')
  })

  it('sets the width the block asks for', () => {
    const html = render('![Icon](https://example.test/a.png){width=640}').html()
    expect(html).toContain('inline-size:640px')
    expect(html).not.toContain('{width=640}')
  })

  it('reads both together, in the shape the editor writes', () => {
    const html = render(
      '![Icon](attachment:att_x){align=center width=640}',
    ).html()
    expect(html).toContain('md__img--center')
    expect(html).toContain('inline-size:640px')
    expect(html).toContain('/api/v1/attachments/att_x')
  })

  it('ignores a block that is not attached to a picture', () => {
    const html = render('Some prose {align=center} in the middle.').html()
    expect(html).toContain('{align=center}')
  })

  it('draws nothing for an attribute it does not know', () => {
    const html = render(
      '![Icon](https://example.test/a.png){caption="a b"}',
    ).html()
    expect(html).toContain('class="md__img"')
    expect(html).not.toContain('caption')
  })
})

/**
 * Google Drive links, as pills.
 *
 * A pasted Drive URL is forty-odd characters of noise in the middle of a
 * sentence. The pill needs no Google account and no API call, because the
 * URL already says what kind of file it points at.
 */
describe('MarkdownView Drive links', () => {
  it('turns a pasted Drive URL into a pill that opens in a new tab', () => {
    const html = render(
      'Notes: https://docs.google.com/document/d/1AbC/edit',
    ).html()
    expect(html).toContain('md__drive')
    expect(html).toContain('data-drive-kind="document"')
    expect(html).toContain('data-drive-id="1AbC"')
    expect(html).toContain('Google Doc')
    // A document opened from a ticket belongs beside it, not instead of it.
    expect(html).toContain('target="_blank"')
    // Without this, the opened tab can reach back through window.opener.
    expect(html).toContain('rel="noopener noreferrer"')
  })

  it('keeps the words somebody wrote', () => {
    // "[the Q3 plan](url)" already says what the link is. Replacing that with
    // "Google Sheet" would throw away what the author told the reader.
    const html = render(
      '[the Q3 plan](https://docs.google.com/spreadsheets/d/1S/edit)',
    ).html()
    expect(html).toContain('the Q3 plan')
    expect(html).not.toContain('md__drive')
  })

  it('leaves other links as links', () => {
    const html = render('https://github.com/nubisco/acta').html()
    expect(html).not.toContain('md__drive')
    expect(html).toContain('href="https://github.com/nubisco/acta"')
  })

  it('colours a sheet differently from a doc', () => {
    // The colour is the whole reason the pill is readable at a glance: people
    // recognise a Sheet by its green before they read the word.
    const doc = render('https://docs.google.com/document/d/1A/edit').html()
    const sheet = render(
      'https://docs.google.com/spreadsheets/d/1B/edit',
    ).html()
    expect(doc).toContain('#1a73e8')
    expect(sheet).toContain('#0f9d58')
  })
})

/**
 * Tables, as the reader draws them.
 *
 * Alignment is the one piece of table formatting markdown genuinely supports,
 * and the editor now writes it. The reader has to honour it, or a column
 * somebody aligned in the editor reads as unaligned the moment they leave
 * edit mode, which looks like the setting was not saved.
 */
describe('MarkdownView tables', () => {
  it('honours every alignment marker', () => {
    const html = render(
      '| a | b | c | d |\n| :--- | :---: | ---: | --- |\n| 1 | 2 | 3 | 4 |',
    ).html()
    expect(html).toContain('text-align:left')
    expect(html).toContain('text-align:center')
    expect(html).toContain('text-align:right')
    // The fourth column asked for nothing, so it gets nothing.
    expect(html.match(/text-align/g)?.length).toBe(6)
  })

  it('reads an escaped pipe as content, not as a column break', () => {
    const html = render('| a | b |\n| --- | --- |\n| x \\| y | z |').html()
    expect(html).toContain('x | y')
    // Two columns, so two cells in the body row, not three.
    expect(html.match(/<td/g)?.length).toBe(2)
  })
})

/**
 * Maths in the reader.
 *
 * The markdown pass is synchronous and KaTeX is not, so these assert the
 * marked-up element the pass produces. What KaTeX then does with it is
 * `katex.ts`'s business and is covered where the hydration is awaited.
 */
describe('maths in the reader', () => {
  it('marks a display block and carries its source', () => {
    const html = render('$$\nE = mc^2\n$$').html()
    expect(html).toContain('data-math-block')
    expect(html).toContain('E = mc^2')
  })

  it('marks inline maths inside a sentence', () => {
    const html = render('The identity $e^{i\\pi} + 1 = 0$ is pretty.').html()
    expect(html).toContain('data-math-inline')
    expect(html).toContain('is pretty.')
  })

  it('shows the source until KaTeX arrives, rather than a gap', () => {
    // An empty element is indistinguishable from a rendering fault. The
    // formula as typed is the correct content either way.
    const view = render('$$\nE = mc^2\n$$')
    expect(view.find('[data-math-block]').text()).toBe('E = mc^2')
  })

  /*
   * The false positives, on the surface people actually read. Every one of
   * these is ordinary prose that a loose detector turns into a formula.
   */
  it('leaves prices as prose', () => {
    for (const source of [
      'It costs $5 and $10.',
      'Between $5-$10 depending on the day.',
      'They charge $100 and I charge $200.',
    ]) {
      expect(render(source).html(), source).not.toContain('data-math')
    }
  })

  it('leaves shell variables as prose', () => {
    for (const source of [
      'Add it to $PATH first.',
      'Export $PATH and $HOME before running it.',
      'Use $1 for the first argument.',
    ]) {
      expect(render(source).html(), source).not.toContain('data-math')
    }
  })

  it('leaves a dollar inside inline code alone', () => {
    const html = render('Run `echo $PATH` to check.').html()
    expect(html).not.toContain('data-math')
    expect(html).toContain('echo $PATH')
  })

  it('leaves a dollar inside a fence alone', () => {
    const html = render(
      '```sh\nexport PATH=$PATH:/usr/local/bin\necho "$5"\n```',
    ).html()
    expect(html).not.toContain('data-math')
  })

  it('leaves an unclosed block as the prose it reads as', () => {
    const html = render('$$\nE = mc^2\n\nStill writing.').html()
    expect(html).not.toContain('data-math-block')
    expect(html).toContain('Still writing.')
  })

  it('refuses an empty formula', () => {
    expect(render('A $ $ B').html()).not.toContain('data-math')
    expect(render('$$\n\n$$').html()).not.toContain('data-math')
  })
})
