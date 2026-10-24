/**
 * Per-workspace export (LA-401): everything a workspace holds, in one zip an
 * admin can take away. The right of access and portability in practice, and
 * what someone deleting a workspace should be offered first.
 *
 * The zip holds:
 *
 * - `tables/<table>.jsonl`, one row per line, for every table that holds the
 *   workspace's content. Credentials and their hashes are left out (tokens,
 *   OAuth grants, sign-in codes, webhook and connection secrets, the AI key),
 *   and so are the purely internal tables (idempotency records, email quotas,
 *   notifications, which are one person's inbox rather than the workspace's).
 * - `docs/<slug>.md` for every page, title first.
 * - `attachments/<id>-<filename>` for uploaded files, up to `MAX_FILE_BYTES`
 *   in total. Past that the rest are listed in the README rather than
 *   silently dropped.
 * - `README.txt` saying what is in it.
 *
 * Private pages follow the same rule as everywhere else: the admin who asked
 * gets their own, and nobody else's. An export is a copy of what that person
 * could already open, not a way around a page's privacy.
 *
 * The work happens off the request (a deferred task, and the cron as the
 * fallback), because building it reads every row the workspace has. The link
 * is a random token kept only as a hash, valid for `LINK_DAYS`.
 */

import { newId } from '@nubisco/acta-shared'
import type { ISqlDriver } from '../db'
import { ApiError, now, type ICtx } from '../core/ctx'
import { randomToken, sha256Hex } from '../core/auth'
import { hiddenDocIds } from '../core/docAccess'
import { emitEvent, flushPendingEvents } from '../core/events'
import { exportReadyEmail, type TEmailSender } from '../core/email'
import { buildZip, type IZipEntry } from '../core/zip'
import type { AttachmentStore } from './attachments'
import { BATCH, deleteInBatches, type IBudget } from './retention'

export const LINK_DAYS = 7
/** Uploaded files per export. The whole zip is built in memory on Workers. */
export const MAX_FILE_BYTES = 64 * 1024 * 1024
/** A claimed export not finished in this long is taken up again. */
const STALE_CLAIM_MS = 15 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

interface ITableExport {
  table: string
  /** Selects the workspace's rows. `?1` is the workspace id, `?2` the hidden pages (JSON). */
  sql: string
  /** Columns never exported: credentials and their hashes. */
  drop?: string[]
}

/** Not one of the hidden pages, which arrive as one JSON parameter (?2). */
const VISIBLE = (column: string) =>
  `${column} NOT IN (SELECT value FROM json_each(?2))`
/** One of the hidden pages. */
const HIDDEN = (column: string) =>
  `${column} IN (SELECT value FROM json_each(?2))`

/**
 * The parameters a statement numbers, and no more: SQLite and D1 both refuse
 * a value bound to a number the statement does not use.
 */
function paramsFor(sql: string, all: unknown[]): unknown[] {
  const used = [...sql.matchAll(/\?(\d+)/g)].map((m) => Number(m[1]))
  return all.slice(0, used.length > 0 ? Math.max(...used) : 0)
}

/**
 * Every table a workspace's content lives in. A test checks that each table
 * in the schema is either here or in `NOT_EXPORTED`, so a new table cannot be
 * forgotten by both.
 */
export const EXPORTED: ITableExport[] = [
  { table: 'workspace', sql: 'SELECT * FROM workspace WHERE id = ?1' },
  { table: 'actor', sql: 'SELECT * FROM actor WHERE workspace_id = ?1' },
  { table: 'space', sql: 'SELECT * FROM space WHERE workspace_id = ?1' },
  { table: 'list', sql: 'SELECT * FROM list WHERE workspace_id = ?1' },
  { table: 'item', sql: 'SELECT * FROM item WHERE workspace_id = ?1' },
  {
    table: 'item_key_alias',
    sql: 'SELECT * FROM item_key_alias WHERE workspace_id = ?1',
  },
  {
    table: 'item_dependency',
    sql: 'SELECT * FROM item_dependency WHERE workspace_id = ?1',
  },
  {
    table: 'item_label',
    sql: 'SELECT l.* FROM item_label l JOIN item i ON i.id = l.item_id WHERE i.workspace_id = ?1',
  },
  {
    table: 'item_assignee',
    sql: 'SELECT a.* FROM item_assignee a JOIN item i ON i.id = a.item_id WHERE i.workspace_id = ?1',
  },
  {
    table: 'label_group',
    sql: 'SELECT * FROM label_group WHERE workspace_id = ?1',
  },
  { table: 'label', sql: 'SELECT * FROM label WHERE workspace_id = ?1' },
  {
    table: 'checklist',
    sql: 'SELECT * FROM checklist WHERE workspace_id = ?1',
  },
  {
    table: 'checklist_item',
    sql: 'SELECT ci.* FROM checklist_item ci JOIN checklist c ON c.id = ci.checklist_id WHERE c.workspace_id = ?1',
  },
  { table: 'comment', sql: 'SELECT * FROM comment WHERE workspace_id = ?1' },
  {
    table: 'document',
    sql: `SELECT * FROM document WHERE workspace_id = ?1 AND ${VISIBLE('id')}`,
  },
  {
    table: 'doc_version',
    sql: `SELECT v.* FROM doc_version v JOIN document d ON d.id = v.document_id
           WHERE d.workspace_id = ?1 AND ${VISIBLE('d.id')}`,
  },
  {
    table: 'doc_comment',
    sql: `SELECT * FROM doc_comment WHERE workspace_id = ?1 AND ${VISIBLE('document_id')}`,
  },
  {
    table: 'link',
    sql: `SELECT * FROM link WHERE workspace_id = ?1
           AND NOT (src_kind = 'doc' AND ${HIDDEN('src_id')})`,
  },
  {
    table: 'attachment',
    sql: `SELECT * FROM attachment WHERE workspace_id = ?1
           AND NOT (owner_kind = 'doc' AND ${HIDDEN('owner_id')})`,
  },
  { table: 'goal', sql: 'SELECT * FROM goal WHERE workspace_id = ?1' },
  {
    table: 'goal_item',
    sql: 'SELECT * FROM goal_item WHERE workspace_id = ?1',
  },
  {
    table: 'goal_update',
    sql: 'SELECT * FROM goal_update WHERE workspace_id = ?1',
  },
  {
    table: 'goal_follower',
    sql: 'SELECT f.* FROM goal_follower f JOIN goal g ON g.id = f.goal_id WHERE g.workspace_id = ?1',
  },
  {
    // Activity about a private page is for its owner only (event.private_to).
    table: 'event',
    sql: 'SELECT * FROM event WHERE workspace_id = ?1 AND (private_to IS NULL OR private_to = ?3)',
  },
  { table: 'rule', sql: 'SELECT * FROM rule WHERE workspace_id = ?1' },
  {
    table: 'webhook',
    sql: 'SELECT * FROM webhook WHERE workspace_id = ?1',
    drop: ['secret'],
  },
  {
    table: 'webhook_delivery',
    sql: 'SELECT d.* FROM webhook_delivery d JOIN webhook w ON w.id = d.webhook_id WHERE w.workspace_id = ?1',
  },
  {
    table: 'connection',
    sql: 'SELECT * FROM connection WHERE workspace_id = ?1',
    drop: ['secret'],
  },
  {
    table: 'external_link',
    sql: 'SELECT * FROM external_link WHERE workspace_id = ?1',
  },
  {
    table: 'space_star',
    sql: 'SELECT * FROM space_star WHERE workspace_id = ?1',
  },
  {
    table: 'invitation',
    sql: 'SELECT * FROM invitation WHERE workspace_id = ?1',
    drop: ['token_hash'],
  },
  {
    table: 'ai_settings',
    sql: 'SELECT * FROM ai_settings WHERE workspace_id = ?1',
    drop: ['api_key_encrypted'],
  },
  {
    table: 'ai_usage_log',
    sql: 'SELECT * FROM ai_usage_log WHERE workspace_id = ?1',
  },
  {
    table: 'daily_report',
    sql: 'SELECT * FROM daily_report WHERE workspace_id = ?1',
    drop: ['slack_webhook_url'],
  },
  {
    table: 'daily_report_run',
    sql: 'SELECT * FROM daily_report_run WHERE workspace_id = ?1',
  },
]

/**
 * Tables deliberately left out, each with its reason. Instance-wide tables
 * belong to no workspace. The rest are credentials or bookkeeping.
 */
export const NOT_EXPORTED: Record<string, string> = {
  schema_state: 'instance',
  instance_job: 'instance',
  ai_price_list: 'instance',
  link_preview: 'instance cache',
  oauth_client: 'instance',
  fts: 'search index, rebuilt from the rows',
  auth_token: 'credentials',
  oauth_code: 'credentials',
  oauth_token: 'credentials',
  otp_challenge: 'credentials',
  ingest_token: 'credentials',
  op_log: 'idempotency records',
  email_quota: 'bookkeeping',
  notification: 'one person inbox',
  workspace_export: 'the exports themselves',
}

function jsonl(rows: Record<string, unknown>[], drop: string[] = []): string {
  return rows
    .map((row) => {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(row))
        if (!drop.includes(k)) out[k] = v
      return JSON.stringify(out)
    })
    .join('\n')
}

/** A file name a zip and every filesystem will take. */
function safeName(name: string): string {
  const cleaned = [...name]
    .map((ch) =>
      ch.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(ch) ? '_' : ch,
    )
    .join('')
    .trim()
  return cleaned.slice(0, 120) || 'file'
}

export interface IExportRow {
  id: string
  status: 'pending' | 'running' | 'ready' | 'failed'
  size: number | null
  skipped_files: number
  error: string | null
  ready_at: number | null
  expires_at: number | null
  created_at: number
  requested_by: string
}

/** Ask for an export. Admin only (checked by the route). One at a time. */
export async function exportRequest(ctx: ICtx): Promise<IExportRow> {
  const open = await ctx.db.query<{ id: string }>(
    `SELECT id FROM workspace_export
      WHERE workspace_id = ? AND status IN ('pending', 'running')`,
    [ctx.workspaceId],
  )
  if (open.length > 0)
    throw new ApiError(409, 'an export of this workspace is already being made')
  const id = newId('exp')
  const ts = now()
  await ctx.db.run(
    `INSERT INTO workspace_export (id, workspace_id, requested_by, status, created_at)
     VALUES (?, ?, ?, 'pending', ?)`,
    [id, ctx.workspaceId, ctx.actor.onBehalfOf ?? ctx.actor.id, ts],
  )
  return (await exportList(ctx)).find((e) => e.id === id)!
}

export async function exportList(ctx: ICtx): Promise<IExportRow[]> {
  return ctx.db.query<IExportRow>(
    `SELECT id, status, size, skipped_files, error, ready_at, expires_at, created_at, requested_by
       FROM workspace_export WHERE workspace_id = ?
      ORDER BY created_at DESC LIMIT 10`,
    [ctx.workspaceId],
  )
}

/** Build the zip for one workspace, as `viewer` would see it. */
export async function buildWorkspaceZip(
  db: ISqlDriver,
  store: AttachmentStore,
  workspaceId: string,
  viewer: string,
  nowMs: number,
): Promise<{ zip: Uint8Array; skipped: number }> {
  const ctx: ICtx = {
    db,
    workspaceId,
    actor: { id: viewer, kind: 'human', handle: '', role: 'admin', scopes: [] },
  }
  const hidden = JSON.stringify(await hiddenDocIds(ctx))
  const encoder = new TextEncoder()
  const entries: IZipEntry[] = []

  for (const t of EXPORTED) {
    const rows = await db.query<Record<string, unknown>>(
      t.sql,
      paramsFor(t.sql, [workspaceId, hidden, viewer]),
    )
    entries.push({
      name: `tables/${t.table}.jsonl`,
      data: encoder.encode(jsonl(rows, t.drop)),
    })
  }

  const docs = await db.query<{ slug: string; title: string; body: string }>(
    `SELECT slug, title, body FROM document
      WHERE workspace_id = ?1 AND ${VISIBLE('id')} ORDER BY slug`,
    [workspaceId, hidden],
  )
  for (const d of docs) {
    entries.push({
      name: `docs/${safeName(d.slug)}.md`,
      data: encoder.encode(`# ${d.title}\n\n${d.body}\n`),
    })
  }

  const files = await db.query<{
    id: string
    filename: string
    size: number | null
  }>(
    `SELECT id, filename, size FROM attachment
      WHERE workspace_id = ?1 AND kind = 'file'
        AND NOT (owner_kind = 'doc' AND ${HIDDEN('owner_id')})
      ORDER BY created_at`,
    [workspaceId, hidden],
  )
  let total = 0
  const left: string[] = []
  for (const f of files) {
    if (total + (f.size ?? 0) > MAX_FILE_BYTES) {
      left.push(`${f.id}  ${f.filename}`)
      continue
    }
    const bytes = await store.read(f.id)
    if (!bytes) {
      left.push(`${f.id}  ${f.filename}  (content missing)`)
      continue
    }
    total += bytes.length
    entries.push({
      name: `attachments/${f.id}-${safeName(f.filename)}`,
      data: bytes,
    })
  }

  const readme = [
    'Acta workspace export',
    `Made ${new Date(nowMs).toISOString()}.`,
    '',
    'tables/   every table as JSON Lines, one row per line',
    'docs/     every page as Markdown',
    'attachments/   uploaded files, named <id>-<filename>',
    '',
    'Left out on purpose: sign-in tokens, OAuth grants, webhook and connection',
    'secrets, the AI provider key, and other people private pages.',
    ...(left.length > 0
      ? [
          '',
          `${left.length} files were not included, because the export holds at most`,
          `${MAX_FILE_BYTES / (1024 * 1024)} MB of files. They are still in the workspace:`,
          ...left,
        ]
      : []),
    '',
  ].join('\n')
  entries.unshift({ name: 'README.txt', data: encoder.encode(readme) })
  return { zip: buildZip(entries, nowMs), skipped: left.length }
}

export interface IExportDeps {
  store: AttachmentStore
  send?: TEmailSender
  baseUrl?: string
  nowMs?: number
}

/**
 * Make the oldest waiting export, if any. Claimed first, so the deferred
 * task and the cron never both build the same one. True when one was made.
 */
export async function runPendingExport(
  db: ISqlDriver,
  deps: IExportDeps,
): Promise<boolean> {
  const ts = deps.nowMs ?? now()
  const next = (
    await db.query<{ id: string }>(
      `SELECT id FROM workspace_export
        WHERE status = 'pending' OR (status = 'running' AND claimed_at < ?)
        ORDER BY created_at LIMIT 1`,
      [ts - STALE_CLAIM_MS],
    )
  )[0]
  if (!next) return false
  await db.run(
    `UPDATE workspace_export SET status = 'running', claimed_at = ?
      WHERE id = ? AND (status = 'pending' OR (status = 'running' AND claimed_at < ?))`,
    [ts, next.id, ts - STALE_CLAIM_MS],
  )
  const row = (
    await db.query<{
      id: string
      workspace_id: string
      requested_by: string
      status: string
      claimed_at: number
    }>(
      'SELECT id, workspace_id, requested_by, status, claimed_at FROM workspace_export WHERE id = ?',
      [next.id],
    )
  )[0]
  // Somebody else claimed it between the two statements.
  if (!row || row.status !== 'running' || row.claimed_at !== ts) return false

  try {
    const { zip, skipped } = await buildWorkspaceZip(
      db,
      deps.store,
      row.workspace_id,
      row.requested_by,
      ts,
    )
    await deps.store.write(row.id, zip)
    const token = randomToken()
    const expiresAt = ts + LINK_DAYS * DAY_MS
    await db.run(
      `UPDATE workspace_export
          SET status = 'ready', token_hash = ?, size = ?, skipped_files = ?,
              ready_at = ?, expires_at = ?, error = NULL
        WHERE id = ?`,
      [await sha256Hex(token), zip.length, skipped, ts, expiresAt, row.id],
    )
    await announceReady(db, deps, row, token)
    return true
  } catch (err) {
    console.error('workspace export failed', row.id, err)
    await db.run(
      "UPDATE workspace_export SET status = 'failed', error = ? WHERE id = ?",
      [err instanceof Error ? err.message : String(err), row.id],
    )
    return false
  }
}

/**
 * Tell the admin who asked: in the bell, and by email when this instance
 * sends email and their address is confirmed. The emailed link carries the
 * token. The bell's does not need to, because Settings downloads it through
 * the signed-in session.
 */
async function announceReady(
  db: ISqlDriver,
  deps: IExportDeps,
  row: { id: string; workspace_id: string; requested_by: string },
  token: string,
): Promise<void> {
  const ws = (
    await db.query<{ name: string }>(
      'SELECT name FROM workspace WHERE id = ?',
      [row.workspace_id],
    )
  )[0]
  const system = (
    await db.query<{ id: string; handle: string }>(
      "SELECT id, handle FROM actor WHERE workspace_id = ? AND kind = 'system' LIMIT 1",
      [row.workspace_id],
    )
  )[0]
  if (system) {
    const ctx: ICtx = {
      db,
      workspaceId: row.workspace_id,
      actor: {
        id: system.id,
        kind: 'system',
        handle: system.handle,
        role: 'member',
        scopes: ['read', 'write'],
      },
    }
    await emitEvent(
      ctx,
      'workspace.export_ready',
      'workspace',
      row.workspace_id,
      `The export of ${ws?.name ?? 'this workspace'} is ready. Download it from Settings, Workspace within ${LINK_DAYS} days.`,
      { export_id: row.id },
      { to: [{ actorId: row.requested_by, reason: 'involved' }] },
    )
    flushPendingEvents()
  }

  if (!deps.send || !deps.baseUrl) return
  const person = (
    await db.query<{ email: string | null; email_confirmed_at: number | null }>(
      'SELECT email, email_confirmed_at FROM actor WHERE id = ?',
      [row.requested_by],
    )
  )[0]
  if (!person?.email || person.email_confirmed_at === null) return
  const url = `${deps.baseUrl.replace(/\/$/, '')}/api/v1/exports/${row.id}?token=${token}`
  const mail = exportReadyEmail({
    workspace: ws?.name ?? 'Your workspace',
    downloadUrl: url,
    expiresInDays: LINK_DAYS,
  })
  try {
    await deps.send({ to: person.email, ...mail })
  } catch (err) {
    // The bell already has it, and Settings can download it.
    console.error('export email failed', row.id, err)
  }
}

/** The zip behind an emailed link, or null for anything not exactly right. */
export async function exportByToken(
  db: ISqlDriver,
  store: AttachmentStore,
  id: string,
  token: string,
  nowMs = now(),
): Promise<{ bytes: Uint8Array; filename: string } | null> {
  const row = (
    await db.query<{
      token_hash: string | null
      expires_at: number | null
      status: string
      slug: string | null
    }>(
      `SELECT e.token_hash, e.expires_at, e.status, w.slug FROM workspace_export e
         JOIN workspace w ON w.id = e.workspace_id WHERE e.id = ?`,
      [id],
    )
  )[0]
  if (!row || row.status !== 'ready' || !row.token_hash) return null
  if (row.expires_at === null || row.expires_at < nowMs) return null
  if ((await sha256Hex(token)) !== row.token_hash) return null
  const bytes = await store.read(id)
  if (!bytes) return null
  return { bytes, filename: exportFilename(row.slug, id) }
}

/** The zip, for a signed-in admin of its workspace. */
export async function exportForAdmin(
  ctx: ICtx,
  store: AttachmentStore,
  id: string,
): Promise<{ bytes: Uint8Array; filename: string }> {
  const row = (
    await ctx.db.query<{
      status: string
      expires_at: number | null
      slug: string | null
    }>(
      `SELECT e.status, e.expires_at, w.slug FROM workspace_export e
         JOIN workspace w ON w.id = e.workspace_id
        WHERE e.id = ? AND e.workspace_id = ?`,
      [id, ctx.workspaceId],
    )
  )[0]
  if (!row || row.status !== 'ready' || (row.expires_at ?? 0) < now())
    throw new ApiError(404, 'export not found')
  const bytes = await store.read(id)
  if (!bytes) throw new ApiError(404, 'export not found')
  return { bytes, filename: exportFilename(row.slug, id) }
}

function exportFilename(slug: string | null, id: string): string {
  return `acta-${safeName(slug ?? 'workspace')}-${id}.zip`
}

/** Exports past their link's life: the zip and the row both go. */
export async function pruneExpiredExports(
  db: ISqlDriver,
  store: AttachmentStore,
  budget: IBudget,
  nowMs = now(),
): Promise<boolean> {
  const rows = await db.query<{ id: string }>(
    `SELECT id FROM workspace_export
      WHERE (status = 'ready' AND expires_at < ?)
         OR (status = 'failed' AND created_at < ?)
      LIMIT ${BATCH}`,
    [nowMs, nowMs - LINK_DAYS * DAY_MS],
  )
  budget.left -= 1
  for (const r of rows) await store.remove(r.id)
  return deleteInBatches(
    db,
    budget,
    'workspace_export',
    'SELECT rowid AS id FROM workspace_export WHERE id IN (SELECT value FROM json_each(?))',
    [JSON.stringify(rows.map((r) => r.id))],
  )
}
