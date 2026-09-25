import {
  anchorTextFromMarkdown,
  applySectionEdit,
  extractRefs,
  newId,
  sectionMap,
  type TDocOp,
  type TOpResult,
} from '@nubisco/acta-shared'
import type { ICtx } from '../core/ctx'
import { ApiError, now } from '../core/ctx'
import { emitEvent } from '../core/events'
import { newMentions } from './notifications'
import {
  assertCanDeleteComment,
  assertCanEditComment,
  commentDeletePolicy,
} from './comments'
import { ftsDelete, ftsUpsert } from '../core/fts'
import { withOp } from '../core/ops'
import { spaceByKey, docBySlug, type IDocRow } from '../core/store'
import { anchorForComment, anchorStatus } from './anchors'
import type { AttachmentStore } from './attachments'

export async function docWrite(
  ctx: ICtx,
  ops: TDocOp[],
  store?: AttachmentStore,
): Promise<TOpResult[]> {
  const results: TOpResult[] = []
  for (const op of ops) {
    results.push(await withOp(ctx, op.op_id, () => applyDocOp(ctx, op, store)))
  }
  return results
}

async function saveVersion(
  ctx: ICtx,
  doc: IDocRow,
  body: string,
  title: string,
): Promise<number> {
  const rev = doc.rev + 1
  const ts = now()
  await ctx.db.run(
    'UPDATE document SET body = ?, title = ?, rev = ?, updated_at = ? WHERE id = ?',
    [body, title, rev, ts, doc.id],
  )
  await ctx.db.run(
    'INSERT INTO doc_version (id, document_id, rev, body, title, actor_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [newId('doc'), doc.id, rev, body, title, ctx.actor.id, ts],
  )
  await syncDocDerived(ctx, doc.id, doc.slug, title, body)
  return rev
}

async function syncDocDerived(
  ctx: ICtx,
  docId: string,
  slug: string,
  title: string,
  body: string,
): Promise<void> {
  await ftsUpsert(ctx, 'doc', slug, title, body)
  await ctx.db.run("DELETE FROM link WHERE src_kind = 'doc' AND src_id = ?", [
    docId,
  ])
  for (const ref of extractRefs(body)) {
    await ctx.db.run(
      `INSERT OR IGNORE INTO link (workspace_id, src_kind, src_id, ref_type, target)
       VALUES (?, 'doc', ?, ?, ?)`,
      [ctx.workspaceId, docId, ref.type, ref.target],
    )
  }
}

/** Gap between neighbours when a page is created or siblings are renumbered. */
const DOC_POS_STEP = 1024

/**
 * Below this, halving the gap again is left to renumbering. Positions are
 * REAL, so a midpoint always exists in principle, but about fifty moves into
 * the same gap exhaust a double's precision and the midpoint collapses onto a
 * neighbour. Renumbering long before that keeps every position distinct.
 */
const DOC_POS_MIN_GAP = 1e-6

/**
 * A position directly before or after `anchorId` among the children of
 * `parentId`, not counting the page being moved.
 *
 * Normally the midpoint between the two neighbours, which writes nothing else.
 * When there is no room left, the siblings are renumbered in order, with the
 * moved page's slot kept free, in the same op.
 */
async function placeBeside(
  ctx: ICtx,
  docId: string,
  parentId: string | null,
  anchorId: string,
  side: 'before' | 'after',
): Promise<number> {
  const siblings = await ctx.db.query<{ id: string; pos: number }>(
    'SELECT id, pos FROM document WHERE workspace_id = ? AND parent_id IS ? AND id != ? ORDER BY pos, id',
    [ctx.workspaceId, parentId, docId],
  )
  const index = siblings.findIndex((s) => s.id === anchorId)
  const insertAt = side === 'before' ? index : index + 1
  const lo = siblings[insertAt - 1]?.pos
  const hi = siblings[insertAt]?.pos
  if (lo === undefined && hi === undefined) return DOC_POS_STEP
  if (lo === undefined) return hi - DOC_POS_STEP
  if (hi === undefined) return lo + DOC_POS_STEP
  const mid = (lo + hi) / 2
  if (hi - lo >= DOC_POS_MIN_GAP && lo < mid && mid < hi) return mid

  for (let k = 0; k < siblings.length; k++) {
    const target = (k + (k >= insertAt ? 2 : 1)) * DOC_POS_STEP
    if (siblings[k].pos !== target)
      await ctx.db.run('UPDATE document SET pos = ? WHERE id = ?', [
        target,
        siblings[k].id,
      ])
  }
  return (insertAt + 1) * DOC_POS_STEP
}

/**
 * Whether `ancestorId` is `docId` itself or anywhere on the parent chain above
 * it.
 *
 * One recursive query rather than a loop of lookups, so it costs one round
 * trip on D1 however deep the tree is. `UNION` (not `UNION ALL`) is what bounds
 * it: SQLite never queues a row it has already queued, so a chain that already
 * loops back on itself stops after visiting each page once instead of walking
 * round forever.
 */
async function isAncestorOrSelf(
  ctx: ICtx,
  ancestorId: string,
  docId: string,
): Promise<boolean> {
  const rows = await ctx.db.query<{ hit: number }>(
    `WITH RECURSIVE chain(id, parent_id) AS (
       SELECT id, parent_id FROM document WHERE id = ? AND workspace_id = ?
       UNION
       SELECT d.id, d.parent_id FROM document d JOIN chain ON d.id = chain.parent_id
     )
     SELECT 1 AS hit FROM chain WHERE id = ? LIMIT 1`,
    [docId, ctx.workspaceId, ancestorId],
  )
  return rows.length > 0
}

async function applyDocOp(
  ctx: ICtx,
  op: TDocOp,
  store?: AttachmentStore,
): Promise<{
  slug?: string
  id?: string
  rev?: number
  anchor_status?: 'anchored' | 'detached'
}> {
  const ts = now()
  switch (op.op) {
    case 'create': {
      const existing = await ctx.db.query(
        'SELECT id FROM document WHERE workspace_id = ? AND slug = ?',
        [ctx.workspaceId, op.slug],
      )
      if (existing.length > 0)
        throw new ApiError(409, `doc ${op.slug} already exists`)
      const parent = op.parent ? await docBySlug(ctx, op.parent) : null
      const space = op.space ? await spaceByKey(ctx, op.space) : null
      const id = newId('doc')
      const siblings = await ctx.db.query<{ m: number | null }>(
        'SELECT MAX(pos) AS m FROM document WHERE workspace_id = ? AND parent_id IS ?',
        [ctx.workspaceId, parent?.id ?? null],
      )
      await ctx.db.run(
        `INSERT INTO document (id, workspace_id, slug, title, parent_id, space_id, pos, body, layout, tags, created_at, updated_at, imported_meta)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          ctx.workspaceId,
          op.slug,
          op.title,
          parent?.id ?? null,
          space?.id ?? null,
          (siblings[0]?.m ?? 0) + 1024,
          op.body,
          op.layout,
          JSON.stringify(op.tags),
          ts,
          ts,
          op.imported_meta ? JSON.stringify(op.imported_meta) : null,
        ],
      )
      await ctx.db.run(
        'INSERT INTO doc_version (id, document_id, rev, body, title, actor_id, created_at) VALUES (?, ?, 1, ?, ?, ?, ?)',
        [newId('doc'), id, op.body, op.title, ctx.actor.id, ts],
      )
      await syncDocDerived(ctx, id, op.slug, op.title, op.body)
      await emitEvent(
        ctx,
        'doc.created',
        'doc',
        id,
        `created doc ${op.slug}`,
        undefined,
        // A page often arrives with the people it concerns already named in
        // it. Cards have done this since they were fixed; documents never
        // did, so being written into a brand new page told nobody.
        { body: op.body },
      )
      return { slug: op.slug, id, rev: 1 }
    }
    case 'comment': {
      const doc = await docBySlug(ctx, op.ref)
      const id = newId('cmt')
      // Out of band: the anchor goes in this row, and the document is not
      // written at all, so its rev and its markdown are exactly as they were.
      const anchor = op.anchor ? anchorForComment(doc.body, op.anchor) : null
      await ctx.db.run(
        'INSERT INTO doc_comment (id, workspace_id, document_id, actor_id, body, created_at, imported_meta, anchor) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [
          id,
          ctx.workspaceId,
          doc.id,
          ctx.actor.id,
          op.body,
          ts,
          op.imported_meta ? JSON.stringify(op.imported_meta) : null,
          anchor ? JSON.stringify(anchor) : null,
        ],
      )
      await ftsUpsert(ctx, 'comment', id, doc.slug, op.body)
      for (const ref of extractRefs(op.body)) {
        await ctx.db.run(
          `INSERT OR IGNORE INTO link (workspace_id, src_kind, src_id, ref_type, target)
           VALUES (?, 'comment', ?, ?, ?)`,
          [ctx.workspaceId, id, ref.type, ref.target],
        )
      }
      await emitEvent(
        ctx,
        'comment.created',
        'doc',
        doc.id,
        `commented on ${doc.slug}`,
        undefined,
        op.body,
      )
      return {
        slug: doc.slug,
        id,
        rev: doc.rev,
        anchor_status: anchor
          ? anchorStatus(anchorTextFromMarkdown(doc.body), anchor)
          : undefined,
      }
    }
    case 'comment_resolve': {
      const doc = await docBySlug(ctx, op.ref)
      const existing = (
        await ctx.db.query<{
          id: string
          resolved_at: number | null
          actor_id: string
        }>(
          'SELECT id, resolved_at, actor_id FROM doc_comment WHERE id = ? AND document_id = ?',
          [op.comment_id, doc.id],
        )
      )[0]
      if (!existing)
        throw new ApiError(404, `comment ${op.comment_id} not on ${doc.slug}`)
      // Already in the requested state: nothing to write and nothing to
      // announce, so resolving twice does not tell everyone twice.
      if ((existing.resolved_at !== null) === op.resolved)
        return { slug: doc.slug, id: existing.id, rev: doc.rev }
      await ctx.db.run(
        'UPDATE doc_comment SET resolved_at = ?, resolved_by = ? WHERE id = ?',
        [
          op.resolved ? ts : null,
          op.resolved ? ctx.actor.id : null,
          existing.id,
        ],
      )
      await emitEvent(
        ctx,
        op.resolved ? 'comment.resolved' : 'comment.reopened',
        'doc',
        doc.id,
        `${op.resolved ? 'resolved' : 'reopened'} a comment on ${doc.slug}`,
        undefined,
        // The person who raised it, by name. They are a participant on the
        // page too, but somebody closing your question is about you, and
        // arriving in the same breath as everyone else who ever commented
        // is not the same message.
        { to: [{ actorId: existing.actor_id, reason: 'involved' as const }] },
      )
      return { slug: doc.slug, id: existing.id, rev: doc.rev }
    }
    case 'comment_update': {
      const doc = await docBySlug(ctx, op.ref)
      const existing = (
        await ctx.db.query<{ id: string; body: string; actor_id: string }>(
          'SELECT id, body, actor_id FROM doc_comment WHERE id = ? AND document_id = ?',
          [op.comment_id, doc.id],
        )
      )[0]
      if (!existing)
        throw new ApiError(404, `comment ${op.comment_id} not on ${doc.slug}`)
      assertCanEditComment(ctx, existing.actor_id)
      const body = op.body ?? existing.body
      await ctx.db.run(
        `UPDATE doc_comment SET body = ?, edited_at = CASE WHEN ? THEN ? ELSE edited_at END,
           imported_meta = CASE WHEN ? THEN ? ELSE imported_meta END WHERE id = ?`,
        [
          body,
          op.body !== undefined ? 1 : 0,
          ts,
          op.imported_meta !== undefined ? 1 : 0,
          op.imported_meta ? JSON.stringify(op.imported_meta) : null,
          existing.id,
        ],
      )
      if (op.body !== undefined) {
        await ftsUpsert(ctx, 'comment', existing.id, doc.slug, body)
        await emitEvent(
          ctx,
          'comment.updated',
          'doc',
          doc.id,
          `edited a comment on ${doc.slug}`,
          undefined,
          { body: newMentions(existing.body, body) },
        )
      }
      return { slug: doc.slug, id: existing.id, rev: doc.rev }
    }
    case 'comment_delete': {
      const doc = await docBySlug(ctx, op.ref)
      const existing = (
        await ctx.db.query<{ id: string; actor_id: string }>(
          'SELECT id, actor_id FROM doc_comment WHERE id = ? AND document_id = ?',
          [op.comment_id, doc.id],
        )
      )[0]
      if (!existing)
        throw new ApiError(404, `comment ${op.comment_id} not on ${doc.slug}`)
      assertCanDeleteComment(
        ctx,
        existing.actor_id,
        await commentDeletePolicy(ctx),
      )

      // The index and the link rows go with it, and the anchor goes with the
      // row, so the page's markdown is untouched. Deleting a comment has
      // never been able to change a document and must not start now.
      await ftsDelete(ctx, 'comment', existing.id)
      await ctx.db.run('DELETE FROM link WHERE src_kind = ? AND src_id = ?', [
        'comment',
        existing.id,
      ])
      await ctx.db.run('DELETE FROM doc_comment WHERE id = ?', [existing.id])
      await emitEvent(
        ctx,
        'comment.deleted',
        'doc',
        doc.id,
        `deleted a comment on ${doc.slug}`,
      )
      return { slug: doc.slug, id: existing.id, rev: doc.rev }
    }
    case 'set_meta': {
      // Provenance is bookkeeping, not content: no rev bump, no event noise.
      const doc = await docBySlug(ctx, op.ref)
      await ctx.db.run('UPDATE document SET imported_meta = ? WHERE id = ?', [
        op.imported_meta ? JSON.stringify(op.imported_meta) : null,
        doc.id,
      ])
      return { slug: doc.slug, rev: doc.rev }
    }
    case 'set_layout': {
      // Page width is how the page is shown, not what it says. No rev bump
      // and no version, so an editor holding `if_rev` is not put into a
      // conflict by somebody widening the page, and the body is never read or
      // written here.
      const doc = await docBySlug(ctx, op.ref)
      if (doc.layout === op.layout) return { slug: doc.slug, rev: doc.rev }
      await ctx.db.run(
        'UPDATE document SET layout = ?, updated_at = ? WHERE id = ?',
        [op.layout, ts, doc.id],
      )
      await emitEvent(
        ctx,
        'doc.layout_changed',
        'doc',
        doc.id,
        `set ${doc.slug} to ${op.layout} width`,
        { layout: op.layout },
      )
      return { slug: doc.slug, rev: doc.rev }
    }
    case 'replace': {
      const doc = await docBySlug(ctx, op.ref)
      if (op.if_rev !== doc.rev)
        throw new ApiError(409, `rev conflict on ${doc.slug}`, {
          slug: doc.slug,
          rev: doc.rev,
        })
      const rev = await saveVersion(ctx, doc, op.body, doc.title)
      await emitEvent(
        ctx,
        'doc.updated',
        'doc',
        doc.id,
        `replaced ${doc.slug}`,
        undefined,
        // Mentions only, and only the new ones. A page nobody is named in
        // can be saved a hundred times in an afternoon without ringing once,
        // which is why doc.updated is not a verb involvement reacts to.
        { body: newMentions(doc.body, op.body) },
      )
      return { slug: doc.slug, rev }
    }
    case 'patch_section': {
      const doc = await docBySlug(ctx, op.ref)
      const sections = sectionMap(doc.body)
      const section = sections.find((s) => s.slug === op.section)
      if (!section)
        throw new ApiError(
          404,
          `section ${op.section} not found in ${doc.slug}`,
          {
            sections: sections.map((s) => ({ slug: s.slug, hash: s.hash })),
          },
        )
      if (section.hash !== op.if_hash)
        throw new ApiError(
          409,
          `section conflict on ${doc.slug}#${op.section}`,
          {
            slug: doc.slug,
            rev: doc.rev,
            section: { slug: section.slug, hash: section.hash },
          },
        )
      const body = applySectionEdit(doc.body, section, op.body, op.mode)
      const rev = await saveVersion(ctx, doc, body, doc.title)
      await emitEvent(
        ctx,
        'doc.updated',
        'doc',
        doc.id,
        `patched ${doc.slug}#${op.section}`,
        undefined,
        { body: newMentions(doc.body, body) },
      )
      return { slug: doc.slug, rev }
    }
    case 'append': {
      const doc = await docBySlug(ctx, op.ref)
      const body =
        doc.body.length > 0
          ? `${doc.body.replace(/\n*$/, '')}\n\n${op.body}`
          : op.body
      const rev = await saveVersion(ctx, doc, body, doc.title)
      await emitEvent(
        ctx,
        'doc.updated',
        'doc',
        doc.id,
        `appended to ${doc.slug}`,
        undefined,
        { body: newMentions(doc.body, body) },
      )
      return { slug: doc.slug, rev }
    }
    case 'move': {
      // Only `parent_id` and `pos` change. The slug never does, even when it
      // no longer describes where the page lives, because URLs, doc refs,
      // heading links and block links all point at it.
      const doc = await docBySlug(ctx, op.ref)
      const placements = [op.before, op.after, op.position].filter(
        (v) => v !== undefined,
      ).length
      if (placements > 1)
        throw new ApiError(
          400,
          'give at most one of before, after and position',
        )
      const anchorSlug = op.before ?? op.after
      const anchor = anchorSlug ? await docBySlug(ctx, anchorSlug) : null
      if (anchor?.id === doc.id)
        throw new ApiError(400, `cannot place ${doc.slug} next to itself`)

      let parentId = doc.parent_id
      if (op.parent !== undefined)
        parentId =
          op.parent === null ? null : (await docBySlug(ctx, op.parent)).id
      if (anchor) {
        if (op.parent !== undefined && parentId !== anchor.parent_id)
          throw new ApiError(
            400,
            `${anchor.slug} is not directly under ${op.parent ?? 'the top level'}`,
          )
        parentId = anchor.parent_id
      }
      if (parentId === doc.id)
        throw new ApiError(400, 'doc cannot be its own parent')
      if (parentId !== null && (await isAncestorOrSelf(ctx, doc.id, parentId)))
        throw new ApiError(
          400,
          `cannot move ${doc.slug} into ${op.parent ?? anchor?.slug}: that is one of its own subpages`,
        )

      let pos = doc.pos
      if (op.position !== undefined) pos = op.position
      else if (anchor)
        pos = await placeBeside(
          ctx,
          doc.id,
          parentId,
          anchor.id,
          op.before !== undefined ? 'before' : 'after',
        )
      else if (parentId !== doc.parent_id) {
        // A new parent with no placement: last child, like a new page.
        const tail = await ctx.db.query<{ m: number | null }>(
          'SELECT MAX(pos) AS m FROM document WHERE workspace_id = ? AND parent_id IS ? AND id != ?',
          [ctx.workspaceId, parentId, doc.id],
        )
        pos = (tail[0]?.m ?? 0) + DOC_POS_STEP
      }
      await ctx.db.run(
        'UPDATE document SET parent_id = ?, pos = ?, updated_at = ? WHERE id = ?',
        [parentId, pos, ts, doc.id],
      )
      await emitEvent(ctx, 'doc.moved', 'doc', doc.id, `moved ${doc.slug}`)
      return { slug: doc.slug, rev: doc.rev }
    }
    case 'rename': {
      const doc = await docBySlug(ctx, op.ref)
      const newSlug = op.slug ?? doc.slug
      if (newSlug !== doc.slug) {
        const clash = await ctx.db.query(
          'SELECT id FROM document WHERE workspace_id = ? AND slug = ?',
          [ctx.workspaceId, newSlug],
        )
        if (clash.length > 0)
          throw new ApiError(409, `doc ${newSlug} already exists`)
      }
      const title = op.title ?? doc.title
      await ctx.db.run(
        'UPDATE document SET slug = ?, title = ?, updated_at = ? WHERE id = ?',
        [newSlug, title, ts, doc.id],
      )
      await syncDocDerived(ctx, doc.id, newSlug, title, doc.body)
      if (newSlug !== doc.slug) {
        await ctx.db.run("DELETE FROM fts WHERE kind = 'doc' AND ref = ?", [
          doc.slug,
        ])
      }
      await emitEvent(
        ctx,
        'doc.renamed',
        'doc',
        doc.id,
        `renamed ${doc.slug} to ${newSlug}`,
      )
      return { slug: newSlug, rev: doc.rev }
    }
    case 'archive': {
      const doc = await docBySlug(ctx, op.ref)
      await ctx.db.run(
        'UPDATE document SET archived = 1, updated_at = ? WHERE id = ?',
        [ts, doc.id],
      )
      await emitEvent(
        ctx,
        'doc.archived',
        'doc',
        doc.id,
        `archived ${doc.slug}`,
      )
      return { slug: doc.slug, rev: doc.rev }
    }
    case 'delete': {
      // Leaf pages only: a subtree disappearing because of one op on its root
      // is more loss than a hard delete without undo should allow. Comments,
      // versions, attachments (with their blobs), links and search rows all
      // belong to the page and go with it.
      const doc = await docBySlug(ctx, op.ref)
      const children = await ctx.db.query<{ id: string }>(
        'SELECT id FROM document WHERE parent_id = ? LIMIT 1',
        [doc.id],
      )
      if (children.length > 0)
        throw new ApiError(
          409,
          `${doc.slug} has child pages; delete or move them first`,
        )
      const comments = await ctx.db.query<{ id: string }>(
        'SELECT id FROM doc_comment WHERE document_id = ?',
        [doc.id],
      )
      for (const comment of comments) {
        await ftsDelete(ctx, 'comment', comment.id)
        await ctx.db.run(
          "DELETE FROM link WHERE src_kind = 'comment' AND src_id = ?",
          [comment.id],
        )
      }
      await ctx.db.run('DELETE FROM doc_comment WHERE document_id = ?', [
        doc.id,
      ])
      await ctx.db.run('DELETE FROM doc_version WHERE document_id = ?', [
        doc.id,
      ])
      const attachments = await ctx.db.query<{ id: string; kind: string }>(
        "SELECT id, kind FROM attachment WHERE owner_kind = 'doc' AND owner_id = ?",
        [doc.id],
      )
      for (const attachment of attachments) {
        if (attachment.kind === 'file') await store?.remove(attachment.id)
      }
      await ctx.db.run(
        "DELETE FROM attachment WHERE owner_kind = 'doc' AND owner_id = ?",
        [doc.id],
      )
      await ctx.db.run(
        "DELETE FROM link WHERE src_kind = 'doc' AND src_id = ?",
        [doc.id],
      )
      await ftsDelete(ctx, 'doc', doc.slug)
      await ctx.db.run('DELETE FROM document WHERE id = ?', [doc.id])
      await emitEvent(ctx, 'doc.deleted', 'doc', doc.id, `deleted ${doc.slug}`)
      return { slug: doc.slug }
    }
  }
}
