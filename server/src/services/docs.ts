import {
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
import { ftsUpsert } from '../core/fts'
import { withOp } from '../core/ops'
import { boardByKey, docBySlug, type IDocRow } from '../core/store'

export async function docWrite(ctx: ICtx, ops: TDocOp[]): Promise<TOpResult[]> {
  const results: TOpResult[] = []
  for (const op of ops) {
    results.push(await withOp(ctx, op.op_id, () => applyDocOp(ctx, op)))
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

async function applyDocOp(
  ctx: ICtx,
  op: TDocOp,
): Promise<{ slug?: string; id?: string; rev?: number }> {
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
      const board = op.board ? await boardByKey(ctx, op.board) : null
      const id = newId('doc')
      const siblings = await ctx.db.query<{ m: number | null }>(
        'SELECT MAX(pos) AS m FROM document WHERE workspace_id = ? AND parent_id IS ?',
        [ctx.workspaceId, parent?.id ?? null],
      )
      await ctx.db.run(
        `INSERT INTO document (id, workspace_id, slug, title, parent_id, board_id, pos, body, layout, tags, created_at, updated_at, imported_meta)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          ctx.workspaceId,
          op.slug,
          op.title,
          parent?.id ?? null,
          board?.id ?? null,
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
      await emitEvent(ctx, 'doc.created', 'doc', id, `created doc ${op.slug}`)
      return { slug: op.slug, id, rev: 1 }
    }
    case 'comment': {
      const doc = await docBySlug(ctx, op.ref)
      const id = newId('cmt')
      await ctx.db.run(
        'INSERT INTO doc_comment (id, workspace_id, document_id, actor_id, body, created_at, imported_meta) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [
          id,
          ctx.workspaceId,
          doc.id,
          ctx.actor.id,
          op.body,
          ts,
          op.imported_meta ? JSON.stringify(op.imported_meta) : null,
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
      )
      return { slug: doc.slug, id, rev: doc.rev }
    }
    case 'comment_update': {
      const doc = await docBySlug(ctx, op.ref)
      const existing = (
        await ctx.db.query<{ id: string; body: string }>(
          'SELECT id, body FROM doc_comment WHERE id = ? AND document_id = ?',
          [op.comment_id, doc.id],
        )
      )[0]
      if (!existing)
        throw new ApiError(404, `comment ${op.comment_id} not on ${doc.slug}`)
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
        )
      }
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
    case 'replace': {
      const doc = await docBySlug(ctx, op.ref)
      if (op.if_rev !== doc.rev)
        throw new ApiError(409, `rev conflict on ${doc.slug}`, {
          slug: doc.slug,
          rev: doc.rev,
        })
      const rev = await saveVersion(ctx, doc, op.body, doc.title)
      await emitEvent(ctx, 'doc.updated', 'doc', doc.id, `replaced ${doc.slug}`)
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
      )
      return { slug: doc.slug, rev }
    }
    case 'move': {
      const doc = await docBySlug(ctx, op.ref)
      let parentId = doc.parent_id
      if (op.parent !== undefined) {
        if (op.parent === null) {
          parentId = null
        } else {
          const parent = await docBySlug(ctx, op.parent)
          if (parent.id === doc.id)
            throw new ApiError(400, 'doc cannot be its own parent')
          parentId = parent.id
        }
      }
      await ctx.db.run(
        'UPDATE document SET parent_id = ?, pos = COALESCE(?, pos), updated_at = ? WHERE id = ?',
        [parentId, op.position ?? null, ts, doc.id],
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
  }
}
