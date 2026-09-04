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
        `INSERT INTO document (id, workspace_id, slug, title, parent_id, board_id, pos, body, layout, tags, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
