import { newId } from '@nubisco/acta-shared'
import type { ISqlDriver } from '../db'
import { now, type ICtx } from './ctx'
import { seedDefaultLabels } from '../services/labels'

export interface IBootstrapOptions {
  workspaceName?: string
  adminEmail?: string
  adminHandle?: string
  adminName?: string
}

/** URL-safe form of a workspace name: "Acme Corp." becomes "acme-corp". */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
  return slug || 'workspace'
}

/**
 * A slug no other workspace holds. Two workspaces called "Support" would
 * otherwise collide on the unique index and fail the insert, which is a
 * confusing way to learn the name is taken.
 */
async function uniqueSlug(
  db: ISqlDriver,
  name: string,
  ownId: string,
): Promise<string> {
  const base = slugify(name)
  for (let n = 0; n < 100; n++) {
    const candidate = n === 0 ? base : `${base}-${n + 1}`
    const taken = await db.query<{ id: string }>(
      'SELECT id FROM workspace WHERE slug = ? AND id != ?',
      [candidate, ownId],
    )
    if (taken.length === 0) return candidate
  }
  return `${base}-${ownId.slice(-6)}`
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
        await uniqueSlug(db, existing[0].name, existing[0].id),
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

  const ts = now()
  const workspaceId = newId('ws')
  const adminId = newId('act')
  await db.transaction(async () => {
    const name = opts.workspaceName ?? 'Nubisco'
    await db.run(
      'INSERT INTO workspace (id, name, slug, created_at) VALUES (?, ?, ?, ?)',
      [workspaceId, name, await uniqueSlug(db, name, workspaceId), ts],
    )
    // Only when there is an address to reach them at. An admin actor with a
    // null email is a seat nobody can sit in: OTP finds people by email and
    // SSO matches on it, so a seeded admin without one locks the workspace
    // into having an administrator that no human can ever be. Instances that
    // delegate identity to an SSO provider leave this unset and get their
    // administrator from the first person through the door instead; see
    // `firstAdmin` in the SSO callback.
    if (opts.adminEmail) {
      await db.run(
        `INSERT INTO actor (id, workspace_id, kind, handle, name, email, role, created_at)
         VALUES (?, ?, 'human', ?, ?, ?, 'admin', ?)`,
        [
          adminId,
          workspaceId,
          opts.adminHandle ?? 'admin',
          opts.adminName ?? 'Admin',
          opts.adminEmail,
          ts,
        ],
      )
    }
    const systemId = newId('act')
    await db.run(
      `INSERT INTO actor (id, workspace_id, kind, handle, name, role, created_at)
       VALUES (?, ?, 'system', 'acta', 'Acta', 'member', ?)`,
      [systemId, workspaceId, ts],
    )
    // Attributed to whoever exists. Without an adminEmail there is no admin
    // actor to credit the default labels to, and crediting them to an id that
    // was never inserted is a foreign key away from failing the whole
    // bootstrap.
    const seeder = opts.adminEmail
      ? {
          id: adminId,
          kind: 'human' as const,
          handle: opts.adminHandle ?? 'admin',
          role: 'admin' as const,
          scopes: ['read', 'write', 'admin'],
        }
      : {
          id: systemId,
          kind: 'system' as const,
          handle: 'acta',
          role: 'member' as const,
          scopes: ['read', 'write', 'admin'],
        }
    const seedCtx: ICtx = { db, workspaceId, actor: seeder }
    await seedDefaultLabels(seedCtx)
  })
  return workspaceId
}
