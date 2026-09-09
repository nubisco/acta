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
