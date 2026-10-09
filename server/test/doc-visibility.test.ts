/**
 * Who sees a document.
 *
 * Set by Jose on 2026-10-09: a page is private to its owner or shared with
 * the workspace. A new page starts private and its author is asked on the
 * first save. Pages an agent writes are shared. Children follow their
 * parent. Admins do not see other people's private pages. A hidden page
 * behaves as if it did not exist, everywhere a title could leak.
 */
import { beforeEach, describe, expect, it } from 'bun:test'
import { openDb, type BunSqliteDriver } from '../src/db'
import { bootstrapWorkspace } from '../src/core/bootstrap'
import { docWrite } from '../src/services/docs'
import { spaceWrite } from '../src/services/spaces'
import { itemWrite } from '../src/services/items'
import {
  activityQuery,
  docGet,
  docTree,
  itemGet,
  search,
  workspaceOverview,
} from '../src/services/reads'
import type { ICtx } from '../src/core/ctx'

let db: BunSqliteDriver
let workspaceId: string

const person = (
  id: string,
  handle: string,
  role: 'admin' | 'member' = 'member',
): ICtx => ({
  db,
  workspaceId,
  actor: { id, kind: 'human', handle, role, scopes: ['read', 'write'] },
})

let jose: ICtx
let ivan: ICtx
let admin: ICtx

beforeEach(async () => {
  db = await openDb(':memory:')
  workspaceId = await bootstrapWorkspace(db, {
    adminEmail: 'admin@nubisco.io',
    adminHandle: 'boss',
  })
  for (const handle of ['jose', 'ivan', 'bot']) {
    await db.run(
      `INSERT INTO actor (id, workspace_id, kind, handle, name, email, role, created_at, on_behalf_of)
       VALUES (?, ?, ?, ?, ?, ?, 'member', ?, ?)`,
      [
        `act_${handle}`,
        workspaceId,
        handle === 'bot' ? 'agent' : 'human',
        handle,
        handle,
        handle === 'bot' ? null : `${handle}@nubisco.io`,
        Date.now(),
        handle === 'bot' ? 'act_jose' : null,
      ],
    )
  }
  const boss = (
    await db.query<{ id: string }>("SELECT id FROM actor WHERE handle = 'boss'")
  )[0].id
  jose = person('act_jose', 'jose')
  ivan = person('act_ivan', 'ivan')
  admin = person(boss, 'boss', 'admin')
})

function page(slug: string, extra: Record<string, unknown> = {}) {
  return {
    op: 'create' as const,
    op_id: `c-${slug}`,
    slug,
    title: `Title of ${slug}`,
    body: `The ${slug} page. Secret words.`,
    layout: 'default' as const,
    tags: [],
    ...extra,
  }
}

async function ok(ctx: ICtx, ops: unknown[]) {
  const results = await docWrite(ctx, ops as never)
  for (const r of results) if (!r.ok) throw new Error(JSON.stringify(r))
  return results
}

async function fails(ctx: ICtx, ops: unknown[]): Promise<string> {
  const [r] = await docWrite(ctx, ops as never)
  expect(r.ok).toBe(false)
  return (r as { error: string }).error
}

const share = (slug: string, visibility = 'workspace') => ({
  op: 'set_visibility',
  op_id: `v-${slug}-${visibility}-${Math.random()}`,
  ref: slug,
  visibility,
})

const sees = async (ctx: ICtx, slug: string) =>
  docGet(ctx, slug).then(
    () => true,
    () => false,
  )

describe('a new page', () => {
  it('starts private to its author, who is asked whether to share it', async () => {
    await ok(jose, [page('draft')])
    const mine = (await docGet(jose, 'draft')) as Record<string, unknown>
    expect(mine.visibility).toBe('private')
    expect(mine.owner).toBe('jose')
    expect(mine.ask_share).toBe(true)
    expect(mine.can_change_visibility).toBe(true)
    expect(await sees(ivan, 'draft')).toBe(false)
  })

  it('stops asking once the author has answered either way', async () => {
    await ok(jose, [page('draft'), share('draft', 'private')])
    const mine = (await docGet(jose, 'draft')) as Record<string, unknown>
    expect(mine.ask_share).toBeUndefined()
    expect(mine.visibility).toBe('private')
  })

  it('is shared when an agent writes it, and belongs to its person', async () => {
    const bot: ICtx = {
      db,
      workspaceId,
      actor: {
        id: 'act_bot',
        kind: 'agent',
        handle: 'bot',
        role: 'member',
        onBehalfOf: 'act_jose',
        scopes: ['read', 'write'],
      },
    }
    await ok(bot, [page('notes')])
    const read = (await docGet(ivan, 'notes')) as Record<string, unknown>
    expect(read.visibility).toBe('workspace')
    expect(read.owner).toBe('jose')
  })

  it('is shared when written through a personal token, which is a script', async () => {
    const script: ICtx = {
      ...jose,
      actor: { ...jose.actor, tokenKind: 'personal' },
    }
    await ok(script, [page('generated')])
    expect(await sees(ivan, 'generated')).toBe(true)
  })
})

describe('a private page is invisible to everyone else', () => {
  beforeEach(async () => {
    await ok(jose, [page('draft')])
    await spaceWrite(jose, [
      { op: 'create', op_id: 's', key: 'ST', name: 'ST', template: 'kanban6' },
    ] as never)
    await itemWrite(
      jose,
      [{ op: 'create', op_id: 'i', list: 'Backlog', title: 'Card' }] as never,
      'ST',
    )
    await ok(jose, [
      {
        op: 'replace',
        op_id: 'r',
        ref: 'draft',
        if_rev: 1,
        body: 'See ST-1. Secret words.',
      },
    ])
  })

  it('to a member, an admin, the tree, the overview and search', async () => {
    for (const other of [ivan, admin]) {
      expect(await sees(other, 'draft')).toBe(false)
      expect((await docTree(other)).docs.map((d) => d.slug)).not.toContain(
        'draft',
      )
      const roots = (await workspaceOverview(other)) as {
        docs?: { slug: string }[]
      }
      expect(JSON.stringify(roots)).not.toContain('Title of draft')
      const found = await search(other, { query: 'Secret', limit: 20 })
      expect(found.results.map((r) => r.ref)).not.toContain('draft')
    }
    expect(
      (await docTree(jose)).docs.find((d) => d.slug === 'draft')?.private,
    ).toBe(true)
    const own = await search(jose, { query: 'Secret', limit: 20 })
    expect(own.results.map((r) => r.ref)).toContain('draft')
  })

  it("in the activity feed and in a card's links", async () => {
    const feed = await activityQuery(ivan, { limit: 200 })
    expect(feed.events.some((e) => e.doc_slug === 'draft')).toBe(false)
    const card = (await itemGet(ivan, {
      keys: ['ST-1'],
      include: ['links'],
    } as never)) as {
      items: { links?: { in: { src: string | null }[] } }[]
    }
    expect(card.items[0].links?.in.map((l) => l.src)).not.toContain('draft')
  })

  it('and nobody else can write to it', async () => {
    const error = await fails(ivan, [
      { op: 'comment', op_id: 'x', ref: 'draft', body: 'hi' },
    ])
    expect(error).toContain('not found')
  })

  it('until its owner shares it', async () => {
    await ok(jose, [share('draft')])
    expect(await sees(ivan, 'draft')).toBe(true)
    const read = (await docGet(ivan, 'draft')) as Record<string, unknown>
    expect(read.can_change_visibility).toBeUndefined()
  })
})

describe('only the owner changes who sees a page', () => {
  it('refuses anybody else, admins included', async () => {
    await ok(jose, [page('spec'), share('spec')])
    for (const other of [ivan, admin]) {
      const error = await fails(other, [share('spec', 'private')])
      expect(error).toContain('only the owner')
    }
  })
})

describe('children follow their parent', () => {
  it('a page made inside a private page is private, and cannot be shared alone', async () => {
    await ok(jose, [page('parent'), page('child', { parent: 'parent' })])
    const child = (await docGet(jose, 'child')) as Record<string, unknown>
    expect(child.visibility).toBe('private')
    expect(child.inside_private).toBe(true)
    expect(child.ask_share).toBeUndefined()
    const error = await fails(jose, [share('child')])
    expect(error).toContain('inside a private page')
  })

  it('sharing a parent shares the pages under it', async () => {
    await ok(jose, [
      page('parent'),
      page('child', { parent: 'parent' }),
      share('parent'),
    ])
    expect(await sees(ivan, 'child')).toBe(true)
  })

  it('refuses to make a page private while somebody else owns a page under it', async () => {
    await ok(jose, [page('parent'), share('parent')])
    await ok(ivan, [page('theirs', { parent: 'parent' }), share('theirs')])
    const error = await fails(jose, [share('parent', 'private')])
    expect(error).toContain('other people own')
    expect(await sees(ivan, 'theirs')).toBe(true)
  })

  it("refuses to move somebody else's page into a private one", async () => {
    await ok(jose, [page('mine')])
    await ok(ivan, [page('theirs'), share('theirs')])
    await ok(jose, [page('shared'), share('shared')])
    // Ivan cannot even see jose's private page to move into it.
    expect(
      await fails(ivan, [
        { op: 'move', op_id: 'm1', ref: 'theirs', parent: 'mine' },
      ]),
    ).toContain('not found')
    // And jose cannot pull ivan's page into it either.
    expect(
      await fails(jose, [
        { op: 'move', op_id: 'm2', ref: 'theirs', parent: 'mine' },
      ]),
    ).toContain('belong to someone else')
  })
})
