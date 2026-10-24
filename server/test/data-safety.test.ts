/**
 * Data safety on a shared database (LA-401): retention, the size alert,
 * per-workspace export, workspace deletion and account erasure.
 *
 * The purge test fills one row into every table a workspace can own, through
 * the services where that is natural and directly otherwise, and runs with
 * foreign keys enforced (the bun driver turns them on). So it fails if a table
 * is added without a place in the purge order, if the order breaks a foreign
 * key, or if a purge reaches into another workspace.
 */

import { beforeEach, describe, expect, it } from 'bun:test'
import { newId, zDocWrite, zGoalWrite, zItemWrite } from '@nubisco/acta-shared'
import { createApp } from '../src/app'
import { bootstrapWorkspace } from '../src/core/bootstrap'
import { createToken, sha256Hex } from '../src/core/auth'
import type { ICtx } from '../src/core/ctx'
import type { IEmail } from '../src/core/email'
import { buildZip, crc32 } from '../src/core/zip'
import { openDb, type BunSqliteDriver } from '../src/db'
import {
  AttachmentStore,
  attachmentAdd,
  type IBlobStore,
} from '../src/services/attachments'
import { docWrite } from '../src/services/docs'
import { goalWrite } from '../src/services/goals'
import { itemWrite } from '../src/services/items'
import { spaceWrite } from '../src/services/spaces'
import { KEEP_DOC_VERSIONS, retentionSweep } from '../src/services/retention'
import { storageAlert } from '../src/services/storageAlert'
import {
  EXPORTED,
  NOT_EXPORTED,
  exportByToken,
  exportRequest,
  pruneExpiredExports,
  runPendingExport,
} from '../src/services/workspaceExport'
import {
  INSTANCE_TABLES,
  PURGE_ORDER,
  anonymiseAccount,
  cancelDeletion,
  purgeWorkspace,
  scheduleDeletion,
} from '../src/services/workspaceDeletion'

const DAY = 24 * 60 * 60 * 1000

let db: BunSqliteDriver
let blobs: Map<string, Uint8Array>
let store: AttachmentStore
let a: ICtx
let b: ICtx

function memoryBlobs(): IBlobStore {
  return {
    put: (id, bytes) => {
      blobs.set(id, bytes)
      return Promise.resolve()
    },
    get: (id) => Promise.resolve(blobs.get(id) ?? null),
    delete: (id) => {
      blobs.delete(id)
      return Promise.resolve()
    },
  }
}

function adminCtx(workspaceId: string, actorId: string, handle: string): ICtx {
  return {
    db,
    workspaceId,
    actor: {
      id: actorId,
      kind: 'human',
      handle,
      role: 'admin',
      scopes: ['read', 'write', 'admin'],
    },
  }
}

/** A second workspace, made after the first, with an admin and a system actor. */
async function addWorkspace(slug: string): Promise<ICtx> {
  const id = newId('ws')
  const admin = newId('act')
  const ts = Date.now() + 1000
  await db.run(
    'INSERT INTO workspace (id, name, slug, created_at) VALUES (?, ?, ?, ?)',
    [id, slug.toUpperCase(), slug, ts],
  )
  await db.run(
    `INSERT INTO actor (id, workspace_id, kind, handle, name, email, role, platform_user_id, email_confirmed_at, created_at)
     VALUES (?, ?, 'human', 'boss', 'Boss', ?, 'admin', 'usr_shared', ?, ?)`,
    [admin, id, `boss@${slug}.test`, ts, ts],
  )
  await db.run(
    `INSERT INTO actor (id, workspace_id, kind, handle, name, role, created_at)
     VALUES (?, ?, 'system', 'acta', 'Acta', 'member', ?)`,
    [newId('act'), id, ts],
  )
  return adminCtx(id, admin, 'boss')
}

/**
 * Insert a row, filling every NOT NULL column without a default that
 * `values` does not name with something its type accepts.
 */
async function insertRow(
  table: string,
  values: Record<string, unknown>,
): Promise<void> {
  const cols = await db.query<{
    name: string
    type: string
    notnull: number
    dflt_value: unknown
    pk: number
  }>(`PRAGMA table_info(${table})`)
  const row: Record<string, unknown> = {}
  for (const c of cols) {
    if (c.name in values) row[c.name] = values[c.name]
    else if (c.notnull && c.dflt_value === null)
      row[c.name] = /INT|REAL/i.test(c.type)
        ? 1
        : `${table}-${c.name}-${Math.random().toString(36).slice(2, 8)}`
  }
  const names = Object.keys(row)
  await db.run(
    `INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`,
    names.map((n) => row[n]),
  )
}

/** Something in every table a workspace owns. */
async function populate(ctx: ICtx, space: string): Promise<void> {
  const ws = ctx.workspaceId
  const me = ctx.actor.id
  await spaceWrite(ctx, [
    {
      op: 'create',
      op_id: `${space}-s`,
      key: space,
      name: space,
      template: 'kanban6',
    },
  ] as never)
  await itemWrite(
    ctx,
    itemOps([
      { op: 'create', op_id: `${space}-1`, list: 'To Do', title: 'One' },
      { op: 'create', op_id: `${space}-2`, list: 'To Do', title: 'Two' },
      {
        op: 'depends_on',
        op_id: `${space}-d`,
        key: `${space}-2`,
        blocker: `${space}-1`,
      },
      {
        op: 'set_parent',
        op_id: `${space}-p`,
        key: `${space}-2`,
        parent: `${space}-1`,
      },
      {
        op: 'assign',
        op_id: `${space}-a`,
        key: `${space}-1`,
        add: [ctx.actor.handle],
      },
      {
        op: 'comment',
        op_id: `${space}-c`,
        key: `${space}-1`,
        body: `see ${space}-2`,
      },
    ]),
    space,
  )
  const item = (
    await db.query<{ id: string; space_id: string; list_id: string }>(
      'SELECT id, space_id, list_id FROM item WHERE workspace_id = ? ORDER BY key LIMIT 1',
      [ws],
    )
  )[0]
  await docWrite(
    ctx,
    docOps([
      {
        op: 'create',
        op_id: `${space}-doc`,
        slug: `${space.toLowerCase()}-page`,
        title: 'Page',
        body: 'v1',
      },
      {
        op: 'comment',
        op_id: `${space}-dc`,
        ref: `${space.toLowerCase()}-page`,
        body: 'a note',
      },
    ]),
  )
  const doc = (
    await db.query<{ id: string }>(
      'SELECT id FROM document WHERE workspace_id = ?',
      [ws],
    )
  )[0]
  await insertRow('doc_version', {
    document_id: doc.id,
    rev: 99,
    actor_id: me,
    created_at: Date.now(),
  })
  await goalWrite(
    ctx,
    goalOps([
      {
        op: 'create',
        op_id: `${space}-g`,
        title: 'Goal',
        items: [`${space}-1`],
        followers: [ctx.actor.handle],
      },
    ]),
  )
  const goal = (
    await db.query<{ id: string }>(
      'SELECT id FROM goal WHERE workspace_id = ?',
      [ws],
    )
  )[0]
  await insertRow('goal_update', {
    id: newId('gup'),
    workspace_id: ws,
    goal_id: goal.id,
    actor_id: me,
    status: 'on_track',
    created_at: Date.now(),
  })
  await insertRow('goal_follower', {
    goal_id: goal.id,
    actor_id: me,
    created_at: Date.now(),
  }).catch(() => undefined)
  await attachmentAdd(ctx, store, {
    item: `${space}-1`,
    filename: 'note.txt',
    content_base64: btoa(`file of ${space}`),
  } as never)
  const group = newId('lgr')
  await insertRow('label_group', {
    id: group,
    workspace_id: ws,
    space_id: item.space_id,
    name: 'G',
  })
  const label = newId('lbl')
  await insertRow('label', {
    id: label,
    workspace_id: ws,
    group_id: group,
    name: 'L',
    color: 'red',
  })
  await insertRow('item_label', { item_id: item.id, label_id: label })
  const checklist = newId('chk')
  await insertRow('checklist', {
    id: checklist,
    workspace_id: ws,
    item_id: item.id,
    name: 'C',
    pos: 1,
  })
  await insertRow('checklist_item', {
    id: newId('chk'),
    checklist_id: checklist,
    text: 'x',
    done: 0,
    pos: 1,
  })
  await insertRow('item_key_alias', {
    workspace_id: ws,
    key: `OLD${space}-1`,
    item_id: item.id,
  })
  await insertRow('external_link', {
    workspace_id: ws,
    provider: 'github',
    external_id: `${space}-x`,
    item_id: item.id,
    url: 'https://example.com',
    created_at: 1,
  })
  await insertRow('link', {
    workspace_id: ws,
    src_kind: 'item',
    src_id: item.id,
    ref_type: 'item',
    target: `${space}-2`,
  })
  await insertRow('space_star', {
    workspace_id: ws,
    actor_id: me,
    space_id: item.space_id,
    created_at: 1,
  })
  const hook = newId('whk')
  await insertRow('webhook', {
    id: hook,
    workspace_id: ws,
    url: 'https://example.com/h',
    events: '*',
    secret: `hook-secret-${space}`,
    created_at: 1,
  })
  await insertRow('webhook_delivery', {
    id: newId('whk'),
    webhook_id: hook,
    event: 'x',
    created_at: 1,
  })
  await insertRow('rule', {
    id: newId('rul'),
    workspace_id: ws,
    name: 'R',
    trigger: 'item.created',
    action: '{}',
    created_at: 1,
  })
  await insertRow('connection', {
    id: newId('con'),
    workspace_id: ws,
    provider: 'github',
    name: 'C',
    secret: `conn-secret-${space}`,
    actor_id: me,
    space_id: item.space_id,
    list_id: item.list_id,
    created_at: 1,
  })
  await insertRow('ingest_token', {
    id: newId('act'),
    workspace_id: ws,
    token_hash: `ingest-${space}`,
    actor_id: me,
    space_id: item.space_id,
    created_at: 1,
  })
  await createToken(db, ws, me, 'session', ['read'])
  const client = `oac_${space}`
  await insertRow('oauth_client', {
    id: client,
    name: 'App',
    redirect_uris: '[]',
    created_at: 1,
  })
  await insertRow('oauth_code', {
    code_hash: `code-${space}`,
    workspace_id: ws,
    client_id: client,
    actor_id: me,
    created_at: 1,
  })
  await insertRow('oauth_token', {
    id: newId('oat'),
    workspace_id: ws,
    client_id: client,
    actor_id: me,
    created_at: 1,
  })
  await insertRow('invitation', {
    id: newId('inv'),
    workspace_id: ws,
    email: `new@${space}.test`,
    role: 'member',
    token_hash: `inv-${space}`,
    invited_by: me,
    created_at: 1,
  })
  await insertRow('otp_challenge', {
    id: newId('act'),
    workspace_id: ws,
    email: `x@${space}.test`,
    created_at: 1,
  })
  await insertRow('email_quota', {
    workspace_id: ws,
    day: '2026-10-24',
    kind: 'invite',
    count: 1,
  })
  await insertRow('ai_settings', {
    workspace_id: ws,
    provider: 'anthropic',
    api_key_encrypted: `ai-key-${space}`,
    updated_at: 1,
  })
  await insertRow('ai_usage_log', {
    workspace_id: ws,
    source: 'x',
    provider: 'anthropic',
    model: 'm',
    created_at: 1,
  })
  await insertRow('daily_report', {
    workspace_id: ws,
    slack_webhook_url: `https://hooks.slack.test/${space}`,
    updated_at: 1,
  })
  await insertRow('daily_report_run', {
    id: newId('drr'),
    workspace_id: ws,
    run_date: '2026-10-24',
    status: 'posted',
    created_at: 1,
  })
  await insertRow('workspace_export', {
    id: newId('exp'),
    workspace_id: ws,
    requested_by: me,
    status: 'failed',
    created_at: 1,
  })
  // A notification for someone else, so the mention path made at least one.
  const evt = (
    await db.query<{ id: string }>(
      'SELECT id FROM event WHERE workspace_id = ? LIMIT 1',
      [ws],
    )
  )[0]
  await insertRow('notification', {
    id: newId('ntf'),
    workspace_id: ws,
    actor_id: me,
    event_id: evt.id,
    reason: 'mention',
    verb: 'comment.created',
    summary: 's',
    created_at: 1,
  })
}

const docOps = (ops: unknown[]) => zDocWrite.parse({ ops }).ops
const goalOps = (ops: unknown[]) => zGoalWrite.parse({ ops }).ops
const itemOps = (ops: unknown[]) => zItemWrite.parse({ ops }).ops

async function countFor(select: string, workspaceId: string): Promise<number> {
  return (
    await db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM (${select})`, [
      workspaceId,
    ])
  )[0].n
}

async function allTables(): Promise<string[]> {
  const rows = await db.query<{ name: string; sql: string | null }>(
    "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
  )
  // The FTS shadow tables belong to the fts table.
  return rows
    .map((r) => r.name)
    .filter((n) => !/^fts_(config|content|data|docsize|idx)$/.test(n))
}

beforeEach(async () => {
  db = await openDb(':memory:')
  blobs = new Map()
  store = new AttachmentStore(memoryBlobs())
  const ws = await bootstrapWorkspace(db, {
    adminEmail: 'jose@nubisco.io',
    adminHandle: 'jose',
  })
  const me = (
    await db.query<{ id: string }>("SELECT id FROM actor WHERE handle = 'jose'")
  )[0].id
  await db.run(
    "UPDATE actor SET email_confirmed_at = 1, platform_user_id = 'usr_jose' WHERE id = ?",
    [me],
  )
  a = adminCtx(ws, me, 'jose')
  b = await addWorkspace('beta')
})

describe('every table has a place', () => {
  it('in the purge order or among the instance tables', async () => {
    const known = new Set([
      ...PURGE_ORDER.map(([t]) => t),
      ...INSTANCE_TABLES,
      'fts',
    ])
    expect((await allTables()).filter((t) => !known.has(t))).toEqual([])
  })

  it('in the export or deliberately out of it', async () => {
    const known = new Set([
      ...EXPORTED.map((t) => t.table),
      ...Object.keys(NOT_EXPORTED),
    ])
    expect((await allTables()).filter((t) => !known.has(t))).toEqual([])
  })
})

describe('retention', () => {
  const T = Date.parse('2026-10-24T12:00:00Z')

  async function event(workspaceId: string, ts: number): Promise<string> {
    const id = newId('evt', ts)
    const actor = (
      await db.query<{ id: string }>(
        "SELECT id FROM actor WHERE workspace_id = ? AND kind = 'system'",
        [workspaceId],
      )
    )[0].id
    await db.run(
      `INSERT INTO event (id, workspace_id, ts, actor_id, actor_kind, verb, entity, entity_id, summary)
       VALUES (?, ?, ?, ?, 'system', 'item.updated', 'item', 'x', 's')`,
      [id, workspaceId, ts, actor],
    )
    return id
  }

  it('drops activity past the window with its notifications, and keeps the rest', async () => {
    const old = await event(a.workspaceId, T - 91 * DAY)
    const recent = await event(a.workspaceId, T - 10 * DAY)
    await insertRow('notification', {
      id: newId('ntf'),
      workspace_id: a.workspaceId,
      actor_id: a.actor.id,
      event_id: old,
      reason: 'mention',
      verb: 'x',
      summary: 's',
      created_at: T - 91 * DAY,
    })
    const res = await retentionSweep(db, { nowMs: T, force: true })
    expect(res).toEqual({ ran: true, finished: true })
    const ids = (await db.query<{ id: string }>('SELECT id FROM event')).map(
      (r) => r.id,
    )
    expect(ids).not.toContain(old)
    expect(ids).toContain(recent)
    expect(
      (await db.query('SELECT 1 FROM notification WHERE event_id = ?', [old]))
        .length,
    ).toBe(0)
  })

  it('keeps due-date records while their card exists, and drops other old op records', async () => {
    await populate(a, 'QQ')
    const item = (
      await db.query<{ id: string }>('SELECT id FROM item LIMIT 1')
    )[0].id
    const old = T - 31 * DAY
    for (const opId of [
      `due:${item}:1:item.overdue`,
      'due:itm_gone:1:item.overdue',
      'web:old',
    ]) {
      await db.run(
        'INSERT INTO op_log (workspace_id, op_id, result, created_at) VALUES (?, ?, ?, ?)',
        [a.workspaceId, opId, '{}', old],
      )
    }
    await retentionSweep(db, { nowMs: T, force: true })
    const left = (
      await db.query<{ op_id: string }>(
        'SELECT op_id FROM op_log WHERE created_at = ?',
        [old],
      )
    ).map((r) => r.op_id)
    expect(left).toEqual([`due:${item}:1:item.overdue`])
  })

  it('thins page history to the newest versions plus one a day', async () => {
    await docWrite(
      a,
      docOps([
        { op: 'create', op_id: 'd', slug: 'hist', title: 'Hist', body: 'x' },
      ]),
    )
    const doc = (
      await db.query<{ id: string }>(
        "SELECT id FROM document WHERE slug = 'hist'",
      )
    )[0].id
    await db.run('DELETE FROM doc_version WHERE document_id = ?', [doc])
    // 40 versions: four a day over ten days, oldest first.
    for (let i = 0; i < 40; i++) {
      await insertRow('doc_version', {
        id: newId('doc'),
        document_id: doc,
        rev: i + 1,
        body: `${i}`,
        title: 't',
        actor_id: a.actor.id,
        created_at: T - 10 * DAY + Math.floor(i / 4) * DAY + (i % 4) * 1000,
      })
    }
    await retentionSweep(db, { nowMs: T, force: true })
    const revs = (
      await db.query<{ rev: number }>(
        'SELECT rev FROM doc_version WHERE document_id = ? ORDER BY rev',
        [doc],
      )
    ).map((r) => r.rev)
    // The newest 20 (21 to 40), and the last of each of the five older days.
    expect(revs).toEqual([
      4,
      8,
      12,
      16,
      20,
      ...Array.from({ length: KEEP_DOC_VERSIONS }, (_, i) => 21 + i),
    ])
  })

  it('runs once a day, and carries on next tick when the budget runs out', async () => {
    for (let i = 0; i < 3; i++) await event(a.workspaceId, T - 100 * DAY)
    const first = await retentionSweep(db, { nowMs: T, budget: { left: 1 } })
    expect(first).toEqual({ ran: true, finished: false })
    const second = await retentionSweep(db, { nowMs: T + 1000 })
    expect(second).toEqual({ ran: true, finished: true })
    expect(await retentionSweep(db, { nowMs: T + 2000 })).toEqual({
      ran: false,
      finished: true,
    })
  })
})

describe('the size alert', () => {
  const T = Date.parse('2026-10-24T12:00:00Z')

  it('stays quiet under the threshold', async () => {
    expect(
      await storageAlert(db, {
        nowMs: T,
        sizeBytes: 1024,
        thresholdBytes: 2048,
      }),
    ).toBe(false)
  })

  it('tells the operator workspace admins once a day', async () => {
    expect(
      await storageAlert(db, {
        nowMs: T,
        sizeBytes: 4096,
        thresholdBytes: 2048,
      }),
    ).toBe(true)
    expect(
      await storageAlert(db, {
        nowMs: T + 60_000,
        sizeBytes: 4096,
        thresholdBytes: 2048,
      }),
    ).toBe(false)
    expect(
      await storageAlert(db, {
        nowMs: T + DAY,
        sizeBytes: 4096,
        thresholdBytes: 2048,
      }),
    ).toBe(true)
    const notes = await db.query<{
      actor_id: string
      workspace_id: string
      verb: string
    }>(
      "SELECT actor_id, workspace_id, verb FROM notification WHERE verb = 'instance.storage_high'",
    )
    expect(notes.length).toBe(2)
    expect(
      notes.every(
        (n) => n.actor_id === a.actor.id && n.workspace_id === a.workspaceId,
      ),
    ).toBe(true)
  })

  it('reads the size from the driver', async () => {
    expect(await db.sizeBytes()).toBeGreaterThan(0)
  })
})

/** The entries of a stored zip, read back independently of the writer. */
function unzip(zip: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
  const out = new Map<string, Uint8Array>()
  let at = 0
  while (view.getUint32(at, true) === 0x04034b50) {
    const crc = view.getUint32(at + 14, true)
    const size = view.getUint32(at + 18, true)
    const nameLen = view.getUint16(at + 26, true)
    const name = new TextDecoder().decode(
      zip.subarray(at + 30, at + 30 + nameLen),
    )
    const data = zip.subarray(at + 30 + nameLen, at + 30 + nameLen + size)
    expect(crc32(data)).toBe(crc)
    out.set(name, data)
    at += 30 + nameLen + size
  }
  return out
}

describe('export', () => {
  it('writes a zip any reader can open', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926)
    const zip = buildZip(
      [{ name: 'a/é.txt', data: new TextEncoder().encode('hi') }],
      Date.now(),
    )
    expect([...unzip(zip).keys()]).toEqual(['a/é.txt'])
  })

  it('holds the workspace, its pages and files, and nobody else private page or any secret', async () => {
    await populate(b, 'BB')
    // A page the admin cannot see: private to another member.
    const other = newId('act')
    await db.run(
      `INSERT INTO actor (id, workspace_id, kind, handle, name, role, created_at) VALUES (?, ?, 'human', 'other', 'Other', 'member', 1)`,
      [other, b.workspaceId],
    )
    await docWrite(
      {
        ...b,
        actor: { ...b.actor, id: other, handle: 'other', role: 'member' },
      },
      docOps([
        {
          op: 'create',
          op_id: 'secret-page',
          slug: 'their-diary',
          title: 'Diary',
          body: 'private words',
        },
      ]),
    )
    await db.run(
      "UPDATE document SET visibility = 'private', owner_id = ? WHERE slug = 'their-diary'",
      [other],
    )

    const mail: IEmail[] = []
    await exportRequest(b)
    expect(
      await runPendingExport(db, {
        store,
        send: async (m) => void mail.push(m),
        baseUrl: 'https://acta.test',
      }),
    ).toBe(true)
    const row = (
      await db.query<{ id: string; status: string }>(
        'SELECT id, status FROM workspace_export WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 1',
        [b.workspaceId],
      )
    )[0]
    expect(row.status).toBe('ready')
    const files = unzip(blobs.get(row.id)!)
    const all = [...files.values()]
      .map((d) => new TextDecoder().decode(d))
      .join('\n')

    expect(files.has('README.txt')).toBe(true)
    expect(files.has('docs/bb-page.md')).toBe(true)
    expect(
      [...files.keys()].some(
        (k) => k.startsWith('attachments/') && k.endsWith('note.txt'),
      ),
    ).toBe(true)
    expect(
      new TextDecoder().decode(files.get('tables/item.jsonl')!).split('\n')
        .length,
    ).toBe(2)
    expect(all).not.toContain('their-diary')
    expect(all).not.toContain('private words')
    for (const secret of [
      'hook-secret-BB',
      'conn-secret-BB',
      'ai-key-BB',
      'hooks.slack.test',
      'inv-BB',
    ])
      expect(all).not.toContain(secret)
    // Nothing from the other workspace.
    expect(all).not.toContain(a.workspaceId)

    // Emailed to the admin who asked, with a working link.
    expect(mail.length).toBe(1)
    expect(mail[0].to).toBe('boss@beta.test')
    expect(mail[0].text).toContain('https://acta.test/api/v1/exports/')
    const token = /token=([a-f0-9]+)/i.exec(mail[0].text)?.[1] ?? ''
    expect(
      (await exportByToken(db, store, row.id, token))?.bytes.length,
    ).toBeGreaterThan(0)
    expect(await exportByToken(db, store, row.id, 'wrong')).toBeNull()
    expect(
      await exportByToken(db, store, row.id, token, Date.now() + 8 * DAY),
    ).toBeNull()

    // After the link's life, the zip and its row both go.
    await pruneExpiredExports(db, store, { left: 50 }, Date.now() + 8 * DAY)
    expect(blobs.has(row.id)).toBe(false)
  })

  it('makes one at a time', async () => {
    await exportRequest(b)
    expect(exportRequest(b)).rejects.toThrow('already')
  })
})

describe('deleting a workspace', () => {
  it('needs the address typed, and never takes the operator workspace', async () => {
    expect(scheduleDeletion(b, 'nope')).rejects.toThrow('beta')
    expect(
      scheduleDeletion(
        a,
        (
          await db.query<{ slug: string }>(
            'SELECT slug FROM workspace WHERE id = ?',
            [a.workspaceId],
          )
        )[0].slug,
      ),
    ).rejects.toThrow('runs this instance')
    const status = await scheduleDeletion(b, 'beta')
    expect(status.purge_at - status.deleted_at).toBe(30 * DAY)
    await cancelDeletion(b)
    expect(
      (
        await db.query<{ purge_at: number | null }>(
          'SELECT purge_at FROM workspace WHERE id = ?',
          [b.workspaceId],
        )
      )[0].purge_at,
    ).toBeNull()
  })

  it('is read-only while it waits: reads, export and cancel only', async () => {
    const app = await createApp(db, { blobStore: memoryBlobs() })
    const token = await createToken(db, b.workspaceId, b.actor.id, 'session', [
      'read',
      'write',
      'admin',
    ])
    const call = (method: string, path: string, body?: unknown) =>
      app.request(`/api/v1/w/beta${path}`, {
        method,
        headers: {
          cookie: `acta_session=${token}`,
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    expect(
      (await call('POST', '/workspace/deletion', { confirm: 'beta' })).status,
    ).toBe(200)
    expect((await call('GET', '/overview')).status).toBe(200)
    expect(
      (
        (await (await call('GET', '/overview')).json()) as {
          deletion: { purge_at: number }
        }
      ).deletion.purge_at,
    ).toBeGreaterThan(Date.now())
    const write = await call('POST', '/spaces', {
      ops: [{ op: 'create', op_id: 'x', key: 'NEW', name: 'New' }],
    })
    expect(write.status).toBe(403)
    expect((await call('POST', '/workspace/exports')).status).toBe(202)
    expect((await call('DELETE', '/workspace/deletion')).status).toBe(200)
    expect(
      (
        await call('POST', '/spaces', {
          ops: [{ op: 'create', op_id: 'y', key: 'NEW', name: 'New' }],
        })
      ).status,
    ).not.toBe(403)
  })

  it('purges every row and file of that workspace, and nothing of another', async () => {
    await populate(a, 'AA')
    await populate(b, 'BB')
    for (const [table, select] of PURGE_ORDER)
      expect({ table, n: await countFor(select, b.workspaceId) }).not.toEqual({
        table,
        n: 0,
      })
    const before = new Map<string, number>()
    for (const [table, select] of PURGE_ORDER)
      before.set(table, await countFor(select, a.workspaceId))
    const blobsBefore = blobs.size

    // A small budget, so the purge has to resume across ticks.
    let done = false
    let ticks = 0
    for (; ticks < 50 && !done; ticks++)
      done = await purgeWorkspace(db, store, b.workspaceId, { left: 60 })
    expect(done).toBe(true)
    expect(ticks).toBeGreaterThan(1)

    for (const [table, select] of PURGE_ORDER) {
      expect({ table, n: await countFor(select, b.workspaceId) }).toEqual({
        table,
        n: 0,
      })
      expect({ table, n: await countFor(select, a.workspaceId) }).toEqual({
        table,
        n: before.get(table) ?? -1,
      })
    }
    expect(
      (await db.query('SELECT 1 FROM workspace WHERE id = ?', [b.workspaceId]))
        .length,
    ).toBe(0)
    expect(blobs.size).toBe(blobsBefore - 1)
    const fts = await db.query<{ ref: string }>(
      "SELECT ref FROM fts WHERE kind = 'item'",
    )
    expect(fts.some((r) => r.ref.startsWith('BB-'))).toBe(false)
    expect(fts.some((r) => r.ref.startsWith('AA-'))).toBe(true)
  })
})

describe('erasing a person', () => {
  it('anonymises them in every workspace, revokes their access, and keeps their work', async () => {
    await populate(b, 'BB')
    const token = await createToken(db, b.workspaceId, b.actor.id, 'session', [
      'read',
    ])
    await db.run(
      "UPDATE actor SET platform_user_id = 'usr_shared' WHERE id = ?",
      [a.actor.id],
    )
    expect(await anonymiseAccount(db, 'usr_shared')).toBe(2)
    const people = await db.query<{
      name: string
      email: string | null
      disabled: number
      platform_user_id: string | null
    }>(
      'SELECT name, email, disabled, platform_user_id FROM actor WHERE id IN (?, ?)',
      [a.actor.id, b.actor.id],
    )
    for (const p of people)
      expect(p).toEqual({
        name: 'Deleted user',
        email: null,
        disabled: 1,
        platform_user_id: null,
      })
    const live = await db.query(
      'SELECT 1 FROM auth_token WHERE token_hash = ? AND revoked_at IS NULL',
      [await sha256Hex(token)],
    )
    expect(live.length).toBe(0)
    expect(
      (await db.query('SELECT 1 FROM comment WHERE actor_id = ?', [b.actor.id]))
        .length,
    ).toBe(1)
  })

  it('happens when the provider sends user.deleted', async () => {
    const secret = 'whsec_test_only'
    const app = await createApp(db, {
      blobStore: memoryBlobs(),
      platformWebhookSecret: secret,
    })
    const body = JSON.stringify({
      event: 'user.deleted',
      timestamp: new Date().toISOString(),
      data: { user_id: 'usr_shared' },
    })
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    )
    const mac = Array.from(
      new Uint8Array(
        await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)),
      ),
    )
      .map((x) => x.toString(16).padStart(2, '0'))
      .join('')
    const res = await app.request('/api/v1/platform/webhook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-nubisco-signature': `sha256=${mac}`,
      },
      body,
    })
    expect(await res.json()).toEqual({ ok: true, handled: true, anonymised: 1 })
    expect(
      (
        await db.query<{ name: string }>(
          'SELECT name FROM actor WHERE id = ?',
          [b.actor.id],
        )
      )[0].name,
    ).toBe('Deleted user')
  })
})
