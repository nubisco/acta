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
    await db.run(
      `INSERT INTO actor (id, workspace_id, kind, handle, name, email, role, created_at)
       VALUES (?, ?, 'human', ?, ?, ?, 'admin', ?)`,
      [
        adminId,
        workspaceId,
        opts.adminHandle ?? 'admin',
        opts.adminName ?? 'Admin',
        opts.adminEmail ?? null,
        ts,
      ],
    )
    await db.run(
      `INSERT INTO actor (id, workspace_id, kind, handle, name, role, created_at)
       VALUES (?, ?, 'system', 'acta', 'Acta', 'member', ?)`,
      [newId('act'), workspaceId, ts],
    )
    const seedCtx: ICtx = {
      db,
      workspaceId,
      actor: {
        id: adminId,
        kind: 'human',
        handle: opts.adminHandle ?? 'admin',
        role: 'admin',
        scopes: ['read', 'write', 'admin'],
      },
    }
    await seedDefaultLabels(seedCtx)
  })
  return workspaceId
}
