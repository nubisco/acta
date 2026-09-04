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

/**
 * Ensure a workspace and its first admin exist (single-workspace self-host).
 * Returns the workspace id. Idempotent.
 */
export function bootstrapWorkspace(
  db: ISqlDriver,
  opts: IBootstrapOptions = {},
): string {
  const existing = db.query<{ id: string }>(
    'SELECT id FROM workspace ORDER BY created_at LIMIT 1',
  )
  if (existing.length > 0) return existing[0].id

  const ts = now()
  const workspaceId = newId('ws')
  const adminId = newId('act')
  db.transaction(() => {
    db.run('INSERT INTO workspace (id, name, created_at) VALUES (?, ?, ?)', [
      workspaceId,
      opts.workspaceName ?? 'Nubisco',
      ts,
    ])
    db.run(
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
    db.run(
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
    seedDefaultLabels(seedCtx)
  })
  return workspaceId
}
