import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { normalizePage, type IConfluencePage } from '../src/confluence/model'
import { planConfluenceImport } from '../src/confluence/plan'

function fixturePages(): IConfluencePage[] {
  const raw = JSON.parse(
    readFileSync(
      join(import.meta.dir, 'fixtures', 'confluence-pages.json'),
      'utf8',
    ),
  ) as unknown[]
  return raw.map(normalizePage)
}

function page(
  id: string,
  title: string,
  body: string,
  parentId: string | null = null,
  spaceKey = 'NUB',
): IConfluencePage {
  return {
    id,
    title,
    storage: body,
    parentId,
    spaceKey,
    wide: false,
    versionCount: 1,
    updatedAt: null,
    authorName: null,
    createdAt: null,
  }
}

describe('normalizePage', () => {
  it('accepts the REST shape with ancestors, version and metadata', () => {
    const pages = fixturePages()
    const home = pages.find((p) => p.id === '100')!
    expect(home.parentId).toBeNull()
    expect(home.versionCount).toBe(3)
    expect(home.authorName).toBe('José Silva')
    expect(home.createdAt).toBe('2026-07-25T08:00:00.000Z')
    const stagewright = pages.find((p) => p.id === '102')!
    expect(stagewright.parentId).toBe('101') // last ancestor
    expect(stagewright.wide).toBe(true)
  })

  it('accepts a simplified flat shape', () => {
    const p = normalizePage({
      id: 7,
      title: 'T',
      body: '<p>x</p>',
      parentId: 3,
      space: 'NUB',
      layout: 'wide',
      version: 4,
    })
    expect(p.id).toBe('7')
    expect(p.parentId).toBe('3')
    expect(p.storage).toBe('<p>x</p>')
    expect(p.wide).toBe(true)
    expect(p.versionCount).toBe(4)
  })
})

describe('planConfluenceImport', () => {
  it('orders parents before children with slugified title paths', () => {
    const plan = planConfluenceImport(fixturePages())
    expect(plan.pages.map((p) => p.slug)).toEqual([
      'nubisco-home',
      'nubisco-home/the-nubisco-manual',
      'nubisco-home/the-nubisco-manual/stagewright',
    ])
    expect(plan.pages[1].parentSlug).toBe('nubisco-home')
    expect(plan.pages.map((p) => p.depth)).toEqual([0, 1, 2])
  })

  it('collapses a single root page onto --root and stubs intermediate segments', () => {
    const plan = planConfluenceImport(fixturePages(), {
      root: 'archive/analytics',
    })
    expect(plan.stubOps).toHaveLength(1)
    expect(plan.stubOps[0].op === 'create' && plan.stubOps[0].slug).toBe(
      'archive',
    )
    expect(plan.pages[0].slug).toBe('archive/analytics')
    expect(plan.pages[0].parentSlug).toBe('archive')
    expect(plan.pages[1].slug).toBe('archive/analytics/the-nubisco-manual')
  })

  it('prefixes multiple roots under --root with a stub', () => {
    const plan = planConfluenceImport(
      [page('1', 'Alpha', '<p>a</p>'), page('2', 'Beta', '<p>b</p>')],
      { root: 'manual' },
    )
    expect(
      plan.stubOps.map((op) => (op.op === 'create' ? op.slug : '')),
    ).toEqual(['manual'])
    expect(plan.pages.map((p) => p.slug)).toEqual([
      'manual/alpha',
      'manual/beta',
    ])
  })

  it('skips personal spaces by default and reports them', () => {
    const plan = planConfluenceImport(fixturePages())
    expect(plan.pages.some((p) => p.pageId === '900')).toBe(false)
    expect(plan.skips).toHaveLength(1)
    expect(plan.skips[0].reason).toContain('personal space ~jose')
    const withPersonal = planConfluenceImport(fixturePages(), {
      includePersonal: true,
    })
    expect(withPersonal.pages.some((p) => p.pageId === '900')).toBe(true)
  })

  it('resolves [[doc:...]] links across the page set and carries wide layout', () => {
    const plan = planConfluenceImport(fixturePages(), { root: 'manual' })
    const home = plan.pages.find((p) => p.pageId === '100')!
    expect(home.op.op === 'create' && home.op.body).toContain(
      '[[doc:manual/the-nubisco-manual]]',
    )
    const stagewright = plan.pages.find((p) => p.pageId === '102')!
    expect(stagewright.op.op === 'create' && stagewright.op.layout).toBe('wide')
    expect(stagewright.op.op === 'create' && stagewright.op.body).toContain(
      '[[board:SW]]',
    )
    expect(stagewright.issues.unknownMacros).toEqual(['toc'])
  })

  it('dedupes duplicate sibling slugs and notes duplicate titles', () => {
    const plan = planConfluenceImport([
      page('1', 'Same Name', '<p>a</p>'),
      page('2', 'Same Name', '<p>b</p>'),
    ])
    expect(plan.pages.map((p) => p.slug)).toEqual(['same-name', 'same-name-2'])
    expect(plan.notes.join(' ')).toContain('duplicate')
  })

  it('rejects an invalid --root', () => {
    expect(() =>
      planConfluenceImport(fixturePages(), { root: 'Not A Slug' }),
    ).toThrow()
  })
})
