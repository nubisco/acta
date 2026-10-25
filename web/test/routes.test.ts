/**
 * The routes (2026-10-24). A space gained a Settings page of its own, and
 * none of the addresses that existed before it may stop landing: the board
 * under `/s/` and the older `/b/`, its views in `?view=`, a card in `?item=`,
 * and the old personal tabs of workspace Settings.
 */
import { describe, expect, it } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import { routes } from '@/routes'

async function land(path: string) {
  const router = createRouter({ history: createMemoryHistory(), routes })
  await router.push(path)
  const { name, params, query } = router.currentRoute.value
  return { name, params, query }
}

describe('the routes', () => {
  it('gives a space its Settings page', async () => {
    const to = await land('/acme/s/ST/settings')
    expect(to.name).toBe('space-settings')
    expect(to.params).toEqual({ workspace: 'acme', spaceKey: 'ST' })
  })

  it('sends the old /b/ address of a space settings page on', async () => {
    const to = await land('/acme/b/ST/settings')
    expect(to.name).toBe('space-settings')
    expect(to.params.spaceKey).toBe('ST')
  })

  it('still opens the board, a view and a card at the addresses they had', async () => {
    expect((await land('/acme/s/ST')).name).toBe('space')
    const view = await land('/acme/s/ST?view=table')
    expect(view.name).toBe('space')
    expect(view.query).toEqual({ view: 'table' })
    const card = await land('/acme/b/ST?item=ST-5')
    expect(card.name).toBe('space')
    expect(card.params.spaceKey).toBe('ST')
    expect(card.query).toEqual({ item: 'ST-5' })
  })

  it('keeps the workspace settings, and sends a personal tab to Your settings', async () => {
    expect((await land('/acme/settings?tab=labels')).name).toBe('settings')
    const moved = await land('/acme/settings?tab=notifications')
    expect(moved.name).toBe('personal-settings')
    expect(moved.query.tab).toBe('notifications')
  })

  // Labels and automation for one space moved to its Settings (2026-10-24).
  // The workspace tabs stay, with what every space shares and a pointer to
  // the rest, so an old link still lands on a page that says where to go.
  it('keeps the old Labels and Automation links, and opens a space on either tab', async () => {
    expect((await land('/acme/settings?tab=labels')).query.tab).toBe('labels')
    const automation = await land('/acme/settings?tab=automation')
    expect(automation.name).toBe('settings')
    expect(automation.query.tab).toBe('automation')
    const space = await land('/acme/s/ST/settings?tab=labels')
    expect(space.name).toBe('space-settings')
    expect(space.query.tab).toBe('labels')
    const old = await land('/acme/b/ST/settings?tab=automation')
    expect(old.name).toBe('space-settings')
    expect(old.query.tab).toBe('automation')
  })
})
