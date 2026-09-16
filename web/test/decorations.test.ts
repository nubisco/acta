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
