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
