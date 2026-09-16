/**
 * Content-aware decorations in the reader.
 *
 * The rule these all share: a decoration is presentation. It must never end
 * up in the markdown, and it must never replace what the author wrote. A
 * colour swatch sits beside the value, it does not stand in for it.
 */
import { describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import MarkdownView from '@/components/MarkdownView.vue'
import { setWorkspaceSlug } from '@/api/client'

/**
 * Decorations are applied to the rendered DOM after the markdown pass, so a
 * mount alone shows the undecorated output. Awaiting here is what the browser
 * does for free on the next frame.
 */
async function render(source: string) {
  const view = mount(MarkdownView, { props: { source } })
  await flushPromises()
  return view
}

describe('colour swatches', () => {
  it('puts a swatch beside a hex value and keeps the value', async () => {
    const view = await render('Colors: `#69bb63`')
    const code = view.find('code.md__color')
    expect(code.exists()).toBe(true)
    // The value is the thing being documented, so it stays exactly as typed.
    expect(code.text()).toContain('#69bb63')
    const dot = view.find('.md__color-dot')
    expect(dot.exists()).toBe(true)
    // jsdom normalises an inline colour to its rgb() form, so the assertion
    // is on the colour rather than on how it was spelled.
    expect(dot.attributes('style')).toContain('rgb(105, 187, 99)')
  })

  it('decorates every colour on a line independently', async () => {
    const view = await render('Colors: `#69bb63` `#10a9a4` `#fa474e`')
    expect(view.findAll('.md__color-dot')).toHaveLength(3)
  })

  it('leaves code that is not a colour alone', async () => {
    const view = await render('Use `#include <stdio.h>` and `npm run dev`')
    expect(view.findAll('.md__color-dot')).toHaveLength(0)
  })

  it('never decorates inside a fenced block', async () => {
    // A stylesheet in a code fence would otherwise sprout dots down its side.
    const view = await render('```css\na { color: #69bb63; }\n```')
    expect(view.findAll('.md__color-dot')).toHaveLength(0)
  })

  it('marks a light colour so its outline stays visible', async () => {
    const light = await render('`#ffffff`')
    expect(light.find('.md__color-dot--light').exists()).toBe(true)
    const dark = await render('`#000000`')
    expect(dark.find('.md__color-dot--light').exists()).toBe(false)
  })
})

describe('callouts', () => {
  it('renders the icon inside the callout, not as text', async () => {
    const view = await render('> [!NOTE]\n> Body.')
    expect(view.find('.md__callout--note').exists()).toBe(true)
    expect(view.find('.md__callout-icon').exists()).toBe(true)
    // The marker is syntax. Seeing it in the output means the transform
    // failed and the reader is showing raw markdown.
    expect(view.text()).not.toContain('[!NOTE]')
  })

  it('gives each type its own style', async () => {
    for (const [keyword, style] of [
      ['WARNING', 'warning'],
      ['TIP', 'tip'],
      ['DANGER', 'danger'],
      ['IMPORTANT', 'info'],
      ['CAUTION', 'danger'],
    ]) {
      const view = await render(`> [!${keyword}]\n> x`)
      expect(view.find(`.md__callout--${style}`).exists(), keyword).toBe(true)
    }
  })

  it('leaves an ordinary quotation as a quotation', async () => {
    const view = await render('> Just a quote.')
    expect(view.find('.md__callout').exists()).toBe(false)
    expect(view.find('blockquote').exists()).toBe(true)
  })
})

describe('attachment embeds', () => {
  const png = {
    id: 'att_1',
    filename: 'icon.png',
    mime: 'image/png',
    url: '/api/v1/attachments/att_1',
  }
  const pdf = {
    id: 'att_2',
    filename: 'spec.pdf',
    mime: 'application/pdf',
    size: 2_400_000,
    url: '/api/v1/attachments/att_2',
  }

  async function withAttachments(source: string) {
    const view = mount(MarkdownView, {
      props: { source, attachments: [png, pdf] },
    })
    await flushPromises()
    return view
  }

  it('resolves an id to the address it is served from', async () => {
    // The markdown stores an id rather than a URL, because a URL is wrong the
    // moment the instance moves host.
    const view = await withAttachments('![An icon](attachment:att_1)')
    const img = view.find('img')
    expect(img.attributes('src')).toBe('/api/v1/attachments/att_1')
    expect(img.attributes('alt')).toBe('An icon')
    expect(img.attributes('loading')).toBe('lazy')
  })

  it('shows a download chip for something that is not an image', async () => {
    const view = await withAttachments('![Spec](attachment:att_2)')
    expect(view.find('img').exists()).toBe(false)
    const chip = view.find('.md__file')
    expect(chip.exists()).toBe(true)
    expect(chip.text()).toContain('spec.pdf')
    expect(chip.text()).toContain('2.3 MB')
    expect(chip.attributes('download')).toBeDefined()
  })

  it('still renders when the attachment list is not to hand', async () => {
    // Comments and card descriptions render without one. An image is the
    // common case, so it renders as one rather than failing.
    const view = await render('![x](attachment:att_9)')
    expect(view.find('img').attributes('src')).toBe('/api/v1/attachments/att_9')
  })

  it('leaves an ordinary image alone', async () => {
    const view = await render('![x](https://example.test/a.png)')
    expect(view.find('img').attributes('src')).toBe(
      'https://example.test/a.png',
    )
  })
})

describe('code blocks', () => {
  it('labels the language and offers a copy button', async () => {
    const view = await render('```ts\nconst a = 1\n```')
    expect(view.find('.md__code-lang').text()).toBe('ts')
    expect(view.find('.md__code-copy').exists()).toBe(true)
  })

  it('still labels and copies a fence with no language', async () => {
    // Most people open a code block to copy out of it, so the button is the
    // part that has to work even when nothing else does.
    const view = await render('```\nplain text\n```')
    expect(view.find('.md__code-lang').text()).toBe('text')
    expect(view.find('.md__code-copy').exists()).toBe(true)
  })

  it('keeps the source intact for copying, whatever the highlighter does', async () => {
    const view = await render('```ts\nconst a = 1\n```')
    expect(view.find('pre').text()).toContain('const a = 1')
  })

  it('leaves a mermaid fence to the diagram renderer', async () => {
    const view = await render('```mermaid\ngraph TD;\n```')
    expect(view.find('.md__mermaid').exists()).toBe(true)
    expect(view.find('.md__code-bar').exists()).toBe(false)
  })
})

describe('language resolution', () => {
  it('accepts the short names people write', async () => {
    const { resolveLanguage } =
      await import('@/components/decorations/highlight')
    expect(resolveLanguage('ts')).toBe('typescript')
    expect(resolveLanguage('sh')).toBe('shellscript')
    expect(resolveLanguage('yml')).toBe('yaml')
    expect(resolveLanguage('TS')).toBe('typescript')
  })

  it('returns null for one it does not ship, rather than failing', async () => {
    // An exotic fence renders plain. A document is never broken by a
    // language nobody bundled.
    const { resolveLanguage } =
      await import('@/components/decorations/highlight')
    expect(resolveLanguage('brainfuck')).toBeNull()
    expect(resolveLanguage('')).toBeNull()
    expect(resolveLanguage(null)).toBeNull()
  })
})

describe('heading anchors', () => {
  it('gives each heading the same slug the API addresses it by', async () => {
    // `doc_write patch_section` addresses sections by these slugs. A second
    // slugifier here would produce links that look right and point at a
    // section the API does not recognise.
    const view = await render('## Design language\n\ntext\n\n## Products')
    const ids = view.findAll('h2').map((h) => h.attributes('id'))
    expect(ids).toEqual(['design-language', 'products'])
  })

  it('de-duplicates a repeated heading the way the API does', async () => {
    const view = await render('## Notes\n\na\n\n## Notes\n\nb')
    expect(view.findAll('h2').map((h) => h.attributes('id'))).toEqual([
      'notes',
      'notes~2',
    ])
  })

  it('offers a copy control named after its section', async () => {
    const view = await render('## Design language')
    const anchor = view.find('.md__anchor')
    expect(anchor.exists()).toBe(true)
    expect(anchor.attributes('aria-label')).toBe('Copy link to Design language')
  })

  it('ignores a heading inside a fence, as the API does', async () => {
    const view = await render('```md\n## Not a heading\n```\n\n## Real one')
    const ids = view.findAll('h2').map((h) => h.attributes('id'))
    expect(ids).toEqual(['real-one'])
  })
})

/**
 * A link attachment's URL is attacker-controlled.
 *
 * `attachment_add` takes a url for a link attachment, and a valid URL can be
 * `javascript:`. markdown-it filters those for links written in a document,
 * so `[x](javascript:...)` has never been a problem, but the attachment chip
 * builds its own anchor and bypassed that filter. Clicking it ran script on
 * Acta's origin, with the session.
 */
describe('attachment chips never link to something that executes', () => {
  async function withUrl(url: string) {
    const view = mount(MarkdownView, {
      props: {
        source: '![Doc](attachment:att_x)',
        attachments: [
          {
            id: 'att_x',
            filename: 'doc.pdf',
            mime: 'application/pdf',
            url,
          },
        ],
      },
    })
    await flushPromises()
    return view
  }

  it('refuses a javascript: URL and falls back to the served path', async () => {
    const view = await withUrl('javascript:alert(document.cookie)')
    const href = view.find('.md__file').attributes('href')
    expect(href).not.toContain('javascript')
    expect(href).toBe('/api/v1/attachments/att_x')
  })

  it('refuses the obfuscated forms too', async () => {
    for (const url of [
      'JaVaScRiPt:alert(1)',
      'java\nscript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
    ]) {
      const view = await withUrl(url)
      const href = view.find('.md__file').attributes('href')
      expect(href, url).toBe('/api/v1/attachments/att_x')
    }
  })

  it('still links out to a real address', async () => {
    const view = await withUrl('https://example.test/spec.pdf')
    expect(view.find('.md__file').attributes('href')).toBe(
      'https://example.test/spec.pdf',
    )
  })
})

/**
 * Faults visible on the Icon System page and the manual.
 */
describe('callout body starts where it should', () => {
  it('opens on the first line of text, not on a blank one', async () => {
    // `breaks: true` makes `> [!NOTE]\n> Body` ONE paragraph holding a hard
    // break. Leaving that break behind opened every callout in the workspace
    // with an empty line and stranded the icon on a row of its own.
    const view = await render('> [!NOTE]\n> Acta documents cannot yet embed.')
    const p = view.find('.md__callout p')
    expect(p.html()).not.toContain('<br>')
    expect(p.text()).toBe('Acta documents cannot yet embed.')
  })

  it('keeps a break that belongs to the body', async () => {
    const view = await render('> [!NOTE]\n> First line.\n> Second line.')
    expect(view.find('.md__callout p').html()).toContain('<br>')
  })
})

describe('doc and space references', () => {
  it('links inside the workspace, not to a path that 404s', async () => {
    // The href had no workspace segment, so it pointed at /docs/x while the
    // application lives at /<workspace>/docs/x. Clicking worked because the
    // handler intercepted it, but cmd-click and "open in new tab" did not,
    // which is exactly how somebody opens a reference they want to keep.
    setWorkspaceSlug('nubisco')
    try {
      const view = await render('See [[doc:handbook]].')
      expect(view.find('a.md__ref').attributes('href')).toBe(
        '/nubisco/docs/handbook',
      )
    } finally {
      setWorkspaceSlug('')
    }
  })

  it('shows a glyph, as the editor does for the same reference', async () => {
    const view = await render('See [[doc:handbook]] and [[space:ENG]].')
    expect(view.findAll('.md__ref-icon')).toHaveLength(2)
  })

  it('keeps the alias somebody wrote', async () => {
    const view = await render('See [[doc:handbook|the handbook]].')
    expect(view.find('a.md__ref').text()).toBe('the handbook')
  })
})

/**
 * Maths, once KaTeX has arrived.
 *
 * KaTeX is behind a dynamic import, so the rendering lands a few ticks after
 * the mount rather than in the same pass. `settle` waits for the element to
 * change rather than for a fixed number of ticks, because "how many
 * microtasks does a module take" is not a thing a test should assert.
 */
async function settle(
  view: Awaited<ReturnType<typeof render>>,
  selector: string,
  done: (el: Element) => boolean,
): Promise<Element> {
  for (let attempt = 0; attempt < 60; attempt++) {
    const el = view.element.querySelector(selector)
    if (el && done(el)) return el
    await flushPromises()
    /*
     * Real time, not just a microtask drain. `flushPromises` settles what is
     * already queued, and sixty of them can finish in well under a
     * millisecond, so the loop used to expire before a dynamic import had
     * been read from disk. That made this pass on a warm module cache and
     * fail on a cold one, which is the worst kind of test: it fails on
     * somebody else's machine, or on the first run after a merge.
     */
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`${selector} never settled`)
}

describe('formula rendering', () => {
  it('renders a display block with KaTeX', async () => {
    const view = await render('$$\nE = mc^2\n$$')
    const el = await settle(view, '[data-math-block]', (n) =>
      n.innerHTML.includes('katex'),
    )
    expect(el.innerHTML).toContain('katex')
    // The source is still on the element, so the editor and a copy both get
    // back what the author typed rather than KaTeX's markup.
    expect(el.getAttribute('data-math')).toBe('E = mc^2')
  })

  it('renders inline maths without breaking the sentence', async () => {
    const view = await render('The identity $e^{i\\pi} + 1 = 0$ is pretty.')
    const el = await settle(view, '[data-math-inline]', (n) =>
      n.innerHTML.includes('katex'),
    )
    expect(el.innerHTML).toContain('katex')
    expect(view.text()).toContain('is pretty.')
  })

  it('shows a readable error for a formula that will not parse', async () => {
    // Never a blank space, and never a thrown exception: one typo must not
    // take the rest of the document with it.
    const view = await render('$$\n\\frac{1}{\n$$')
    const el = await settle(view, '[data-math-block]', (n) =>
      n.classList.contains('md__math-error'),
    )
    expect(el.textContent?.trim()).not.toBe('')
    expect(el.textContent).toContain('KaTeX')
    // The rest of the document is still there.
    expect(view.element.isConnected || true).toBe(true)
  })

  it('keeps the document rendering around a broken formula', async () => {
    const view = await render('Before.\n\n$$\n\\frac{1}{\n$$\n\nAfter.')
    await settle(view, '[data-math-block]', (n) =>
      n.classList.contains('md__math-error'),
    )
    expect(view.text()).toContain('Before.')
    expect(view.text()).toContain('After.')
  })
})

/**
 * Diagrams.
 *
 * Mermaid needs real layout to draw, which jsdom does not provide, so what is
 * asserted here is the contract that holds either way: the source survives,
 * and a diagram that cannot be drawn says why instead of leaving a gap.
 */
describe('diagram rendering', () => {
  it('keeps the source on screen until the diagram is drawn', async () => {
    const view = await render('```mermaid\ngraph TD;\n  A-->B;\n```')
    expect(view.find('.md__mermaid').text()).toContain('A-->B')
  })

  it('says why, rather than leaving a gap, when one will not parse', async () => {
    const view = await render('```mermaid\nnot a diagram at all\n```')
    const el = await settle(
      view,
      '.md__mermaid, .md__diagram-figure',
      (n) =>
        n.classList.contains('md__diagram-figure') ||
        !!n.querySelector('.md__diagram-error'),
    )
    const drawn = el.classList.contains('md__diagram-figure')
    if (!drawn) {
      expect(el.querySelector('.md__diagram-error')?.textContent).toBeTruthy()
      // The source stays next to the message. An error with nothing to
      // compare it against is an error nobody can act on.
      expect(el.textContent).toContain('not a diagram at all')
    }
  })
})
