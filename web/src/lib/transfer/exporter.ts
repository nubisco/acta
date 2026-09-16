/**
 * A page, or a page and everything under it, out of Acta as files.
 *
 * Markdown is the stored text with its attachments carried alongside: a
 * single `.md` when nothing is embedded, otherwise a `.zip` holding the pages
 * and an `attachments/` folder they point into. HTML is one self-contained
 * file rendered by the reader. Print uses that same file.
 */
import { zipSync, strToU8 } from 'fflate'
import {
  attachmentRefs,
  planMarkdownExport,
  titleToFilename,
  type IExportPage,
  type TResolvedAttachment,
} from '@nubisco/acta-importers/files'
import type { ILinkPreview } from '@/components/decorations/linkCards'
import {
  buildHtmlDocument,
  collectCss,
  finishMarkup,
  readerMarkup,
  type IRenderAttachment,
} from './renderHtml'

export interface IExportDoc {
  slug: string
  title: string
  tags: string[]
  body: string
  attachments?: IRenderAttachment[]
}

/** The calls an export makes, injectable so the whole run is testable. */
export interface IExportApi {
  docTree: () => Promise<{ docs: { slug: string; depth: number }[] }>
  docGet: (slug: string) => Promise<IExportDoc>
  /** An attachment's bytes, or its address when it is a link. */
  attachment: (
    id: string,
  ) => Promise<
    | { kind: 'file'; bytes: Uint8Array; mime: string; filename?: string }
    | { kind: 'url'; url: string }
    | null
  >
  linkPreviews?: (urls: string[]) => Promise<ILinkPreview[]>
}

export interface IExportTree extends IExportPage {
  doc: IExportDoc
  children: IExportTree[]
}

export interface IExportFileResult {
  filename: string
  blob: Blob
  /** Things the person should know about the file they are getting. */
  warnings: string[]
}

/** The page at `slug`, with its descendants when asked, fetched in tree order. */
export async function collectTree(
  api: IExportApi,
  slug: string,
  withChildren: boolean,
): Promise<IExportTree> {
  const toTree = (doc: IExportDoc): IExportTree => ({
    slug: doc.slug,
    title: doc.title,
    tags: doc.tags,
    body: doc.body,
    doc,
    children: [],
  })
  const root = toTree(await api.docGet(slug))
  if (!withChildren) return root

  const { docs } = await api.docTree()
  const at = docs.findIndex((doc) => doc.slug === slug)
  if (at === -1) return root
  const rootDepth = docs[at].depth
  // The tree is flat and depth-ordered: a page's descendants are the rows
  // after it until the depth comes back to its own.
  const stack: { node: IExportTree; depth: number }[] = [
    { node: root, depth: rootDepth },
  ]
  for (const row of docs.slice(at + 1)) {
    if (row.depth <= rootDepth) break
    while (stack.length > 1 && stack[stack.length - 1].depth >= row.depth)
      stack.pop()
    const node = toTree(await api.docGet(row.slug))
    stack[stack.length - 1].node.children.push(node)
    stack.push({ node, depth: row.depth })
  }
  return root
}

function walk(tree: IExportTree, visit: (node: IExportTree) => void): void {
  visit(tree)
  for (const child of tree.children) walk(child, visit)
}

/** The markdown export: one `.md`, or a `.zip` when files travel with it. */
export async function exportMarkdown(
  api: IExportApi,
  tree: IExportTree,
): Promise<IExportFileResult> {
  const ids = new Set<string>()
  walk(tree, (node) => attachmentRefs(node.body).forEach((id) => ids.add(id)))

  const resolved = new Map<string, TResolvedAttachment>()
  const bytes = new Map<string, Uint8Array>()
  for (const id of ids) {
    const listed = findListed(tree, id)
    try {
      const got = await api.attachment(id)
      if (!got) continue
      if (got.kind === 'url') {
        resolved.set(id, { kind: 'url', url: got.url })
        continue
      }
      resolved.set(id, {
        kind: 'file',
        filename: listed?.filename ?? got.filename ?? id,
      })
      bytes.set(id, got.bytes)
    } catch {
      // Reported below as unresolved.
    }
  }

  const plan = planMarkdownExport([tree], (id) => resolved.get(id) ?? null)
  const warnings: string[] = []
  if (plan.unresolved.length > 0)
    warnings.push(
      `${plan.unresolved.length} embedded ${plan.unresolved.length === 1 ? 'file' : 'files'} could not be found and ${plan.unresolved.length === 1 ? 'was' : 'were'} left as a reference to this instance.`,
    )

  const base = titleToFilename(tree.title)
  const pages = plan.files.filter((file) => 'text' in file.content)
  if (pages.length === 1 && plan.assetCount === 0) {
    const text = (pages[0].content as { text: string }).text
    return {
      filename: `${base}.md`,
      blob: new Blob([text], { type: 'text/markdown;charset=utf-8' }),
      warnings,
    }
  }

  const entries: Record<string, Uint8Array> = {}
  for (const file of plan.files) {
    if ('text' in file.content) entries[file.path] = strToU8(file.content.text)
    else {
      const data = bytes.get(file.content.attachment)
      if (data) entries[file.path] = data
    }
  }
  const zipped = zipSync(entries, { level: 6 })
  return {
    filename: `${base}.zip`,
    blob: new Blob([zipped as BlobPart], { type: 'application/zip' }),
    warnings,
  }
}

function findListed(
  tree: IExportTree,
  id: string,
): IRenderAttachment | undefined {
  let found: IRenderAttachment | undefined
  walk(tree, (node) => {
    found ??= node.doc.attachments?.find((a) => a.id === id)
  })
  return found
}

/** The HTML document for a tree, every page in order. */
export async function exportHtmlDocument(
  api: IExportApi,
  tree: IExportTree,
): Promise<string> {
  const pages: { title: string; markup: string }[] = []
  const nodes: IExportTree[] = []
  walk(tree, (node) => nodes.push(node))
  const cache = new Map<
    string,
    Promise<{ bytes: Uint8Array; mime: string } | null>
  >()
  const attachmentData = (id: string) => {
    if (!cache.has(id))
      cache.set(
        id,
        api
          .attachment(id)
          .then((got) =>
            got && got.kind === 'file'
              ? { bytes: got.bytes, mime: got.mime }
              : null,
          ),
      )
    return cache.get(id)!
  }
  for (const node of nodes) {
    const markup = await finishMarkup(
      readerMarkup(node.body, node.doc.attachments ?? []),
      { attachmentData, linkPreviews: api.linkPreviews },
    )
    pages.push({ title: node.title, markup })
  }
  const css = await collectCss(pages.map((page) => page.markup).join('\n'))
  return buildHtmlDocument(tree.title, pages, css)
}

export async function exportHtml(
  api: IExportApi,
  tree: IExportTree,
): Promise<IExportFileResult> {
  const html = await exportHtmlDocument(api, tree)
  return {
    filename: `${titleToFilename(tree.title)}.html`,
    blob: new Blob([html], { type: 'text/html;charset=utf-8' }),
    warnings: [],
  }
}

/** Hands a file to the browser's downloads. */
export function download(result: { filename: string; blob: Blob }): void {
  const url = URL.createObjectURL(result.blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = result.filename
  anchor.rel = 'noopener'
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

/**
 * Prints the HTML export through the browser's own dialog, from a frame the
 * person never sees, so what reaches the printer is the page and nothing of
 * the app around it. "Save as PDF" in that dialog is the PDF export.
 */
export function printHtml(html: string): Promise<void> {
  return new Promise((resolve) => {
    const frame = document.createElement('iframe')
    frame.setAttribute('aria-hidden', 'true')
    frame.tabIndex = -1
    frame.style.cssText =
      'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden'
    const cleanup = () => {
      setTimeout(() => frame.remove(), 1000)
      resolve()
    }
    frame.onload = () => {
      const win = frame.contentWindow
      if (!win) return cleanup()
      win.document
        .querySelectorAll('details')
        .forEach((details) => ((details as HTMLDetailsElement).open = true))
      win.addEventListener('afterprint', cleanup, { once: true })
      win.focus()
      win.print()
      // Some browsers never fire afterprint for a frame.
      setTimeout(cleanup, 60_000)
    }
    frame.srcdoc = html
    document.body.append(frame)
  })
}

/** The API calls, bound to the app's client. */
export async function browserExportApi(): Promise<IExportApi> {
  const { api, attachmentHref } = await import('@/api/client')
  return {
    docTree: () => api.docTree(),
    docGet: async (slug) => {
      const doc = await api.docGet(slug)
      return {
        slug: doc.slug,
        title: doc.title,
        tags: doc.tags ?? [],
        body: doc.body,
        attachments: doc.attachments ?? [],
      }
    },
    attachment: async (id) => {
      const res = await fetch(attachmentHref(id), { credentials: 'include' })
      if (!res.ok) return null
      const type = res.headers.get('content-type') ?? ''
      const bytes = new Uint8Array(await res.arrayBuffer())
      const disposition = res.headers.get('content-disposition') ?? ''
      // A link attachment answers with JSON naming its address, and an
      // uploaded file is served with a disposition. A JSON file somebody
      // uploaded has both, so the disposition decides.
      if (type.startsWith('application/json') && !disposition) {
        try {
          const body = JSON.parse(new TextDecoder().decode(bytes)) as {
            kind?: string
            url?: string
          }
          if (body.kind === 'url' && body.url)
            return { kind: 'url', url: body.url }
        } catch {
          return null
        }
        return null
      }
      const filename = /filename="([^"]*)"/.exec(disposition)?.[1]
      return {
        kind: 'file',
        bytes,
        mime: type.split(';')[0] || 'application/octet-stream',
        filename,
      }
    },
    linkPreviews: async (urls) => (await api.linkPreviews(urls)).previews,
  }
}
