/**
 * Pure Confluence-pages → doc-write plan converter (mvp F12). Builds the doc
 * tree with parents before children, slugs from the slugified title path, and
 * converts every storage body to enhanced Markdown. Original author/date and
 * version counts land in imported_meta on each page (create + set_meta, so
 * pages from the earlier lossy import get enriched too) and in the report.
 */

import { DOC_SLUG_RE, slugify } from '@nubisco/acta-shared'
import type { TDocOp, TImportedMeta } from '@nubisco/acta-shared'
import type { ISkipEntry } from '../lib/report'
import type { IConfluencePage } from './model'
import { storageToMarkdown, type IConversionIssues } from './storage'

/** The three Trello board links known from the Confluence product pages. */
export const DEFAULT_TRELLO_BOARD_MAP: Record<string, string> = {
  PZWcHkir: 'SW',
  qLPEwtZB: 'VERBA',
  '9G21FmnG': 'DOOD',
}

export interface IConfluencePlanOptions {
  /** Slug (path) the imported tree lands under, e.g. `archive/analytics`. */
  root?: string
  trelloBoards?: Record<string, string>
  /** Doc slugs already on the server (stubs are skipped, pages reported). */
  existingSlugs?: Set<string>
  /** Personal spaces (key starting with ~) are skipped unless set. */
  includePersonal?: boolean
  /** Confluence base (e.g. https://x.atlassian.net/wiki) for source urls. */
  sourceBase?: string
}

export interface IConfluencePagePlan {
  pageId: string
  title: string
  slug: string
  parentSlug?: string
  depth: number
  spaceKey: string | null
  op: TDocOp
  /** set_meta with the same provenance; enriches pre-existing pages. */
  metaOp: TDocOp
  commentOps: TDocOp[]
  issues: IConversionIssues
  authorName: string | null
  createdAt: string | null
  updatedAt: string | null
  versionCount: number | null
}

export interface IConfluencePlan {
  /** Stub docs for --root path segments that do not exist yet. */
  stubOps: TDocOp[]
  pages: IConfluencePagePlan[]
  skips: ISkipEntry[]
  notes: string[]
}

function titleCase(segment: string): string {
  return segment
    .split('-')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ')
}

export function planConfluenceImport(
  allPages: IConfluencePage[],
  opts: IConfluencePlanOptions = {},
): IConfluencePlan {
  const skips: ISkipEntry[] = []
  const notes: string[] = []
  const root = opts.root ?? ''
  if (root && !DOC_SLUG_RE.test(root))
    throw new Error(`--root ${root} is not a valid doc slug`)

  const pages = allPages.filter((page) => {
    if (!opts.includePersonal && page.spaceKey?.startsWith('~')) {
      skips.push({
        kind: 'pages',
        id: page.id,
        reason: `personal space ${page.spaceKey} skipped by default`,
      })
      return false
    }
    return true
  })

  const byId = new Map(pages.map((p) => [p.id, p]))
  const childrenOf = new Map<string | null, IConfluencePage[]>()
  for (const page of pages) {
    const parent =
      page.parentId !== null && byId.has(page.parentId) ? page.parentId : null
    const bucket = childrenOf.get(parent) ?? []
    bucket.push(page)
    childrenOf.set(parent, bucket)
  }
  const roots = childrenOf.get(null) ?? []

  // Root handling: with --root and a single source root page, that page IS
  // the root slug; otherwise --root is a prefix (stub docs created for its
  // segments) and source roots nest under it.
  const singleRootCollapse = root !== '' && roots.length === 1
  const stubPaths: string[] = []
  if (root) {
    const segments = root.split('/')
    const upto = singleRootCollapse ? segments.length - 1 : segments.length
    for (let i = 0; i < upto; i++) {
      stubPaths.push(segments.slice(0, i + 1).join('/'))
    }
  }
  const stubOps: TDocOp[] = stubPaths
    .filter((path) => !opts.existingSlugs?.has(path))
    .map((path) => ({
      op: 'create',
      op_id: `confluence:stub:${path}`,
      slug: path,
      title: titleCase(path.split('/').pop() ?? path),
      parent: path.includes('/')
        ? path.slice(0, path.lastIndexOf('/'))
        : undefined,
      body: '',
      layout: 'default',
      tags: [],
    }))

  // Assign slugs, parents before children, deduping sibling slugs.
  const slugById = new Map<string, string>()
  const parentSlugById = new Map<string, string | undefined>()
  const depthById = new Map<string, number>()
  const ordered: IConfluencePage[] = []
  // Sibling dedupe considers only this import's slugs (plus stub paths). A
  // slug already on the server is either the idempotent re-run case (same
  // op_id returns the original result) or a real conflict reported as
  // skipped; it is never silently renamed.
  const usedSlugs = new Set<string>(stubPaths)

  const assign = (
    page: IConfluencePage,
    parentSlug: string | undefined,
    depth: number,
  ): void => {
    let base = slugify(page.title) || `page-${page.id}`
    base = parentSlug ? `${parentSlug}/${base}` : base
    if (singleRootCollapse && depth === 0) base = root
    let slug = base
    let n = 2
    while (usedSlugs.has(slug)) {
      slug = `${base}-${n}`
      n += 1
    }
    if (slug !== base)
      notes.push(`duplicate slug ${base} for page ${page.id}; using ${slug}`)
    usedSlugs.add(slug)
    slugById.set(page.id, slug)
    parentSlugById.set(page.id, parentSlug)
    depthById.set(page.id, depth)
    ordered.push(page)
    for (const child of childrenOf.get(page.id) ?? []) {
      assign(child, slug, depth + 1)
    }
  }
  const topParent = singleRootCollapse
    ? root.includes('/')
      ? root.slice(0, root.lastIndexOf('/'))
      : undefined
    : root || undefined
  for (const page of roots) assign(page, topParent, 0)
  if (singleRootCollapse) {
    // The collapsed root's own parent is the stub above it (if any).
    parentSlugById.set(roots[0].id, topParent)
  }

  // Title → slug map for [[doc:...]] resolution (built over the whole set so
  // link targets resolve regardless of tree order).
  const slugByTitle = new Map<string, string>()
  for (const page of ordered) {
    const key = page.title.toLowerCase()
    if (!slugByTitle.has(key)) slugByTitle.set(key, slugById.get(page.id)!)
    else
      notes.push(
        `duplicate page title "${page.title}"; links resolve to the first`,
      )
  }

  const convertOpts = {
    resolvePage: (title: string) => slugByTitle.get(title.toLowerCase()) ?? null,
    trelloBoards: opts.trelloBoards ?? DEFAULT_TRELLO_BOARD_MAP,
  }

  const planned: IConfluencePagePlan[] = ordered.map((page) => {
    const slug = slugById.get(page.id)!
    const { markdown, issues } = storageToMarkdown(page.storage, convertOpts)
    const meta: TImportedMeta = {
      source: 'confluence',
      author: page.authorName ?? undefined,
      created_at: page.createdAt ?? undefined,
      updated_at: page.updatedAt ?? undefined,
      versions: page.versionCount ?? undefined,
      url: opts.sourceBase
        ? `${opts.sourceBase}/pages/viewpage.action?pageId=${page.id}`
        : undefined,
    }
    const commentOps: TDocOp[] = []
    for (const comment of page.comments) {
      // Comment conversion issues land in the page's issue lists.
      const converted = storageToMarkdown(comment.body, convertOpts)
      issues.unknownMacros.push(...converted.issues.unknownMacros)
      issues.unresolvedLinks.push(...converted.issues.unresolvedLinks)
      issues.skippedAttachments.push(...converted.issues.skippedAttachments)
      const quoted = comment.inlineContext
        ? comment.inlineContext
            .split('\n')
            .map((line) => `> ${line}`)
            .join('\n')
        : ''
      const body = quoted
        ? `${quoted}\n\n${converted.markdown}`
        : converted.markdown
      if (body.trim().length === 0) {
        skips.push({
          kind: 'comments',
          id: comment.id,
          reason: `comment on page ${page.id} empty after conversion`,
        })
        continue
      }
      commentOps.push({
        op: 'comment',
        op_id: `confluence:comment:${comment.id}`,
        ref: slug,
        body,
        imported_meta: {
          source: 'confluence',
          author: comment.author ?? undefined,
          created_at: comment.createdAt ?? undefined,
        },
      })
    }
    return {
      pageId: page.id,
      title: page.title,
      slug,
      parentSlug: parentSlugById.get(page.id),
      depth: depthById.get(page.id) ?? 0,
      spaceKey: page.spaceKey,
      op: {
        op: 'create',
        op_id: `confluence:${page.id}`,
        slug,
        title: page.title.slice(0, 300),
        parent: parentSlugById.get(page.id),
        body: markdown,
        layout: page.wide ? 'wide' : 'default',
        tags: [],
        imported_meta: meta,
      },
      metaOp: {
        op: 'set_meta',
        op_id: `confluence:meta:${page.id}`,
        ref: slug,
        imported_meta: meta,
      },
      commentOps,
      issues,
      authorName: page.authorName,
      createdAt: page.createdAt,
      updatedAt: page.updatedAt,
      versionCount: page.versionCount,
    }
  })

  return { stubOps, pages: planned, skips, notes }
}
