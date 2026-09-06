/**
 * Applies a Confluence plan against a running Acta server: stub docs first,
 * then pages in parents-before-children order, then provenance set_meta ops
 * and page comments, then a tree-fidelity check (every imported page must sit
 * at its expected depth).
 */

import type { ActaClient } from '../lib/client'
import type { ImportReport } from '../lib/report'
import type { IConfluencePagePlan, IConfluencePlan } from './plan'

export function printConfluencePlan(plan: IConfluencePlan): void {
  console.log('\n== plan ==')
  for (const stub of plan.stubOps) {
    if (stub.op === 'create') console.log(`stub doc ${stub.slug}`)
  }
  for (const page of plan.pages) {
    console.log(
      `${'  '.repeat(page.depth)}${page.slug}  ("${page.title}"${
        page.op.op === 'create' && page.op.layout === 'wide' ? ', wide' : ''
      })`,
    )
  }
}

export async function runConfluenceImport(
  plan: IConfluencePlan,
  client: ActaClient,
  report: ImportReport,
  opts: { dryRun: boolean },
): Promise<void> {
  if (plan.skips.length > 0) {
    const section = report.section('skipped pages')
    for (const skip of plan.skips) {
      section.source(skip.kind, skip.n ?? 1)
      section.skipped(skip.kind, skip.id, skip.reason, skip.n ?? 1)
    }
  }
  if (plan.notes.length > 0) {
    const section = report.section('plan')
    for (const note of plan.notes) section.note(note)
  }

  if (plan.stubOps.length > 0) {
    const section = report.section('root stubs')
    section.source('stubs', plan.stubOps.length)
    if (opts.dryRun) {
      section.created('stubs', plan.stubOps.length)
    } else {
      for (const result of await client.writeDocs(plan.stubOps)) {
        if (result.ok) section.created('stubs')
        else if (result.error.includes('already exists'))
          section.skipped('stubs', result.op_id, 'already exists on the server')
        else section.failed('stubs', result.op_id, result.error)
      }
    }
  }

  const bySpace = new Map<string, typeof plan.pages>()
  for (const page of plan.pages) {
    const space = page.spaceKey ?? 'unknown'
    const bucket = bySpace.get(space) ?? []
    bucket.push(page)
    bySpace.set(space, bucket)
  }

  const results = opts.dryRun
    ? new Map<string, { ok: boolean; error?: string }>()
    : new Map(
        (await client.writeDocs(plan.pages.map((p) => p.op))).map((r) => [
          r.op_id,
          r.ok ? { ok: true } : { ok: false, error: r.error },
        ]),
      )

  // Provenance and comments follow the creates. set_meta runs for every page
  // whose create came back ok, and an op_id replay is ok too: that is what
  // enriches pages already present from the earlier lossy import.
  const pageOk = (page: IConfluencePagePlan): boolean =>
    opts.dryRun || results.get(page.op.op_id)?.ok === true
  const followUps = plan.pages
    .filter(pageOk)
    .flatMap((page) => [page.metaOp, ...page.commentOps])
  const followUpResults =
    opts.dryRun || followUps.length === 0
      ? new Map<string, { ok: boolean; error?: string }>()
      : new Map(
          (await client.writeDocs(followUps)).map((r) => [
            r.op_id,
            r.ok ? { ok: true } : { ok: false, error: r.error },
          ]),
        )

  for (const [space, pages] of bySpace) {
    const section = report.section(`space ${space}`)
    section.source('pages', pages.length)
    for (const page of pages) {
      if (opts.dryRun) {
        section.created('pages')
      } else {
        const result = results.get(page.op.op_id)
        if (result?.ok) section.created('pages')
        else if (result?.error?.includes('already exists'))
          section.skipped(
            'pages',
            page.pageId,
            `slug ${page.slug} already exists on the server`,
          )
        else section.failed('pages', page.pageId, result?.error ?? 'no result')
      }

      section.source('metas', 1)
      if (opts.dryRun) {
        section.created('metas')
      } else if (!pageOk(page)) {
        section.skipped('metas', page.pageId, 'page was not created')
      } else {
        const meta = followUpResults.get(page.metaOp.op_id)
        if (meta?.ok) section.created('metas')
        else section.failed('metas', page.pageId, meta?.error ?? 'no result')
      }

      if (page.commentOps.length > 0) {
        section.source('comments', page.commentOps.length)
        for (const op of page.commentOps) {
          if (opts.dryRun) {
            section.created('comments')
          } else if (!pageOk(page)) {
            section.skipped('comments', op.op_id, 'page was not created')
          } else {
            const result = followUpResults.get(op.op_id)
            if (result?.ok) section.created('comments')
            else
              section.failed('comments', op.op_id, result?.error ?? 'no result')
          }
        }
      }

      for (const macro of page.issues.unknownMacros)
        report.unknownMacros.push(`${macro} (page ${page.slug})`)
      for (const link of page.issues.unresolvedLinks)
        report.unresolved.push(`${link} (page ${page.slug})`)
      if (page.issues.skippedAttachments.length > 0) {
        section.source('embedded_files', page.issues.skippedAttachments.length)
        for (const filename of page.issues.skippedAttachments)
          section.skipped(
            'embedded_files',
            page.pageId,
            `embedded file ${filename} not imported (attachment export not available)`,
          )
      }

      report.mappings[`confluence:${page.pageId}`] = {
        slug: page.slug,
        title: page.title,
        parent: page.parentSlug,
        imported_author: page.authorName,
        imported_created_at: page.createdAt,
        imported_updated_at: page.updatedAt,
        confluence_version_count: page.versionCount,
      }
    }
  }

  // Tree fidelity check (mvp F12 acceptance): same parent/child depth.
  if (!opts.dryRun) {
    const tree = new Map((await client.docTree()).map((d) => [d.slug, d.depth]))
    for (const page of plan.pages) {
      const expected = page.slug.split('/').length - 1
      const actual = tree.get(page.slug)
      if (actual === undefined)
        report.errors.push(`tree check: ${page.slug} missing from doc tree`)
      else if (actual !== expected)
        report.errors.push(
          `tree check: ${page.slug} at depth ${actual}, expected ${expected}`,
        )
    }
  }
}
