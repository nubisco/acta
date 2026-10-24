import type { ISqlDriver } from '../db'
import { createWorkspace, uniqueSlug } from './workspaces'

export interface IBootstrapOptions {
  workspaceName?: string
  adminEmail?: string
  adminHandle?: string
  adminName?: string
}

/**
 * Ensure a workspace and its first admin exist (single-workspace self-host).
 * Returns the workspace id. Idempotent.
 */
export async function bootstrapWorkspace(
  db: ISqlDriver,
  opts: IBootstrapOptions = {},
): Promise<string> {
  const existing = await db.query<{
    id: string
    name: string
    slug: string | null
  }>('SELECT id, name, slug FROM workspace ORDER BY created_at LIMIT 1')
  if (existing.length > 0) {
    // Workspaces that predate the slug column get one from their name, so an
    // existing install starts addressing itself by URL without a migration
    // step anyone has to run.
    if (!existing[0].slug) {
      await db.run('UPDATE workspace SET slug = ? WHERE id = ?', [
        await uniqueSlug(db, existing[0].name, existing[0].id, true),
        existing[0].id,
      ])
    }
    // Pages that predate ownership belong to whoever wrote their first
    // version. A no-op once every page has an owner.
    await db.run(
      `UPDATE document SET owner_id = (
         SELECT v.actor_id FROM doc_version v
          WHERE v.document_id = document.id ORDER BY v.rev LIMIT 1
       ) WHERE owner_id IS NULL`,
    )
    // The list is the status. Cards that disagreed with their list before
    // that rule are reconciled once: a card sitting in a done list is done,
    // and a card marked done elsewhere moves to its space's first done list.
    // Spaces without a done list keep the flag. No-ops once consistent.
    await db.run(
      `UPDATE item SET completed = 1
        WHERE completed = 0 AND list_id IN (SELECT id FROM list WHERE role = 'done')`,
    )
    await db.run(
      `UPDATE item SET
         list_id = (SELECT l.id FROM list l
                     WHERE l.space_id = item.space_id AND l.role = 'done' AND l.archived = 0
                     ORDER BY l.pos LIMIT 1),
         pos = COALESCE((SELECT MAX(o.pos) FROM item o WHERE o.list_id = (
                 SELECT l.id FROM list l
                  WHERE l.space_id = item.space_id AND l.role = 'done' AND l.archived = 0
                  ORDER BY l.pos LIMIT 1)), 0) + 1024
        WHERE completed = 1
          AND list_id NOT IN (SELECT id FROM list WHERE role = 'done')
          AND EXISTS (SELECT 1 FROM list l
                       WHERE l.space_id = item.space_id AND l.role = 'done' AND l.archived = 0)`,
    )
    // Done cards that predate done_at count as done since their last update,
    // the closest the data can say. A no-op once they all have one.
    await db.run(
      `UPDATE item SET done_at = updated_at
        WHERE done_at IS NULL AND (completed = 1
          OR list_id IN (SELECT id FROM list WHERE role = 'done'))`,
    )
    return existing[0].id
  }

  // The instance's own workspace. It has no owner: the per-account signup
  // cap counts only workspaces people create for themselves.
  const created = await createWorkspace(db, {
    name: opts.workspaceName ?? 'Nubisco',
    allowReservedSlug: true,
    admin: opts.adminEmail
      ? {
          email: opts.adminEmail,
          handle: opts.adminHandle ?? 'admin',
          name: opts.adminName ?? 'Admin',
        }
      : undefined,
  })
  return created.workspaceId
}
