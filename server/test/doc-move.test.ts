/**
 * Moving documents around the tree.
 *
 * The tree is a parent pointer per document, so a move changes `parent_id` and
 * `pos` and nothing else. Two properties matter more than the rest:
 *
 *  - A document can never end up under itself. A cycle detaches the whole
 *    subtree from the root, so it silently vanishes from the tree, and any code
 *    walking parents could go round forever.
 *  - A move never touches a slug. URLs, `[[doc:...]]` references, heading
 *    links and block links all point at the slug, so they survive a move even
 *    when the slug no longer describes where the page lives.
 */
import { beforeEach, describe, expect, it } from 'bun:test'
import type { Hono } from 'hono'
import { newId } from '@nubisco/acta-shared'
import { createApp } from '../src/app'
import { createToken } from '../src/core/auth'
import { openDb, type BunSqliteDriver } from '../src/db'

let db: BunSqliteDriver
let app: Hono<never>
let writer: string
let reader: string
let opCounter = 0

const as = (token: string) => ({ authorization: `Bearer ${token}` })

interface IResult {
  ok: boolean
  error?: string
  slug?: string
}

async function write(ops: unknown[], token = writer): Promise<Response> {
  return app.request('/api/v1/docs/write', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...as(token) },
    body: JSON.stringify({ ops }),
  })
}

async function move(fields: Record<string, unknown>): Promise<IResult> {
  const res = await write([{ op: 'move', op_id: `m${++opCounter}`, ...fields }])
  expect(res.status).toBe(200)
  return ((await res.json()) as { results: IResult[] }).results[0]
}

async function create(slug: string, title: string, parent?: string) {
  const res = await write([
    {
      op: 'create',
      op_id: `c-${slug}`,
      slug,
      title,
      parent,
      body: `# ${title}\n\nSee [[doc:${slug}]].\n`,
    },
  ])
  const { results } = (await res.json()) as { results: IResult[] }
  expect(results[0].ok).toBe(true)
}

/** The tree as `depth:slug` lines, in the order a reader sees it. */
async function outline(): Promise<string[]> {
  const res = await app.request('/api/v1/docs', { headers: as(writer) })
  const { docs } = (await res.json()) as {
    docs: { slug: string; depth: number }[]
  }
  return docs.map((d) => `${d.depth}:${d.slug}`)
}

async function slugs(): Promise<string[]> {
  return (
    await db.query<{ slug: string }>('SELECT slug FROM document ORDER BY slug')
  ).map((r) => r.slug)
}

beforeEach(async () => {
  opCounter = 0
  db = await openDb(':memory:')
  app = (await createApp(db, {
    bootstrap: { adminEmail: 'jose@nubisco.io', adminHandle: 'jose' },
    dataDir: `/tmp/acta-move-${Math.random().toString(36).slice(2)}`,
  })) as never
  const ws = (await db.query<{ id: string }>('SELECT id FROM workspace'))[0].id
  const jose = (
    await db.query<{ id: string }>("SELECT id FROM actor WHERE handle = 'jose'")
  )[0].id
  writer = await createToken(db, ws, jose, 'session', ['read', 'write'])
  const readerId = newId('act')
  await db.run(
    `INSERT INTO actor (id, workspace_id, kind, handle, name, role, created_at)
     VALUES (?, ?, 'agent', 'reader', 'Reader', 'member', ?)`,
    [readerId, ws, Date.now()],
  )
  reader = await createToken(db, ws, readerId, 'agent', ['read'])

  // Nubisco Home > The Nubisco Manual > Icon System, plus siblings.
  await create('home', 'Nubisco Home')
  await create('home/manual', 'The Nubisco Manual', 'home')
  await create('home/manual/icons', 'Icon System', 'home/manual')
  await create('home/manual/colour', 'Colour', 'home/manual')
  await create('home/roadmap', 'Roadmap', 'home')
  await create('runbook', 'Runbook')
  await create('changelog', 'Changelog')
})

describe('moving a document under itself', () => {
  it('refuses its own child as the new parent, and changes nothing', async () => {
    const before = await outline()
    const result = await move({ ref: 'home', parent: 'home/manual' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('own subpages')
    expect(await outline()).toEqual(before)
  })

  it('refuses a grandchild as the new parent', async () => {
    const before = await outline()
    const result = await move({ ref: 'home', parent: 'home/manual/icons' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('own subpages')
    expect(await outline()).toEqual(before)
  })

  it('still refuses the document itself as the new parent', async () => {
    const result = await move({ ref: 'home/manual', parent: 'home/manual' })
    expect(result.ok).toBe(false)
  })

  it('allows a move to an unrelated branch', async () => {
    const result = await move({ ref: 'home/manual/icons', parent: 'runbook' })
    expect(result.ok).toBe(true)
  })

  it('terminates on data that already holds a cycle', async () => {
    // Written straight to the table, the way the old move could leave it.
    const id = async (slug: string) =>
      (
        await db.query<{ id: string }>(
          'SELECT id FROM document WHERE slug = ?',
          [slug],
        )
      )[0].id
    await db.run('UPDATE document SET parent_id = ? WHERE slug = ?', [
      await id('home/manual/icons'),
      'home',
    ])
    // Moving into that loop must be refused, not hang.
    const result = await move({ ref: 'runbook', parent: 'home' })
    expect(result.ok).toBe(true)
    const refused = await move({ ref: 'home/manual', parent: 'home' })
    expect(refused.ok).toBe(false)
    // And reading a subtree rooted inside it still returns, once per page.
    const res = await app.request('/api/v1/docs?root=home&depth=1000', {
      headers: as(writer),
    })
    expect(res.status).toBe(200)
    const { docs } = (await res.json()) as { docs: { slug: string }[] }
    const seen = docs.map((d) => d.slug)
    expect(new Set(seen).size).toBe(seen.length)
    expect(await slugs()).toContain('home')
  })
})

describe('where a moved document lands', () => {
  it('moves into another document as its last child', async () => {
    expect((await move({ ref: 'runbook', parent: 'home/manual' })).ok).toBe(
      true,
    )
    expect(await outline()).toEqual([
      '0:home',
      '1:home/manual',
      '2:home/manual/icons',
      '2:home/manual/colour',
      '2:runbook',
      '1:home/roadmap',
      '0:changelog',
    ])
  })

  it('moves to the top level with parent null, and before or after a root', async () => {
    expect((await move({ ref: 'home/roadmap', parent: null })).ok).toBe(true)
    expect((await outline()).slice(-2)).toEqual([
      '0:changelog',
      '0:home/roadmap',
    ])

    expect((await move({ ref: 'home/manual/icons', before: 'home' })).ok).toBe(
      true,
    )
    expect(
      (await move({ ref: 'home/manual/colour', after: 'runbook' })).ok,
    ).toBe(true)
    expect(await outline()).toEqual([
      '0:home/manual/icons',
      '0:home',
      '1:home/manual',
      '0:runbook',
      '0:home/manual/colour',
      '0:changelog',
      '0:home/roadmap',
    ])
  })

  it('places before and after a sibling under a parent', async () => {
    await move({ ref: 'runbook', before: 'home/manual/colour' })
    await move({ ref: 'changelog', after: 'home/manual/icons' })
    expect(await outline()).toEqual([
      '0:home',
      '1:home/manual',
      '2:home/manual/icons',
      '2:changelog',
      '2:runbook',
      '2:home/manual/colour',
      '1:home/roadmap',
    ])
  })

  it('keeps siblings in order through many moves into the same gap', async () => {
    // Every move lands directly after `home`, halving the same gap each time,
    // until there is no room left and the siblings are renumbered.
    const pages = ['a', 'b', 'c']
    for (const slug of pages) await create(slug, slug.toUpperCase())
    const expected = ['home', 'runbook', 'changelog', 'a', 'b', 'c']
    for (let i = 0; i < 90; i++) {
      const slug = pages[i % pages.length]
      expect((await move({ ref: slug, after: 'home' })).ok).toBe(true)
      expected.splice(expected.indexOf(slug), 1)
      expected.splice(expected.indexOf('home') + 1, 0, slug)
      const roots = (await outline())
        .filter((line) => line.startsWith('0:'))
        .map((line) => line.slice(2))
      expect(roots).toEqual(expected)
    }
    const positions = (
      await db.query<{ pos: number }>(
        'SELECT pos FROM document WHERE parent_id IS NULL',
      )
    ).map((r) => r.pos)
    expect(new Set(positions).size).toBe(positions.length)
  })

  it('moves a whole group, three levels deep, with its node', async () => {
    await move({ ref: 'home/manual', parent: 'runbook' })
    expect(await outline()).toEqual([
      '0:home',
      '1:home/roadmap',
      '0:runbook',
      '1:home/manual',
      '2:home/manual/icons',
      '2:home/manual/colour',
      '0:changelog',
    ])
    await move({ ref: 'home', after: 'changelog' })
    await move({ ref: 'runbook', parent: 'home/roadmap' })
    expect(await outline()).toEqual([
      '0:changelog',
      '0:home',
      '1:home/roadmap',
      '2:runbook',
      '3:home/manual',
      '4:home/manual/icons',
      '4:home/manual/colour',
    ])
  })

  it('never changes a slug, and references still resolve', async () => {
    const before = await slugs()
    await move({ ref: 'home/manual', parent: null })
    await move({ ref: 'home/manual/icons', after: 'changelog' })
    await move({ ref: 'home', parent: 'runbook' })
    expect(await slugs()).toEqual(before)
    const res = await app.request('/api/v1/docs/home/manual/icons', {
      headers: as(writer),
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { slug: string }).slug).toBe(
      'home/manual/icons',
    )
  })

  it('refuses placing next to a page inside its own subtree', async () => {
    const before = await outline()
    const result = await move({ ref: 'home', after: 'home/manual/icons' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('own subpages')
    expect(await outline()).toEqual(before)
  })

  it('refuses conflicting placements', async () => {
    expect(
      (await move({ ref: 'runbook', before: 'home', after: 'changelog' })).ok,
    ).toBe(false)
    expect(
      (await move({ ref: 'runbook', parent: 'home', before: 'changelog' })).ok,
    ).toBe(false)
    expect((await move({ ref: 'runbook', before: 'runbook' })).ok).toBe(false)
  })

  it('replays an op_id instead of moving twice', async () => {
    const op = { op: 'move', op_id: 'same', ref: 'runbook', parent: 'home' }
    await write([op])
    await move({ ref: 'runbook', parent: null })
    const res = await write([op])
    expect(res.status).toBe(200)
    expect(await outline()).toContain('0:runbook')
  })
})

describe('who may move', () => {
  it('refuses a read-only caller and leaves the tree as it was', async () => {
    const before = await outline()
    const res = await write(
      [{ op: 'move', op_id: 'r1', ref: 'runbook', parent: 'home' }],
      reader,
    )
    expect(res.status).toBe(403)
    expect(await outline()).toEqual(before)
  })
})
