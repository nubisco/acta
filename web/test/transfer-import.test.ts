/**
 * Import: markdown, folders and zips as page trees, HTML, Word, and cutting a
 * document into pages at its headings. Plus the two properties that make an
 * import trustworthy: an export imports back as the same content, and an
 * imported page is already in the form the editor saves.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { zipSync, strToU8 } from 'fflate'
import { prepareImport, readInputs } from '@/lib/transfer/sources'
import { runImport } from '@/lib/transfer/importer'
import { collectTree, exportMarkdown } from '@/lib/transfer/exporter'
import { serializeOnce } from '@/lib/transfer/normalize'
import { asFile, bytesFile, FakeActa, PNG, textFile } from './transfer-fakes'

async function importFiles(
  acta: FakeActa,
  files: File[],
  options: { parent?: string; splitLevel?: number } = {},
) {
  const prepared = await prepareImport(await readInputs(files), {
    splitLevel: options.splitLevel,
  })
  return runImport(prepared, { parent: options.parent }, acta.importApi())
}

/** Every stored body is a fixed point of the editor's parse and serialize. */
function expectStable(acta: FakeActa): void {
  for (const doc of acta.docs)
    expect(serializeOnce(doc.body), `${doc.slug} changes on save`).toBe(
      doc.body,
    )
}

/** The page tree as titles, for comparing shapes. */
function shape(acta: FakeActa, parent?: string): unknown[] {
  return acta.childrenOf(parent).map((doc) => {
    const children = shape(acta, doc.slug)
    return children.length > 0 ? { [doc.title]: children } : doc.title
  })
}

describe('markdown import', () => {
  it('imports several files at once, titled from their headings or names', async () => {
    const acta = new FakeActa()
    acta.addDoc({ slug: 'team', title: 'Team' })
    const result = await importFiles(
      acta,
      [
        textFile('notes.md', '# Meeting notes\n\nWe *agreed*.\n'),
        textFile('ideas.md', 'No heading here.\n\n- one\n- two\n'),
      ],
      { parent: 'team' },
    )
    expect(result.pages.map((p) => p.slug).sort()).toEqual([
      'team/ideas',
      'team/meeting-notes',
    ])
    expect(acta.doc('team/meeting-notes').title).toBe('Meeting notes')
    expect(acta.doc('team/meeting-notes').body).toBe('We *agreed*.')
    expect(acta.doc('team/ideas').title).toBe('ideas')
    expect(acta.doc('team/meeting-notes').parent).toBe('team')
    expectStable(acta)
  })

  it('never reuses a slug that is taken', async () => {
    const acta = new FakeActa()
    acta.addDoc({ slug: 'notes', title: 'Notes' })
    await importFiles(acta, [textFile('Notes.md', 'Again.')])
    expect(acta.doc('notes-2').body).toBe('Again.')
  })

  it('turns pictures beside the file into attachments', async () => {
    const acta = new FakeActa()
    const result = await importFiles(acta, [
      textFile(
        'guide.md',
        'Look:\n\n![A dot](images/dot%201.png){width=40}\n',
        'Guide/guide.md',
      ),
      bytesFile('dot 1.png', PNG, 'Guide/images/dot 1.png'),
    ])
    expect(result.issues).toEqual([])
    const page = acta.doc('guide')
    const [attachment] = acta.attachments
    expect(attachment.doc).toBe('guide')
    expect(attachment.bytes).toEqual(PNG)
    expect(attachment.mime).toBe('image/png')
    expect(page.body).toBe(
      `Look:\n\n![A dot](attachment:${attachment.id}){width=40}`,
    )
    // Not a remote hotlink, and not a data URI.
    expect(page.body).not.toMatch(/https?:|data:/)
    expectStable(acta)
  })

  it('turns data URIs into attachments too', async () => {
    const acta = new FakeActa()
    const uri = `data:image/png;base64,${btoa(String.fromCharCode(...PNG))}`
    await importFiles(acta, [textFile('inline.md', `![dot](${uri})`)])
    const [attachment] = acta.attachments
    expect(attachment.bytes).toEqual(PNG)
    expect(acta.doc('inline').body).toBe(`![dot](attachment:${attachment.id})`)
  })

  it('reports a picture that was not part of the import', async () => {
    const acta = new FakeActa()
    const result = await importFiles(acta, [
      textFile('lost.md', '![x](missing.png)'),
    ])
    expect(result.issues.join('\n')).toMatch(/missing\.png/)
  })

  it('links between imported pages become references', async () => {
    const acta = new FakeActa()
    await importFiles(acta, [
      textFile('a.md', '# Alpha\n\nSee [the beta page](b.md).'),
      textFile('b.md', '# Beta\n\nBack to [a](./a.md).'),
    ])
    expect(acta.doc('alpha').body).toBe('See [[doc:beta|the beta page]].')
    expect(acta.doc('beta').body).toBe('Back to [[doc:alpha]].')
    expectStable(acta)
  })
})

describe('folder and zip import', () => {
  const layout: [string, string][] = [
    ['Handbook.md', '---\ntitle: Handbook\n---\n\nThe root.'],
    ['Handbook/Onboarding.md', '# Onboarding\n\nWeek one.'],
    ['Handbook/Onboarding/Laptop.md', 'Get a laptop.'],
    ['Handbook/Policies/index.md', 'All policies.'],
    ['Handbook/Policies/Leave.md', 'Take it.'],
    ['Handbook/Empty folder/readme.txt.png', 'not a page'],
  ]

  it('builds the tree from a folder', async () => {
    const acta = new FakeActa()
    const files = layout.map(([path, text]) =>
      textFile(path.split('/').pop()!, text, `Export/${path}`),
    )
    await importFiles(acta, files)
    expect(shape(acta)).toEqual([
      {
        Export: [
          {
            Handbook: [{ Onboarding: ['Laptop'] }, { Policies: ['Leave'] }],
          },
        ],
      },
    ])
    expect(acta.doc('export/handbook/policies').body).toBe('All policies.')
    expectStable(acta)
  })

  it('builds the same tree from a zip', async () => {
    const acta = new FakeActa()
    const zip = zipSync(
      Object.fromEntries(layout.map(([path, text]) => [path, strToU8(text)])),
    )
    await importFiles(acta, [bytesFile('handbook.zip', zip)])
    expect(shape(acta)).toEqual([
      { Handbook: [{ Onboarding: ['Laptop'] }, { Policies: ['Leave'] }] },
    ])
    expect(acta.doc('handbook/onboarding/laptop').body).toBe('Get a laptop.')
  })
})

describe('HTML import', () => {
  it('maps HTML onto the dialect', async () => {
    const acta = new FakeActa()
    const html = `<!doctype html><html><head><title>Runbook</title>
      <style>p { color: red }</style><script>alert(1)</script></head><body>
      <h1>Runbook</h1>
      <p>Restart <strong>carefully</strong>, then check <a href="https://status.example.com">status</a>.</p>
      <div class="markdown-alert markdown-alert-warning"><p class="markdown-alert-title">Warning</p><p>Never on Fridays.</p></div>
      <details><summary>Rollback</summary><ol><li>Stop</li><li>Revert</li></ol></details>
      <pre><code class="language-bash">systemctl restart acta</code></pre>
      <table><tr><th>Step</th><th>Owner</th></tr><tr><td>Deploy</td><td>Ops</td></tr></table>
      <p>Energy is <span class="katex"><math><semantics><mi>E</mi><annotation encoding="application/x-tex">E=mc^2</annotation></semantics></math></span>.</p>
      <ul><li><input type="checkbox" checked> Backups verified</li><li><input type="checkbox"> Pager on</li></ul>
      <p><img src="https://example.com/nope.png" alt="remote"></p>
      </body></html>`
    const result = await importFiles(acta, [textFile('runbook.html', html)])
    const page = acta.doc('runbook')
    expect(page.title).toBe('Runbook')
    expect(page.body).toContain(
      'Restart **carefully**, then check [status](https://status.example.com).',
    )
    expect(page.body).toContain('> [!WARNING]\n> Never on Fridays.')
    expect(page.body).toContain(':::details Rollback')
    expect(page.body).toContain('1. Stop')
    expect(page.body).toContain('```bash\nsystemctl restart acta\n```')
    expect(page.body).toContain('| Step | Owner |')
    expect(page.body).toContain('$E=mc^2$')
    expect(page.body).toContain('- [x] Backups verified')
    expect(page.body).not.toContain('alert(1)')
    expect(page.body).not.toContain('color: red')
    // A remote picture the browser may not read is reported, not hidden.
    expect(result.issues.join('\n')).toMatch(/could not be copied/)
    expectStable(acta)
  })

  it('imports an HTML export back into the same dialect', async () => {
    const acta = new FakeActa()
    const html = `<main class="export"><section class="export__page"><h1 class="export__title">Page</h1>
      <div class="md-wrap"><div class="md">
      <blockquote class="md__callout md__callout--tip"><svg class="md__callout-icon"></svg><strong class="md__callout-title">Hint</strong><p>Body</p></blockquote>
      <p>See <a class="md__ref md__ref--link" data-ref-type="doc" data-ref="handbook" href="/docs/handbook">Handbook</a> and <button class="md__ref md__ref--item" data-ref-type="item" data-ref="SU-12">SU-12</button>.</p>
      <div class="md__math" data-math-block="1" data-math="a^2+b^2"><span class="katex-display">rendered</span></div>
      <div class="md__diagram-figure" data-mermaid="graph TD&#10;  A--&gt;B"><svg></svg></div>
      <p data-link-card="https://example.com/page" class="md__card-slot"><span class="md__card-hold"><a class="md__card" href="https://example.com/page">card</a></span></p>
      </div></div></section></main>`
    await importFiles(acta, [textFile('export.html', html)])
    const body = acta.doc('page').body
    expect(body).toContain('> [!TIP] Hint\n> Body')
    expect(body).toContain('[[doc:handbook|Handbook]]')
    expect(body).toContain('[[SU-12]]')
    expect(body).toContain('$$\na^2+b^2\n$$')
    expect(body).toContain('```mermaid\ngraph TD\n  A-->B\n```')
    expect(body).toContain('\n\nhttps://example.com/page')
    expectStable(acta)
  })
})

describe('HTML page splitting', () => {
  const html = `<html><head><title>Manual</title></head><body>
    <p>Read me first.</p>
    <h1>Install</h1><p>Download it.</p>
    <h2>On macOS</h2><p>Drag it.</p>
    <h3>Troubleshooting</h3><p>Reboot.</p>
    <h2>On Linux</h2><p>Use the package.</p>
    <h1>Use</h1><p>Open it.</p>
    <pre><code># not a heading</code></pre>
    </body></html>`

  it('cuts at level 1', async () => {
    const acta = new FakeActa()
    await importFiles(acta, [textFile('manual.html', html)], { splitLevel: 1 })
    expect(shape(acta)).toEqual([{ Manual: ['Install', 'Use'] }])
    expect(acta.doc('manual').body).toBe('Read me first.')
    expect(acta.doc('manual/install').body).toContain('## On macOS')
    expect(acta.doc('manual/use').body).toContain('# not a heading')
    expectStable(acta)
  })

  it('cuts at level 2 and keeps deeper headings inside', async () => {
    const acta = new FakeActa()
    await importFiles(acta, [textFile('manual.html', html)], { splitLevel: 2 })
    expect(shape(acta)).toEqual([
      { Manual: [{ Install: ['On macOS', 'On Linux'] }, 'Use'] },
    ])
    expect(acta.doc('manual/install').body).toBe('Download it.')
    expect(acta.doc('manual/install/on-macos').body).toBe(
      'Drag it.\n\n### Troubleshooting\n\nReboot.',
    )
    expectStable(acta)
  })

  it('does not wrap a document in an empty page around its own title', async () => {
    const acta = new FakeActa()
    await importFiles(
      acta,
      [
        textFile(
          'one.html',
          '<h1>Only</h1><p>Body.</p><h2>Part</h2><p>More.</p>',
        ),
      ],
      { splitLevel: 2 },
    )
    expect(shape(acta)).toEqual([{ Only: ['Part'] }])
  })
})

describe('Word import', () => {
  it('converts a .docx with its headings, lists, table and picture', async () => {
    const acta = new FakeActa()
    const bytes = new Uint8Array(
      readFileSync(resolve(__dirname, 'fixtures/import/plan.docx')),
    )
    const result = await importFiles(acta, [bytesFile('plan.docx', bytes)])
    const page = acta.doc('quarterly-plan')
    expect(page.title).toBe('Quarterly plan')
    expect(page.body).toContain('# Goals')
    expect(page.body).toContain(
      'We ship **three** things, *carefully*. See [the site](https://nubisco.io/).',
    )
    expect(page.body).toContain('- Import\n- Export')
    expect(page.body).toContain('1. First\n2. Second')
    expect(page.body).toContain('| Name | Role |')
    expect(page.body).toContain('| Ana | Owner |')
    const [picture] = acta.attachments
    expect(picture.mime).toBe('image/png')
    expect(page.body).toContain(`](attachment:${picture.id})`)
    expect(page.body).not.toContain('data:')
    expect(result.issues.join('\n')).toMatch(/header row/)
    expectStable(acta)
  })

  it('splits a .docx at its headings', async () => {
    const acta = new FakeActa()
    const bytes = new Uint8Array(
      readFileSync(resolve(__dirname, 'fixtures/import/plan.docx')),
    )
    await importFiles(acta, [bytesFile('plan.docx', bytes)], { splitLevel: 1 })
    expect(shape(acta)).toEqual([
      { plan: ['Quarterly plan', 'Goals', 'Risks'] },
    ])
    const goals = acta.docs.find((doc) => doc.title === 'Goals')!
    expect(goals.body).toContain('## Details')
    expect(goals.body).toMatch(/\]\(attachment:att_\d+\)/)
  })
})

describe('round trip', () => {
  it('exports to markdown and imports back to the same content', async () => {
    const source = new FakeActa()
    source.addDoc({
      slug: 'guide',
      title: 'Guide: the long way',
      tags: ['ops', 'docs'],
    })
    const logo = source.addAttachment('guide', 'logo.png', PNG)
    const guideBody = [
      '# Opening heading kept',
      '',
      `Intro with ![logo](attachment:${logo.id}){align=right width=64} inline.`,
      '',
      '> [!NOTE] Heads up',
      '> Callout body with **bold**.',
      '',
      ':::details More',
      'Hidden text.',
      ':::',
      '',
      'Formula $a+b$ and a price of $5.',
      '',
      '$$',
      'x^2',
      '$$',
      '',
      '| Col | Val |',
      '| --- | ---: |',
      '| a | 1 |',
      '',
      '```mermaid',
      'graph TD',
      '  A-->B',
      '```',
      '',
      '- [ ] open task',
      '- [x] done task',
      '',
      'See [[doc:other]] and [[SU-1]].',
      '',
      'https://example.com/card',
    ].join('\n')
    source.doc('guide').body = guideBody
    source.addDoc({
      slug: 'guide/child',
      title: 'Child',
      parent: 'guide',
      body: `Child body ![again](attachment:${logo.id})`,
    })
    source.addDoc({
      slug: 'guide/zeta',
      title: 'Zeta',
      parent: 'guide',
      body: 'Second child.',
    })
    source.addDoc({
      slug: 'guide/alpha',
      title: 'Alpha',
      parent: 'guide',
      body: 'Third child.',
    })
    // The seed is stored as the editor would store it, like every real page.
    for (const doc of source.docs) doc.body = serializeOnce(doc.body)

    const api = source.exportApi()
    const exported = await exportMarkdown(
      api,
      await collectTree(api, 'guide', true),
    )
    expect(exported.warnings).toEqual([])

    const target = new FakeActa()
    target.addDoc({ slug: 'restored', title: 'Restored' })
    const result = await importFiles(
      target,
      [await asFile(exported.blob, exported.filename)],
      { parent: 'restored' },
    )
    expect(result.issues).toEqual([])

    // Same tree, same order, same titles and tags.
    expect(shape(target, 'restored')).toEqual([
      { 'Guide: the long way': ['Child', 'Zeta', 'Alpha'] },
    ])
    const restored = target.docs.find(
      (doc) => doc.title === 'Guide: the long way',
    )!
    expect(restored.tags).toEqual(['ops', 'docs'])

    // Same bytes for the files, and the same text once ids are compared by
    // what they point at.
    const byId = (acta: FakeActa, body: string) =>
      body.replace(/attachment:(att_\d+)/g, (_m, id: string) => {
        const found = acta.attachments.find((a) => a.id === id)!
        return `attachment:<${found.filename}:${found.bytes.length}>`
      })
    for (const original of source.docs) {
      const copy = target.docs.find((doc) => doc.title === original.title)!
      expect(byId(target, copy.body), original.title).toBe(
        byId(source, original.body),
      )
    }
    for (const attachment of target.attachments)
      expect(attachment.bytes).toEqual(PNG)
    expectStable(target)
  })
})
