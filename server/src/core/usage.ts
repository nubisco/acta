/**
 * What a workspace holds of each thing a plan can cap (LA-399).
 *
 * One place that decides what counts, so the limit check, the billing page
 * and the over-limit rules agree: archived spaces do not count, disabled
 * people and agents do not count, and storage is the bytes of uploaded files
 * (links take no space).
 */

import type { ISqlDriver } from '../db'
import type { TLimitedResource } from './edition'

const COUNTS: Partial<Record<TLimitedResource, string>> = {
  spaces:
    'SELECT COUNT(*) AS n FROM space WHERE workspace_id = ? AND archived = 0',
  members:
    "SELECT COUNT(*) AS n FROM actor WHERE workspace_id = ? AND kind = 'human' AND disabled = 0",
  agents:
    "SELECT COUNT(*) AS n FROM actor WHERE workspace_id = ? AND kind = 'agent' AND disabled = 0",
  rules: 'SELECT COUNT(*) AS n FROM rule WHERE workspace_id = ?',
  webhooks: 'SELECT COUNT(*) AS n FROM webhook WHERE workspace_id = ?',
  items: 'SELECT COUNT(*) AS n FROM item WHERE workspace_id = ?',
  storage_bytes:
    "SELECT COALESCE(SUM(size), 0) AS n FROM attachment WHERE workspace_id = ? AND kind = 'file'",
}

/** How much of `resource` the workspace holds now. file_bytes is per file, so 0. */
export async function usageOf(
  db: ISqlDriver,
  workspaceId: string,
  resource: TLimitedResource,
): Promise<number> {
  const sql = COUNTS[resource]
  if (!sql) return 0
  const rows = await db.query<{ n: number }>(sql, [workspaceId])
  return Number(rows[0]?.n ?? 0)
}

/** Every counted resource at once, for the billing page. */
export async function usageSummary(
  db: ISqlDriver,
  workspaceId: string,
): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  for (const resource of Object.keys(COUNTS) as TLimitedResource[]) {
    out[resource] = await usageOf(db, workspaceId, resource)
  }
  return out
}
