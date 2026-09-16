/**
 * Export: markdown with its files, HTML rendered by the reader, and paper.
 */
import { describe, expect, it } from 'vitest'
import { unzipSync, strFromU8 } from 'fflate'
import { findLinks } from '@nubisco/acta-importers/files'
import {
  collectTree,
  exportHtmlDocument,
  exportMarkdown,
} from '@/lib/transfer/exporter'
import { collectCss } from '@/lib/transfer/renderHtml'
import { installPrintStyles, PRINT_CSS as printCss } from '@/lib/transfer/print'
import { FakeActa, PNG } from './transfer-fakes'

async function unzip(blob: Blob): Promise<Record<string, Uint8Array>> {
  return unzipSync(new Uint8Array(await blob.arrayBuffer()))
}

function seeded(): FakeActa {
  const acta = new FakeActa()
  acta.addDoc({ slug: 'handbook', title: 'Handbook', tags: ['team'] })
  const logo = acta.addAttachment('handbook', 'Logo (final).png', PNG)
  acta.doc('handbook').body = [
    'Welcome.',
    '',
    `![The logo](attachment:${logo.id}){align=center width=120}`,
    '',
    '> [!NOTE]',
    '> Read this first.',
  ].join('\n')
  acta.addDoc({
    slug: 'handbook/onboarding',
    title: 'Onboarding / First week',
    parent: 'handbook',
    body: `Day one.\n\n![Logo again](attachment:${logo.id})`,
  })
  return acta
}

describe('markdown export', () => {
  it('is a single file when nothing is embedded', async () => {
    const acta = new FakeActa()
    acta.addDoc({ slug: 'plain', title: 'Plain', body: 'Just *text*.' })
    const api = acta.exportApi()
    const result = await exportMarkdown(
      api,
      await collectTree(api, 'plain', false),
    )
    expect(result.filename).toBe('Plain.md')
    const text = await result.blob.text()
    expect(text).toContain('title: Plain')
    expect(text).toContain('Just *text*.')
    expect(result.warnings).toEqual([])
  })

  it('carries attachments in the zip and leaves no broken reference', async () => {
    const acta = seeded()
    const api = acta.exportApi()
    const result = await exportMarkdown(
      api,
      await collectTree(api, 'handbook', true),
    )
    expect(result.filename).toBe('Handbook.zip')
    expect(result.warnings).toEqual([])

    const files = await unzip(result.blob)
    const paths = Object.keys(files).sort()
    expect(paths).toEqual([
      'Handbook.md',
      'Handbook/Onboarding - First week.md',
      'attachments/Logo-final.png',
    ])
    expect(files['attachments/Logo-final.png']).toEqual(PNG)

    // Every image target in every page resolves to a file in the zip, and no
    // instance-only reference survives.
    for (const path of paths.filter((p) => p.endsWith('.md'))) {
      const text = strFromU8(files[path])
      expect(text).not.toContain('attachment:')
      const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
      for (const link of findLinks(text).filter((l) => l.image)) {
        const resolved = new URL(
          link.target,
          `https://x/${dir ? `${dir}/` : ''}`,
        ).pathname.slice(1)
        expect(paths, `${path} -> ${link.target}`).toContain(
          decodeURIComponent(resolved),
        )
      }
    }
    const child = strFromU8(files['Handbook/Onboarding - First week.md'])
    expect(child).toContain('title: Onboarding / First week')
    expect(child).toContain('](../attachments/Logo-final.png)')
    // The image attribute block stays with its image.
    expect(strFromU8(files['Handbook.md'])).toContain(
      '![The logo](attachments/Logo-final.png){align=center width=120}',
    )
  })

  it('says so when an embedded file cannot be found', async () => {
    const acta = new FakeActa()
    acta.addDoc({
      slug: 'gone',
      title: 'Gone',
      body: '![x](attachment:att_missing)',
    })
    const api = acta.exportApi()
    const result = await exportMarkdown(
      api,
      await collectTree(api, 'gone', false),
    )
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toMatch(/could not be found/)
  })

  it('writes a link attachment as the address it links to', async () => {
    const acta = new FakeActa()
    acta.addDoc({ slug: 'linked', title: 'Linked' })
    const link = acta.addAttachment('linked', 'remote.png', new Uint8Array())
    link.kind = 'url'
    link.url = 'https://example.com/remote.png'
    acta.doc('linked').body = `![r](attachment:${link.id})`
    const api = acta.exportApi()
    const result = await exportMarkdown(
      api,
      await collectTree(api, 'linked', false),
    )
    expect(await result.blob.text()).toContain(
      '![r](https://example.com/remote.png)',
    )
  })
})

describe('HTML export', () => {
  it('renders callouts, toggles and maths with the reader', async () => {
    const acta = new FakeActa()
    acta.addDoc({
      slug: 'rich',
      title: 'Rich page',
      body: [
        '> [!WARNING] Mind the gap',
        '> Stand clear.',
        '',
        ':::details How it works',
        'Hidden detail.',
        ':::',
        '',
        'Inline $x^2$ maths.',
        '',
        '$$',
        '\\int_0^1 x\\,dx',
        '$$',
        '',
        '| A | B |',
        '| --- | --- |',
        '| 1 | 2 |',
      ].join('\n'),
    })
    const logo = acta.addAttachment('rich', 'logo.png', PNG)
    acta.doc('rich').body += `\n\n![logo](attachment:${logo.id})`
    const api = acta.exportApi()
    const html = await exportHtmlDocument(
      api,
      await collectTree(api, 'rich', false),
    )

    expect(html).toMatch(/^<!doctype html>/)
    expect(html).toContain('<title>Rich page</title>')
    expect(html).toContain('md__callout md__callout--warning')
    expect(html).toContain('Mind the gap')
    expect(html).toContain('<details class="md__details">')
    expect(html).toContain(
      '<summary class="md__details-summary">How it works</summary>',
    )
    // KaTeX output, not the TeX source.
    expect(html).toContain('class="katex"')
    expect(html).toContain('katex-display')
    expect(html).toContain('<table>')
    // Self-contained: the picture is inside the file, not on this instance.
    expect(html).toContain('src="data:image/png;base64,')
    expect(html).not.toContain('/api/v1/attachments/')
    // The print rules travel with it.
    expect(html).toContain('@media print')
  })

  it('keeps the stylesheet rules the page uses and drops the rest', async () => {
    const style = document.createElement('style')
    style.textContent = [
      ':root { --nb-c-text: #111; overflow: hidden; }',
      '.md__callout { border-left: 3px solid red; }',
      '.unrelated-widget { color: blue; }',
      '.dark .md__callout { border-color: black; }',
      '@media (prefers-color-scheme: dark) { .md__callout { color: white; } }',
    ].join('\n')
    document.head.append(style)
    try {
      const css = await collectCss(
        '<blockquote class="md__callout">x</blockquote>',
      )
      expect(css).toContain('--nb-c-text')
      expect(css).not.toContain('overflow')
      expect(css).toContain('.md__callout')
      expect(css).not.toContain('unrelated-widget')
      expect(css).not.toContain('.dark')
      expect(css).not.toContain('prefers-color-scheme')
    } finally {
      style.remove()
    }
  })
})

describe('print stylesheet', () => {
  it('exists and is print-only', () => {
    // One media block and nothing outside it, so the screen is never touched.
    expect(printCss.trim().startsWith('@media print {')).toBe(true)
    expect(printCss.match(/@media/g)).toHaveLength(1)
  })

  it('is added to the app once, for the browser print command', () => {
    installPrintStyles()
    installPrintStyles()
    const installed = document.head.querySelectorAll('style[data-acta-print]')
    expect(installed).toHaveLength(1)
    expect(installed[0].textContent).toBe(printCss)
  })

  it('hides the app chrome', () => {
    const block = printCss.slice(printCss.indexOf('@media print'))
    for (const chrome of [
      '.nb-shell__sidebar',
      '.nb-shell__topbar',
      '.nb-shell__contextbar',
      '.nb-shell__inspector',
      '.md__code-copy',
      '.md__anchor',
    ])
      expect(block, chrome).toContain(chrome)
    expect(block).toMatch(/display:\s*none\s*!important/)
  })

  it('keeps code blocks, callouts and table rows whole', () => {
    expect(printCss).toMatch(
      /\.md pre,[\s\S]*?\.md__callout,[\s\S]*?\.md tr,[\s\S]*?break-inside:\s*avoid/,
    )
  })

  it('shows where link cards go on paper', () => {
    expect(printCss).toMatch(/\.md__card::after\s*\{[^}]*attr\(href\)/)
    expect(printCss).toMatch(/\.md__embed\s*\{/)
  })
})
