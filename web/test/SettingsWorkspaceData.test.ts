/**
 * Exporting and deleting the workspace (LA-401), as an admin sees it.
 *
 * Pinned because both fail quietly: a ready export with no Download button
 * looks like an export that never finished, and a scheduled deletion the page
 * does not show is a workspace that disappears in thirty days without anyone
 * on it knowing why.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

const exports = vi.fn()
const requestExport = vi.fn()
const deletion = vi.fn()
const scheduleDeletion = vi.fn()
const cancelDeletion = vi.fn()
const overview = vi.fn()
const me = vi.fn()

vi.mock('@/api/client', () => ({
  api: {
    exports,
    requestExport,
    deletion,
    scheduleDeletion,
    cancelDeletion,
    overview,
    exportDownloadUrl: (id: string) =>
      `/api/v1/w/beta/workspace/exports/${id}/download`,
  },
  auth: { me },
  getWorkspaceSlug: () => 'beta',
}))

async function mountPage() {
  vi.resetModules()
  const Page = (await import('@/components/settings/SettingsWorkspaceData.vue'))
    .default
  const wrapper = mount(Page)
  await flushPromises()
  return wrapper
}

const DAY = 24 * 60 * 60 * 1000

beforeEach(() => {
  vi.clearAllMocks()
  exports.mockResolvedValue({ exports: [] })
  deletion.mockResolvedValue({ deletion: null })
  overview.mockResolvedValue({ spaces: [], labels: [], actors: [] })
  me.mockResolvedValue({ id: 'a1', handle: 'boss', role: 'admin' })
})

describe('workspace data settings', () => {
  it('offers a download for a ready export, and none for an expired one', async () => {
    exports.mockResolvedValue({
      exports: [
        {
          id: 'exp_ready',
          status: 'ready',
          size: 2048,
          skipped_files: 0,
          error: null,
          ready_at: Date.now(),
          expires_at: Date.now() + DAY,
          created_at: Date.now(),
        },
        {
          id: 'exp_old',
          status: 'ready',
          size: 2048,
          skipped_files: 0,
          error: null,
          ready_at: Date.now() - 9 * DAY,
          expires_at: Date.now() - 2 * DAY,
          created_at: Date.now() - 9 * DAY,
        },
      ],
    })
    const wrapper = await mountPage()
    const links = wrapper
      .findAll('a')
      .map((a) => a.attributes('href'))
      .filter(Boolean)
    expect(links).toEqual([
      '/api/v1/w/beta/workspace/exports/exp_ready/download',
    ])
    expect(wrapper.text()).toContain('Expired')
  })

  it('does not start a second export while one is being made', async () => {
    exports.mockResolvedValue({
      exports: [
        {
          id: 'exp_1',
          status: 'running',
          size: null,
          skipped_files: 0,
          error: null,
          ready_at: null,
          expires_at: null,
          created_at: Date.now(),
        },
      ],
    })
    const wrapper = await mountPage()
    const button = wrapper
      .findAll('button')
      .find((b) => b.text().includes('Export in progress'))
    expect(button?.attributes('disabled')).toBeDefined()
    wrapper.unmount()
  })

  it('shows a scheduled deletion with its date, and cancels it', async () => {
    const purgeAt = Date.UTC(2026, 10, 23, 12)
    deletion.mockResolvedValue({
      deletion: { deleted_at: Date.now(), purge_at: purgeAt, deleted_by: 'a1' },
    })
    cancelDeletion.mockResolvedValue({ deletion: null })
    const wrapper = await mountPage()
    expect(wrapper.text()).toContain('will be deleted on')
    expect(wrapper.text()).toContain('2026')
    const cancel = wrapper
      .findAll('button')
      .find((b) => b.text().includes('Cancel deletion'))
    await cancel?.trigger('click')
    await flushPromises()
    expect(cancelDeletion).toHaveBeenCalledTimes(1)
    expect(wrapper.text()).toContain('Delete workspace')
  })
})
